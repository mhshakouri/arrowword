/* Where words and clues come from. B3, spec section 7.

   Behind an interface for one stated reason: the acceptance suite must run
   without an API key and without spending a neuron budget, and CI must hold no
   credential at all. A recorded provider replays proposals from disk; the real
   one calls Workers AI. Both satisfy the same shape, so the generation loop
   above them never learns which it is talking to.

   The model is asked for **the whole puzzle**: words, coordinates, directions
   and clues. ADR "The model proposes the layout, a validator decides" is
   explicit that the layout is the interesting part, and that generating clues
   against a deterministic grid would be reliable and unambitious. Nothing it
   proposes is trusted, which is what makes asking for the ambitious thing safe.

   `propose`, which asks for words alone, is the **fallback's** input rather than
   the main path: step 4 of that pipeline packs the model's word list when a
   layout cannot be repaired, so the button always works. */

import type { Entry } from "../types.ts";

/* One word with its clue, before anything knows where it will sit. `answer` is
   uppercase A to Z: generated puzzles are English only in B3, and normalizing
   here means the packer and the validator never have to think about case. */
export interface Candidate {
  answer: string;
  clue: string;
}

export interface Proposal {
  theme: string;
  candidates: Candidate[];
}

/* A whole puzzle as the model proposes it: words, coordinates, directions and
   clues. Cells are not included and are derived from the entries, which removes
   a class of disagreement rather than validating it: a model cannot propose a
   grid whose black squares contradict its own word placements if it never gets
   to propose black squares.

   Why coordinates rather than a rendered grid, from the ADR: a schema can
   guarantee output is well formed and cannot guarantee it is well formed *as a
   puzzle*. No schema expresses "the letter at 3,4 must agree between the entry
   crossing it across and the one crossing it down". Words with coordinates are
   mechanically checkable; a picture of a grid invites fudging. */
export interface LayoutProposal {
  theme: string;
  rows: number;
  cols: number;
  entries: Entry[];
}

export interface Provider {
  /* Step 1 of the ADR pipeline: the whole puzzle at once. */
  proposeLayout(
    theme: string,
    rows: number,
    cols: number,
  ): Promise<LayoutProposal>;
  /* Step 3: the specific violations go back, naming cells and the letters in
     conflict, rather than "try again". A model told what is wrong fixes it; a
     model told it failed produces a different failure. */
  repair(previous: LayoutProposal, problems: string[]): Promise<LayoutProposal>;
  /* Step 4's input. Ask for roughly `count` candidates on a theme. Returning
     fewer is allowed and normal: the packer works with what it gets, and a
     theme that yields six usable words makes a real puzzle. */
  propose(theme: string, count: number): Promise<Proposal>;
  /* Rewrite clues for entries whose answers survived packing. Separate from
     `propose` because packing drops candidates, and a clue written for a word
     that did not make it is wasted; asking again for the survivors costs less
     than asking for everything twice. Optional: a provider that cannot do this
     leaves the original clues in place. */
  reclue?(theme: string, entries: Entry[]): Promise<Entry[]>;
}

/* Answers are A to Z only. Anything else, a space, a hyphen, an accent, a
   digit, would have to be rendered in a grid square and typed on a phone
   keyboard, and neither is worth the trouble at this size. Rejected rather
   than stripped: stripping turns "ST. LOUIS" into "STLOUIS", which is not a
   word anybody would guess. */
const ANSWER = /^[A-Z]+$/;

/* Section 7 caps a clue at 120 characters. Model output is untrusted text and
   is sanitized on write like any other displayed string (invariant 8), which
   happens where it is stored; here it is only bounded. */
const MAX_CLUE = 120;

/* True when the clue contains the answer as a whole word. Answers are A to Z
   only, so there is nothing to escape. */
function givesItAway(clue: string, answer: string): boolean {
  return new RegExp(`\\b${answer}\\b`, "i").test(clue);
}
const MIN_ANSWER = 3;
const MAX_ANSWER = 11;

/* Everything a provider returns passes through here, including the recorded
   one. A fixture is a recording of something a model actually said, so it has
   no more right to be well formed than the model did, and a test suite running
   against pre-cleaned data proves nothing about the path that matters. */
export function clean(raw: Proposal): Proposal {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const candidate of raw.candidates ?? []) {
    const answer = String(candidate?.answer ?? "")
      .trim()
      .toUpperCase();
    const clue = String(candidate?.clue ?? "")
      .replace(/\s+/g, " ")
      .trim();

    if (!ANSWER.test(answer)) continue;
    if (answer.length < MIN_ANSWER || answer.length > MAX_ANSWER) continue;
    if (!clue || clue.length > MAX_CLUE) continue;
    /* A duplicated answer would produce two entries with the same solution and
       a puzzle that reads as a mistake even when it validates. */
    if (seen.has(answer)) continue;
    /* A clue that gives away its own answer is not a clue, and models do this
       constantly when a theme word is rare.

       Matched as a **word**, not a substring, which is how this shipped and was
       wrong. `"Departure".includes("ART")` is true, so a three letter answer was
       killed by any clue containing it anywhere: ART by "departure", ONE by
       "money", OAT by "coat", SET by "sunset", ACT by "factual". Short answers
       are exactly the ones a small grid needs most, and the word list came back
       empty often enough that the fallback could not run. */
    if (givesItAway(clue, answer)) continue;

    seen.add(answer);
    candidates.push({ answer, clue });
  }

  return { theme: String(raw.theme ?? ""), candidates };
}

/* Replays recorded proposals in order, then repeats the last one forever.

   Repeating rather than throwing is deliberate: the generation loop retries,
   and a fixture list that runs out should exercise "the model kept saying the
   same unusable thing", which is exactly the give-up path section 12 asks to be
   tested. Throwing would test a crash instead. */
export function recordedProvider(
  proposals: Proposal[],
  layouts: LayoutProposal[] = [],
): Provider & { calls: number; layoutCalls: number } {
  if (!proposals.length) throw new Error("a recorded provider needs proposals");
  const provider = {
    calls: 0,
    layoutCalls: 0,
    async propose(theme: string): Promise<Proposal> {
      const index = Math.min(provider.calls, proposals.length - 1);
      provider.calls += 1;
      return clean({ ...proposals[index]!, theme });
    },
    async proposeLayout(
      theme: string,
      rows: number,
      cols: number,
    ): Promise<LayoutProposal> {
      if (!layouts.length) return { theme, rows, cols, entries: [] };
      const index = Math.min(provider.layoutCalls, layouts.length - 1);
      provider.layoutCalls += 1;
      return { ...layouts[index]!, theme };
    },
    /* Repair advances the same recorded list, so a fixture list reads as "what
       the model said on attempt one, two, three". A list that runs out repeats
       its last entry, which is what makes "the model never fixed it" testable
       rather than "the fixtures ran out". */
    async repair(previous: LayoutProposal): Promise<LayoutProposal> {
      return provider.proposeLayout(
        previous.theme,
        previous.rows,
        previous.cols,
      );
    },
  };
  return provider;
}

/* Workers AI. Not exercised by any automated check on purpose: CI holds no
   credential, and section 7 says the measurement ADR-12 asks for comes from a
   script run by hand against the real model rather than from the suite. */
export interface AiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
  ): Promise<{ response?: string }>;
}

/* Chosen for being small and instruction-following rather than for being the
   best writer. The daily ceiling in section 7 is a function of this choice, so
   changing the model means re-running the measurement.

   Corrected 2026-08-04. This said `@cf/meta/llama-3.1-8b-instruct`, which is
   not a model Workers AI serves; the real id carries an `-fp8` suffix. Every
   call threw, the loop counted each throw as a failed attempt exactly as it
   was designed to, and the session ended in `failed` with a message blaming
   the theme. Written from memory instead of from `wrangler ai models list`,
   which takes ten seconds. */
export const GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

function prompt(theme: string, count: number): string {
  return [
    `Give ${count} English words for a small crossword on the theme "${theme}".`,
    `Rules: each answer is a single word, ${MIN_ANSWER} to ${MAX_ANSWER} letters, letters A-Z only.`,
    `No proper nouns, no abbreviations, no plurals of the theme word itself.`,
    `Each clue is one short sentence under ${MAX_CLUE} characters and must not contain its answer.`,
    `Reply with JSON only, no prose: {"candidates":[{"answer":"...","clue":"..."}]}`,
  ].join(" ");
}

/* Models wrap JSON in prose and fences however they were feeling. Pulling out
   the first balanced object is more reliable than asking harder. */
function extractJson(text: string): unknown {
  /* Whichever bracket comes first. Looking only for `{` sliced a top-level
     array down to its first element, which reads as the model having sent one
     entry when it sent eight. */
  const curly = text.indexOf("{");
  const square = text.indexOf("[");
  const start =
    curly < 0 ? square : square < 0 ? curly : Math.min(curly, square);
  if (start < 0) return null;

  const open = text[start] as "{" | "[";
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (!depth) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function layoutPrompt(theme: string, rows: number, cols: number): string {
  return [
    `Design a small English crossword on the theme "${theme}" for a ${rows} by ${cols} grid.`,
    `Reply with JSON only, no prose:`,
    `{"entries":[{"dir":"across","row":0,"col":0,"answer":"WORD","clue":"..."}]}`,
    `row and col are zero-based and mark the first letter. Answers are A-Z only, ${MIN_ANSWER} to ${MAX_ANSWER} letters.`,
    `Every answer after the first must cross an earlier one, and crossing answers must share the same letter at the shared square.`,
    `No two answers may sit side by side without crossing, and nothing may run off the grid.`,
    `Each clue is one short sentence under ${MAX_CLUE} characters and must not contain its answer.`,
  ].join(" ");
}

/* Model output for a layout, which arrives with whatever shape it felt like.
   `len` and `number` are derived rather than read: the model has no business
   deciding either, since length follows from the answer and numbering follows
   from the grid, and letting it propose them would create two more ways for it
   to contradict itself. */
function readEntries(raw: unknown): Entry[] {
  /* The prompt asks for `{entries:[...]}`, and a model that felt like answering
     `{across:[...],down:[...]}` or a bare array meant just as well. Accepting
     the shapes it actually produces is cheaper than insisting, and an empty
     result here costs a whole attempt. */
  const source = raw as {
    entries?: unknown;
    across?: unknown;
    down?: unknown;
  } | null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(source?.entries)
      ? source.entries
      : [
          ...(Array.isArray(source?.across)
            ? source.across.map((e) => ({ ...(e as object), dir: "across" }))
            : []),
          ...(Array.isArray(source?.down)
            ? source.down.map((e) => ({ ...(e as object), dir: "down" }))
            : []),
        ];
  if (!Array.isArray(list) || !list.length) return [];
  const out: Entry[] = [];
  for (const item of list) {
    const e = item as Record<string, unknown>;
    const answer = String(e?.answer ?? "")
      .trim()
      .toUpperCase();
    const clue = String(e?.clue ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const dir = e?.dir === "down" ? "down" : "across";
    const row = Number(e?.row);
    const col = Number(e?.col);
    if (!ANSWER.test(answer) || !clue) continue;
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
    out.push({ number: 0, dir, row, col, len: answer.length, clue, answer });
  }
  return out;
}

export function workersAiProvider(ai: AiBinding, debug = false): Provider {
  const ask = async (content: string): Promise<unknown> => {
    const result = await ai.run(GENERATION_MODEL, {
      messages: [{ role: "user", content }],
    });
    const raw = result?.response ?? "";
    const parsed = extractJson(raw);
    /* Off by default: model output is large and this is the one place that
       would put a whole puzzle in the logs, which section 16 forbids for
       puzzle content. On when diagnosing, because the alternative is guessing
       what the model said. */
    if (debug) {
      console.log(
        JSON.stringify({
          at: "model",
          chars: raw.length,
          parsed: parsed ? "yes" : "no",
          /* Truncated hard: enough to see the shape and whether it is JSON at
             all, not enough to be a transcript. */
          head: raw.slice(0, 400),
        }),
      );
    }
    return parsed;
  };

  return {
    async proposeLayout(
      theme: string,
      rows: number,
      cols: number,
    ): Promise<LayoutProposal> {
      return {
        theme,
        rows,
        cols,
        entries: readEntries(await ask(layoutPrompt(theme, rows, cols))),
      };
    },

    /* The violations go back verbatim, naming cells and conflicting letters,
       because a model told what is wrong fixes it and a model told it failed
       produces a different failure. */
    async repair(
      previous: LayoutProposal,
      problems: string[],
    ): Promise<LayoutProposal> {
      const content = [
        `This crossword layout was rejected. Fix only what is listed and keep everything else.`,
        `Problems: ${problems.join("; ")}.`,
        `Previous: ${JSON.stringify({ entries: previous.entries.map((e) => ({ dir: e.dir, row: e.row, col: e.col, answer: e.answer, clue: e.clue })) })}`,
        `Reply with the corrected JSON only, same shape, no prose.`,
      ].join(" ");
      return {
        theme: previous.theme,
        rows: previous.rows,
        cols: previous.cols,
        entries: readEntries(await ask(content)),
      };
    },

    async propose(theme: string, count: number): Promise<Proposal> {
      const result = await ai.run(GENERATION_MODEL, {
        messages: [{ role: "user", content: prompt(theme, count) }],
      });
      const parsed = extractJson(result?.response ?? "") as {
        candidates?: Candidate[];
      } | null;
      /* A response that parses to nothing is an empty proposal rather than an
         exception. The loop above already knows how to retry an unusable
         proposal and how to give up, and a throw here would need a second,
         parallel way of expressing the same outcome. */
      return clean({ theme, candidates: parsed?.candidates ?? [] });
    },
  };
}
