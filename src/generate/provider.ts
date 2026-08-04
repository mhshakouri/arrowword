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

/* What the last call sent and got back, so the loop can record it without the
   provider having to know what a trace is. A field rather than a return value
   because every method already returns the parsed thing, and threading a second
   value through all of them would change four signatures to serve one caller. */
export interface Exchange {
  prompt: string;
  reply: string;
  parsed: boolean;
  ms: number;
  mode: string;
}

export interface Provider {
  /* The last exchange, for the trace. Absent on the recorded provider, which
     has no prompts and no replies to show. */
  lastExchange?: () => Exchange | null;
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

/* The default model. Overridable per deployment with `GENERATION_MODEL`, so
   trying a different one is a configuration change and a deploy rather than a
   code edit: the only honest way to compare two models on this task is to run
   both against real themes, and that should not need a pull request each time.

   **Back to `@cf/meta/llama-3.1-8b-instruct-fp8` on 2026-08-04**, having spent
   part of a day on Gemma 4 for nothing. Neither model was ever the problem:
   generation was started with `ctx.waitUntil` from a request handler and killed
   about 100 milliseconds later, before any model could answer. Every switch and
   every prompt rewrite was tuning something that never ran to completion.

   Reverted rather than kept because Gemma was chosen to fix a fault it did not
   have, and keeping it would bake in a decision made on false evidence. Once
   generation demonstrably works, comparing the two is a `GENERATION_MODEL`
   change and a deploy, which is exactly what that variable is for.

   Costs are near enough identical either way: the 8B is 13,778 neurons per
   million input tokens and 26,128 output, Gemma 4 is 9,091 and 27,273, which at
   our prompt size is about 15.8 against 15.5. The ceiling in section 7 does not
   move for either.

   Output tokens dominate our cost, which is why reasoning models that emit long
   traces are the expensive ones here: `deepseek-r1-distill-qwen-32b` charges
   443,756 neurons per million output tokens against Gemma's 27,273. Any model
   with a materially different output rate means re-deriving the ceiling.

   An earlier value was `@cf/meta/llama-3.1-8b-instruct` with no `-fp8`, which
   Workers AI does not serve at all, so every call threw. Written from memory
   rather than from `wrangler ai models list`, which takes ten seconds. */
export const GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

function prompt(theme: string, count: number): string {
  return [
    `Give ${count} English words for a small crossword on the theme "${theme}".`,
    `Rules: each answer is a single word, ${MIN_ANSWER} to ${MAX_ANSWER} letters, letters A-Z only.`,
    /* Proper nouns allowed, decided 2026-08-04. This banned them while the
       layout prompt did not, so a "rivers" theme that fell back to packing got
       DELTA and BANK where the layout path would have offered THAMES: the same
       theme produced a different kind of puzzle depending on which path ran,
       which is the worst of both answers.

       Allowed rather than banned in both, because the themes people actually
       type are "movie names" and "rivers", and a puzzle about rivers with no
       river in it is not what was asked for. The A-Z rule already excludes the
       cases that break a grid, since "ST. LOUIS" has a space and a full stop
       and is rejected on that ground rather than on being a name. */
    `Proper nouns are fine. No abbreviations, and no plurals of the theme word itself.`,
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
  /* Rewritten 2026-08-04 after review, and every change aims at one failure: a
     model with 4B active parameters deriving index arithmetic in its head and
     getting a crossing wrong.

     The rules were all present before. What was missing was the arithmetic they
     imply and a worked example, which is the single biggest reliability lever
     for a small model. Input costs 9,091 neurons per million against 27,273 for
     output, so 150 extra input tokens is about 1.4 neurons. Nearly free, and
     output is what we actually pay for.

     Two deliberate omissions. Nothing invites step-by-step reasoning in the
     reply, because `extractJson` takes the first balanced object and a stray
     brace inside reasoning text would poison it. And "reply with JSON only"
     stays last, because small models weight the end of a prompt. */
  return [
    `Design a small English crossword on the theme "${theme}" for a ${rows} by ${cols} grid.`,
    `row and col are zero-based and mark the first letter.`,
    /* Spelled out rather than implied. A disagreeing crossing is almost always
       this derivation going wrong, not the rule being misunderstood. */
    `An across answer starting at (row, col) puts letter k at (row, col + k).`,
    `A down answer starting at (row, col) puts letter k at (row + k, col).`,
    /* Off-theme on purpose, so the words are less likely to be copied. */
    `Correct crossing example: PLANET across at row 5 col 2 and NOVEL down at row 5 col 5 share square (5, 5), and both have N there.`,
    `Rules:`,
    /* The density knob the layout ADR says to turn before blaming the model.
       Nothing said how many answers to use, so it over-placed and trapped
       itself. The validator allows 12; asking for 5 to 8 leaves room. */
    `- 5 to 8 answers, each a single word, ${MIN_ANSWER} to ${MAX_ANSWER} letters, A-Z only, no spaces or hyphens.`,
    /* Constructive rather than prohibitive. "No two answers may sit side by
       side without crossing" is hard to parse, let alone satisfy. */
    `- Place the first answer, then place every later answer so it shares a square with an already placed answer, with the same letter on that square.`,
    `- Leave at least one empty square between parallel answers. Most of the grid stays empty; a sparse puzzle is correct.`,
    `- No letter may go past row ${rows - 1} or col ${cols - 1}.`,
    `- Each clue is one short sentence under ${MAX_CLUE} characters and must not contain its answer.`,
    `Before replying, check every shared square: the across letter must equal the down letter.`,
    `Reply with JSON only, no prose:`,
    `{"entries":[{"dir":"across","row":5,"col":2,"answer":"PLANET","clue":"..."},{"dir":"down","row":5,"col":5,"answer":"NOVEL","clue":"..."}]}`,
  ].join("\n");
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

export function workersAiProvider(
  ai: AiBinding,
  debug = false,
  model: string = GENERATION_MODEL,
): Provider {
  /* Low, because this is a constraint task rather than a creative one. Clues
     suffer slightly at a low setting and crossings suffer a great deal more at a
     high one, and a puzzle with charming clues that does not validate is not a
     puzzle. */
  const TEMPERATURE = 0.2;

  /* The shapes the prompts ask for, expressed so the model is held to them
     rather than merely asked. `len` and `number` are absent on purpose: both are
     derived, and letting a model propose them creates two more ways for it to
     contradict itself. */
  const ENTRY_SCHEMA = {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dir: { type: "string", enum: ["across", "down"] },
            row: { type: "integer" },
            col: { type: "integer" },
            answer: { type: "string" },
            clue: { type: "string" },
          },
          required: ["dir", "row", "col", "answer", "clue"],
        },
      },
    },
    required: ["entries"],
  };

  const WORD_SCHEMA = {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            answer: { type: "string" },
            clue: { type: "string" },
          },
          required: ["answer", "clue"],
        },
      },
    },
    required: ["candidates"],
  };

  /* Workers AI supports `response_format` with a JSON schema, which would end
     the "returned no usable entries" path outright.

     Attempted rather than relied on, for two reasons: the supported-model list
     varies and Gemma 4 is not confirmed on it, and Cloudflare's own
     documentation says a model that cannot satisfy a schema **returns an
     error**. An error here would land in the loop's throw path and be reported
     as the service being unreachable, which would be a lie about an outage.

     So a schema failure falls back to a plain call within the same attempt.
     Where it works we stop losing attempts to malformed JSON; where it does
     not, we are exactly where we were. */
  let last: Exchange | null = null;

  const ask = async (
    content: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> => {
    const began = Date.now();
    const call = async (withSchema: boolean): Promise<string> => {
      const input: Record<string, unknown> = {
        messages: [{ role: "user", content }],
        temperature: TEMPERATURE,
      };
      if (withSchema) {
        input.response_format = { type: "json_schema", json_schema: schema };
      }
      const result = await ai.run(model, input);
      return result?.response ?? "";
    };

    let raw = "";
    let mode = "schema";
    try {
      raw = await call(true);
    } catch {
      mode = "plain";
      raw = await call(false);
    }

    const parsed = extractJson(raw);
    /* Kept whatever `debug` says. The log is for the operator and this is for
       the person waiting on the puzzle, and only one of them can read a tail. */
    last = {
      prompt: content,
      reply: raw,
      parsed: parsed !== null,
      ms: Date.now() - began,
      mode,
    };
    /* Off by default: model output is large and this is the one place that
       would put a whole puzzle in the logs, which section 16 forbids for
       puzzle content. On when diagnosing, because the alternative is guessing
       what the model said. */
    if (debug) {
      console.log(
        JSON.stringify({
          at: "model",
          model,
          mode,
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
    lastExchange: () => last,

    async proposeLayout(
      theme: string,
      rows: number,
      cols: number,
    ): Promise<LayoutProposal> {
      return {
        theme,
        rows,
        cols,
        entries: readEntries(
          await ask(layoutPrompt(theme, rows, cols), ENTRY_SCHEMA),
        ),
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
        `A crossword layout for a ${previous.rows} by ${previous.cols} grid was rejected.`,
        /* Restated. The original repair prompt carried neither the grid size
           nor any rule, so the model was asked to fix coordinates without being
           told what the bounds were. */
        `row and col are zero-based. An across answer at (row, col) puts letter k at (row, col + k); a down answer puts letter k at (row + k, col).`,
        `No letter may go past row ${previous.rows - 1} or col ${previous.cols - 1}. Crossing answers must share the same letter on the shared square. Leave at least one empty square between parallel answers.`,
        `Problems: ${problems.join("; ")}.`,
        /* "Fix only what is listed" forbade the cheapest valid repair, which is
           usually to drop the offending entry. A sparse puzzle is a puzzle; an
           unfixable one is not. */
        `You may move, shorten, replace, or delete an offending entry. Keep the entries that were not mentioned.`,
        `Previous: ${JSON.stringify({ entries: previous.entries.map((e) => ({ dir: e.dir, row: e.row, col: e.col, answer: e.answer, clue: e.clue })) })}`,
        `Reply with the corrected JSON only, no prose, same shape.`,
      ].join("\n");
      return {
        theme: previous.theme,
        rows: previous.rows,
        cols: previous.cols,
        entries: readEntries(await ask(content, ENTRY_SCHEMA)),
      };
    },

    async propose(theme: string, count: number): Promise<Proposal> {
      /* Same schema treatment as the layout. This is the fallback that exists
         so the button always works, so it is the last thing that should lose an
         attempt to a stray sentence of prose. */
      const parsed = (await ask(prompt(theme, count), WORD_SCHEMA)) as {
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
