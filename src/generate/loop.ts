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
}

/* What goes back to the model on a repair. Deliberately the `detail` strings
   the validator already writes, because those name cells and conflicting
   letters, which is the difference between a model that fixes the problem and
   one that produces a different problem.

   Capped, because a wholly broken proposal can produce dozens and a prompt
   listing all of them is worse than one listing the first few: the model starts
   rewriting rather than repairing. */
const MAX_PROBLEMS = 8;

export function problemsFrom(rejections: Rejection[]): string[] {
  return rejections.slice(0, MAX_PROBLEMS).map((r) => r.detail);
}

export async function generate(
  provider: Provider,
  theme: string,
  options: Options = {},
): Promise<Outcome> {
  const rows = options.rows ?? DEFAULT_LIMITS.maxRows;
  const cols = options.cols ?? DEFAULT_LIMITS.maxCols;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const maxRepairs = options.maxRepairs ?? 2;
  const report = options.onProgress ?? (() => {});
  const trace = options.onTrace ?? (() => {});
  /* Truncated, because a prompt is about 2 KB and a reply can be far larger,
     and this is stored and sent to every client on the socket. Enough to see
     what was asked and what came back. */
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
    });
  };

  let proposal: LayoutProposal | null = null;
  let lastProblems: string[] = [];
  /* Counted so the terminal state can tell "the model said nothing usable"
     from "the model could not be reached at all". They look identical from
     here and mean opposite things to whoever reads the message: one is a
     theme worth changing, the other is an outage worth reporting. */
  let attempts = 0;
  let threw = 0;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    report({ step: attempt === 0 ? "words" : "clues", attempt });
    try {
      proposal = proposal
        ? await provider.repair(proposal, lastProblems)
        : await provider.proposeLayout(theme, rows, cols);
      attempts += 1;
      exchange(attempt === 0 ? "layout" : "repair");
    } catch {
      /* A provider that throws is a failed attempt, not a failed generation.
         The next iteration asks again, and running out of iterations is what
         produces a terminal state, so one flaky call cannot end a request that
         a retry would have satisfied. */
      attempts += 1;
      threw += 1;
      record({
        at: Date.now(),
        step: attempt === 0 ? "layout" : "repair",
        detail: "the call to the model failed",
      });
      proposal = null;
      lastProblems = [];
      continue;
    }

    report({ step: "validating", attempt });
    const entries = proposal.entries ?? [];
    if (!entries.length) {
      /* Ask again rather than asking for a repair. `repair` sends the previous
         proposal back for correction, and correcting nothing is a wasted call
         that returns nothing to correct next time either: two of the three
         attempts were being spent that way whenever the first answer failed to
         parse, which was often. Clearing it makes the next iteration propose
         from scratch. */
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
           the layout path gets numbers at all. Without it every entry keeps the
           zero `readEntries` stamps. */
        entries: numberEntries(entries),
      };
    }
    lastProblems = problemsFrom(result.rejections);
  }

  /* Step 4. The model could not lay out a puzzle, so ask it for words only and
     hand those outward to be packed. A separate call rather than reusing the
     failed layout's words: a layout that never validated is not evidence its
     word list was good, and `propose` is the call whose output `clean` is built
     to filter. */
  report({ step: "packing", attempt: maxRepairs + 1 });
  record({
    at: Date.now(),
    step: "words",
    detail: "the layout could not be repaired, asking for a word list to pack",
  });
  let candidates: Candidate[] = [];
  attempts += 1;
  try {
    candidates = (await provider.propose(theme, limits.maxEntries)).candidates;
    exchange("words", `${candidates.length} usable words after cleaning`);
  } catch {
    threw += 1;
    candidates = [];
  }

  if (candidates.length >= 2) {
    return { status: "pack", candidates, rows, cols };
  }

  /* Two words cannot cross each other into a puzzle, and one certainly cannot.
     Failing here rather than handing an unpackable list outward keeps the
     terminal state on this side, where the reason is known. */
  /* Every single call failing is not a theme problem, and saying it was sent
     the first real user of this feature away believing they had picked a bad
     word when the model id was wrong. A message that blames the wrong party is
     worse than a vague one. */
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
