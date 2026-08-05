/* Propose, validate, repair, give up. B3, the pipeline in ADR "The model
   proposes the layout, a validator decides".

   1. The model proposes a complete layout against a strict schema.
   2. The validator checks it.
   3. On failure the **specific** violations go back for repair, naming cells and
      the letters in conflict. Two or three attempts.
   4. If repair fails, a deterministic packer places the model's word list
      instead, so the button always works.
   5. Nothing invalid reaches storage.

   Step 4 is not here, and that split is deliberate rather than an omission.
   Packing runs in the browser because Workers Free allows 10 ms of CPU per
   request and a backtracking packer does not fit, so this function's job ends
   at "the model could not do it, here are words worth packing". The caller
   hands those to a client and validates what comes back.

   Everything here is pure given a provider. No timers, no storage, no
   transport: the same reason pending.ts is pure, which is that this is where a
   mistake is expensive and invisible. */

import type { Entry } from "../types.ts";
import type { Candidate, LayoutProposal, Provider } from "./provider.ts";
import type { TraceStep } from "../types.ts";
import {
  cellsFrom,
  DEFAULT_LIMITS,
  numberEntries,
  validate,
  type Limits,
  type Rejection,
} from "./validate.ts";

/* Section 7 names four steps a client can render while it waits. Generation
   takes 10 to 30 seconds, which needs labeled progress rather than a spinner. */
export type Step = "words" | "packing" | "clues" | "validating";

export interface Progress {
  step: Step;
  attempt: number;
}

export type Outcome =
  /* The model produced a valid puzzle, with or without repairs. */
  | { status: "playable"; rows: number; cols: number; entries: Entry[] }
  /* The model could not, but gave usable words. The caller packs these in a
     browser and validates the result: this is step 4, handed outward. */
  | { status: "pack"; candidates: Candidate[]; rows: number; cols: number }
  /* Nothing usable, after every attempt. Terminal, and a user-facing state
     rather than an error page, per rule 4 of the Done gate. */
  | { status: "failed"; reason: string };

export interface Options {
  rows?: number;
  cols?: number;
  /* "Two or three attempts" in the ADR. Three total tries at a layout: one
     proposal and two repairs. */
  maxRepairs?: number;
  limits?: Limits;
  onProgress?: (progress: Progress) => void;
  /* Called after every exchange and every decision, so the caller can show the
     work rather than only the verdict. Separate from `onProgress` because
     progress is four words for a spinner and this is the transcript. */
  onTrace?: (step: TraceStep) => void;
  /* Ask the model for a whole layout before asking for words. Default false
     since 2026-08-04: see the note above `generate`. Kept configurable so the
     comparison stays available rather than becoming an opinion. */
  layoutFirst?: boolean;
}

/* What goes back to the model on a repair. Deliberately the `detail` strings
   the validator already writes, because those name cells and conflicting
   letters, which is the difference between a model that fixes the problem and
   one that produces a different problem.

   Capped, because a wholly broken proposal can produce dozens and a prompt
   listing all of them is worse than one listing the first few: the model starts
   rewriting rather than repairing. */
const MAX_PROBLEMS = 8;

/* What the trace says when a call throws.

   It said "the call to the model failed" and nothing else, which is exactly as
   useful as it sounds: generation broke in production on 2026-08-05 and the
   transcript, the one thing built so a person can see why, said only that
   something had failed four times. Diagnosing it needed `wrangler tail` and a
   volunteer clicking the button, which is the situation the trace exists to
   prevent.

   The message is bounded and prefixed rather than dumped: it is vendor text
   shown to a visitor, so it must be short and must not pretend to be our
   words. It cannot leak puzzle content, because it is an error from the model
   host rather than a reply. */
const MAX_REASON = 200;

function whyItFailed(err: unknown): string {
  const message = (err instanceof Error ? err.message : String(err)).trim();
  if (!message) return "the call to the model failed";
  return `the call to the model failed: ${message.slice(0, MAX_REASON)}`;
}

export function problemsFrom(rejections: Rejection[]): string[] {
  return rejections.slice(0, MAX_PROBLEMS).map((r) => r.detail);
}

/* Words first, layout second.

   **Inverted 2026-08-04, from a full transcript of a real failure.** The
   pipeline used to ask for a whole layout, repair it twice, and only then ask
   for a word list. Watching it, an 8B model produced eight entries with a
   crossing that disagreed and a six-letter down answer running four rows off
   the grid, then spent two repairs moving that answer from row 9 to row 8 to
   column 5 without once fixing the crossing or computing that it had to start
   at row 5 or less. Three calls, thirty seconds, no progress, every time.

   The layout ADR calls the layout "the interesting part" and it is right that
   it is the more ambitious claim. It also says, in advance, that a failing
   layout means lowering density or changing model before concluding the model
   cannot do it. Density was lowered to 5 to 8 answers and the model was
   changed and changed back; it still cannot do it.

   So the order now matches what each side is good at. A language model is very
   good at listing words about a subject and writing clues for them. It is bad
   at constraint satisfaction on a coordinate grid. A backtracking packer is the
   opposite. Asking each for the thing it is good at costs **one** model call
   instead of four, takes about seven seconds instead of thirty, and produces a
   puzzle rather than an apology.

   The layout path is kept, not deleted, and runs when the word list comes back
   too thin to pack. It is also still reachable first by configuration, so the
   comparison stays available rather than becoming an opinion. */
export async function generate(
  provider: Provider,
  theme: string,
  options: Options = {},
): Promise<Outcome> {
  const rows = options.rows ?? DEFAULT_LIMITS.maxRows;
  const cols = options.cols ?? DEFAULT_LIMITS.maxCols;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const maxRepairs = options.maxRepairs ?? 2;
  const layoutFirst = options.layoutFirst ?? false;
  const report = options.onProgress ?? (() => {});
  const trace = options.onTrace ?? (() => {});
  /* Truncated, because a prompt is about 2 KB and a reply can be far larger,
     and this is stored and sent to every client on the socket. */
  const CUT = 4000;
  const record = (step: TraceStep) => trace(step);
  const exchange = (step: TraceStep["step"], detail?: string) => {
    const last = provider.lastExchange?.();
    record({
      at: Date.now(),
      step,
      detail,
      prompt: last?.prompt?.slice(0, CUT),
      reply: last?.reply?.slice(0, CUT),
      parsed: last?.parsed,
      ms: last?.ms,
      mode: last?.mode,
    });
  };

  let attempts = 0;
  let threw = 0;
  let lastProblems: string[] = [];

  /* One call, and the thing the model is actually good at. */
  const askForWords = async (): Promise<Candidate[]> => {
    report({ step: "words", attempt: 0 });
    attempts += 1;
    try {
      const got = (await provider.propose(theme, limits.maxEntries)).candidates;
      exchange("words", `${got.length} usable words after cleaning`);
      return got;
    } catch (err) {
      threw += 1;
      record({
        at: Date.now(),
        step: "words",
        detail: whyItFailed(err),
      });
      return [];
    }
  };

  /* Up to three tries at a whole layout, each repair told exactly what was
     wrong. Kept because the ADR is right that it is the more interesting
     claim, and because a model that can do it produces a better grid than the
     packer will. */
  const tryLayout = async (): Promise<Outcome | null> => {
    let proposal: LayoutProposal | null = null;

    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      report({ step: attempt === 0 ? "words" : "clues", attempt });
      try {
        proposal = proposal
          ? await provider.repair(proposal, lastProblems)
          : await provider.proposeLayout(theme, rows, cols);
        attempts += 1;
        exchange(attempt === 0 ? "layout" : "repair");
      } catch (err) {
        /* A provider that throws is a failed attempt, not a failed generation.
           Only running out of attempts is terminal, so one flaky call cannot
           end a request a retry would have satisfied. */
        attempts += 1;
        threw += 1;
        record({
          at: Date.now(),
          step: attempt === 0 ? "layout" : "repair",
          detail: whyItFailed(err),
        });
        proposal = null;
        lastProblems = [];
        continue;
      }

      report({ step: "validating", attempt });
      const entries = proposal.entries ?? [];
      if (!entries.length) {
        /* Ask again rather than for a repair. Correcting nothing returns
           nothing to correct, and two of three attempts were going that way. */
        proposal = null;
        lastProblems = ["the model returned no usable entries"];
        record({
          at: Date.now(),
          step: "validate",
          detail: "no entries could be read from the reply",
          problems: lastProblems,
        });
        continue;
      }

      /* The grid is derived from the entries rather than proposed, so a model
         cannot contradict its own placements. See cellsFrom. */
      const cells = cellsFrom(
        entries,
        proposal.rows || rows,
        proposal.cols || cols,
      );
      const result = validate(cells, entries, limits);
      record({
        at: Date.now(),
        step: "validate",
        detail: result.ok
          ? `${entries.length} entries, all crossings agree`
          : `${entries.length} entries, ${result.rejections.length} problems`,
        problems: result.ok ? undefined : problemsFrom(result.rejections),
      });
      if (result.ok) {
        return {
          status: "playable",
          rows: proposal.rows || rows,
          cols: proposal.cols || cols,
          /* Numbered here rather than by the model, and this is the only place
             the layout path gets numbers at all. */
          entries: numberEntries(entries),
        };
      }
      lastProblems = problemsFrom(result.rejections);
    }
    return null;
  };

  /* Two words cannot cross into a puzzle and the packer wants four, so this is
     the line below which asking is pointless. */
  const ENOUGH = 4;

  if (!layoutFirst) {
    const words = await askForWords();
    if (words.length >= ENOUGH) {
      report({ step: "packing", attempt: 0 });
      return { status: "pack", candidates: words, rows, cols };
    }
    record({
      at: Date.now(),
      step: "words",
      detail: `only ${words.length} usable words, trying a full layout instead`,
    });
    const laid = await tryLayout();
    if (laid) return laid;
    /* Whatever words there were, in case the packer can still do something
       with them: a smaller puzzle beats no puzzle. */
    if (words.length >= 2) {
      return { status: "pack", candidates: words, rows, cols };
    }
  } else {
    const laid = await tryLayout();
    if (laid) return laid;
    report({ step: "packing", attempt: maxRepairs + 1 });
    record({
      at: Date.now(),
      step: "words",
      detail:
        "the layout could not be repaired, asking for a word list to pack",
    });
    const words = await askForWords();
    if (words.length >= 2) {
      return { status: "pack", candidates: words, rows, cols };
    }
  }

  /* Every single call failing is not a theme problem, and saying it was sent
     the first real user of this feature away believing they had picked a bad
     word when the model id was wrong. */
  if (threw === attempts) {
    return {
      status: "failed",
      reason: "unreachable: every call to the model failed",
    };
  }

  return {
    status: "failed",
    reason: lastProblems.length
      ? `the layout never validated and the word list was unusable: ${lastProblems[0]}`
      : "the model returned nothing usable for this theme",
  };
}
