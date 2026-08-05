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
import {
  isPersianAnswer,
  normalizePersian,
  persianGivesItAway,
  persianLength,
} from "./persian.ts";

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
  /* "schema" or "plain": whether the model accepted a JSON schema. Surfaced in
     the trace because a reply full of malformed JSON means one of those two
     things, and guessing which wasted an afternoon. */
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

/* What "a letter" means, per language, in one place.

   **This is the trust boundary for Persian, and putting it anywhere else would
   have meant putting it in four places.** Every comparison downstream is a
   letter comparison: the validator checks a crossing's across letter against
   its down letter, the packer looks for shared letters, and `check.ts`
   compares typed input against the answer. In English a letter is a letter. In
   Persian the same word has several spellings, so unless answers are folded to
   one form *on the way in*, each of those comparisons is a coin toss. Folding
   here means validate, pack and check need to know nothing about Persian.

   `normalize` runs before every other rule, so length and the giveaway check
   both see canonical text. See `persian.ts` for what folds into what and for
   Hossein's ruling on the letter groups. */
export interface LangRules {
  normalize(value: string): string;
  isAnswer(normalized: string): boolean;
  length(normalized: string): number;
  givesItAway(clue: string, answer: string): boolean;
}

export const RULES: Record<"en" | "fa", LangRules> = {
  en: {
    /* Uppercase so the packer and validator never think about case. */
    normalize: (value) => value.trim().toUpperCase(),
    isAnswer: (normalized) => ANSWER.test(normalized),
    length: (normalized) => normalized.length,
    givesItAway,
  },
  fa: {
    normalize: normalizePersian,
    isAnswer: isPersianAnswer,
    /* Not `.length`: a code point count is only right *after* folding has
       removed the combining marks and the ZWNJ, which is why this goes
       through the module rather than reading the string directly. */
    length: persianLength,
    givesItAway: persianGivesItAway,
  },
};

/* Everything a provider returns passes through here, including the recorded
   one. A fixture is a recording of something a model actually said, so it has
   no more right to be well formed than the model did, and a test suite running
   against pre-cleaned data proves nothing about the path that matters. */
export function clean(raw: Proposal, lang: "en" | "fa" = "en"): Proposal {
  const rules = RULES[lang];
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const candidate of raw.candidates ?? []) {
    const answer = rules.normalize(String(candidate?.answer ?? ""));
    const clue = String(candidate?.clue ?? "")
      .replace(/\s+/g, " ")
      .trim();

    if (!rules.isAnswer(answer)) continue;
    const len = rules.length(answer);
    if (len < MIN_ANSWER || len > MAX_ANSWER) continue;
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
       empty often enough that the fallback could not run.

       Per language, because `\b` is defined in terms of `\w`, which is ASCII:
       `\bکتاب\b` matches nothing at all, so in Persian this rule would have
       silently become "never rejects". */
    if (rules.givesItAway(clue, answer)) continue;

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
  /* The fixture set's language, and it has to be here rather than defaulted
     away. The first Persian run against fixtures failed with "the model
     returned no usable entries", because this cleaned Persian answers under
     the English rules and rejected every one of them for not being A to Z.
     The fixtures were fine and the pipeline was fine; the recorded provider
     was quietly speaking the wrong language. */
  lang: "en" | "fa" = "en",
): Provider & { calls: number; layoutCalls: number } {
  if (!proposals.length) throw new Error("a recorded provider needs proposals");
  const provider = {
    calls: 0,
    layoutCalls: 0,
    async propose(theme: string): Promise<Proposal> {
      const index = Math.min(provider.calls, proposals.length - 1);
      provider.calls += 1;
      return clean({ ...proposals[index]!, theme }, lang);
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

   Output tokens dominate our cost, which is why reasoning models that emit long
   traces are the expensive ones here: `deepseek-r1-distill-qwen-32b` charges
   443,756 neurons per million output tokens against Gemma's 27,273. Any model
   with a materially different output rate means re-deriving the ceiling.

   An earlier value was `@cf/meta/llama-3.1-8b-instruct` with no `-fp8`, which
   Workers AI does not serve at all, so every call threw. Written from memory
   rather than from `wrangler ai models list`, which takes ten seconds.

   **Changed to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on 2026-08-05, and
   the reason is JSON Mode rather than quality.** Spec section 12 has the
   measurements. The short version:

   - The 8B **cannot be held to a schema at all.** Workers AI answers `5025:
     This model doesn't support JSON Schema`, so every call fell back to
     free-form text, and `salvageObjects`, `repairJson` and a tolerant
     `readEntries` existed only to guess at what the reply meant. Each was
     written against a real malformation and together they were the largest
     source of subtle bugs in generation. The 70B is on Cloudflare's JSON Mode
     list, honours the schema, and deletes that entire category of code.
   - It is also the only model this app can actually use that does so. The
     other names on Cloudflare's list are either no longer served (plain
     `llama-3.1-8b-instruct` returns 1031) or behind a licence acceptance.
   - Persian was the question that started this and is the smaller half of the
     answer: the 8B offers a paw as a falcon while passing every mechanical
     check, and the 70B returns real birds.

   It costs about five times the 8B per call, 26,668 neurons per million input
   tokens and 204,805 output against 13,778 and 26,128, **so section 7's daily
   ceiling was re-derived rather than inherited.** */
export const GENERATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/* The Persian letters a square may hold, stated in the prompt so the model is
   told rather than corrected. Kept as one string because that is how it reads
   to a model; `persian.ts` owns the authoritative set. */
const FA_LETTERS = "ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی";

/* Persian words, measured 2026-08-05 against the real model. Every line here
   answers something an earlier draft got wrong, and spec section 12 has the
   transcripts:

   - **The instructions are in English on purpose.** The same prompt written in
     Persian produced repeated JSON keys, duplicate answers and one 45 second
     call. Instruction tuning is mostly English, and that beats the priming
     effect of asking in the target language.
   - **No worked example with real words.** A draft that showed «کتاب» as a
     sample answer had «کتاب» come back inside a puzzle about birds. The shape
     is carried by the schema now, so no example is needed at all.
   - **The English gloss is asked for and thrown away.** It measurably improved
     theme adherence on every model tried, because a model that has to say what
     the word means in the same breath as choosing it drifts off the category
     less. It costs output tokens and earns them.
   - **"an example of, not merely related to"** is what stopped a jackal, a
     leopard and a fly being offered as birds. */
function persianPrompt(theme: string, count: number): string {
  return [
    `Give ${count} common Persian (Farsi) words for a small crossword on the theme "${theme}".`,
    `Every answer must itself be an example of "${theme}", not merely related to it.`,
    `Rules for each answer:`,
    `- written in Persian script, exactly one word: no spaces, no hyphens, no ZWNJ`,
    `- ${MIN_ANSWER} to ${MAX_ANSWER} Persian letters, from these only: ${FA_LETTERS}`,
    `- use ک and ی, never the Arabic ك or ي`,
    `- an everyday word, no proper nouns, no repeats`,
    `Each clue is one short Persian sentence under ${MAX_CLUE} characters that`,
    `describes its own answer well enough to guess it, and must not contain the answer.`,
    `Write the clue in Persian only: no English, and no other script.`,
    `Give "en" for each: the English meaning of your Persian answer, one word.`,
  ].join("\n");
}

function prompt(
  theme: string,
  count: number,
  lang: "en" | "fa" = "en",
): string {
  if (lang === "fa") return persianPrompt(theme, count);
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

/* Parse the reply, which is now a schema-shaped JSON document and nothing
   else.

   **Three functions used to live here and were deleted on 2026-08-05**:
   `salvageObjects`, which pulled intact objects out of a broken document;
   `repairJson`, which undid one specific punctuation slip the 8B made over and
   over; and a balanced-bracket scanner that found the JSON inside prose and
   Markdown fences. Each was written against a real reply and each was correct
   for the model it was written for.

   They are gone because they were all compensating for the same missing
   thing. The 8B cannot be held to a JSON schema, so every reply was free-form
   text that might or might not contain the shape we asked for, and the only
   options were to guess well or lose the attempt. With JSON Mode the model
   returns the document or the call fails, and guessing at a reply that should
   not need guessing is how a wrong answer gets silently accepted.

   Deliberately unforgiving, and that is the point: if this ever starts
   returning null in production, the model is not honouring the schema and the
   right response is to notice, not to paper over it. */
function extractJson(input: string): unknown {
  try {
    return JSON.parse(input.trim());
  } catch {
    return null;
  }
}

function layoutPrompt(
  theme: string,
  rows: number,
  cols: number,
  lang: "en" | "fa" = "en",
): string {
  /* The Persian layout prompt is the English one with the language rules
     swapped in, deliberately rather than as a separate prompt: the hard part
     of a layout is index arithmetic and crossing agreement, which is identical
     in both languages, and the worked example below is what makes that
     land. Only the vocabulary constraints differ. */
  const answerRule =
    lang === "fa"
      ? `- 5 to 8 answers, each a single Persian word, ${MIN_ANSWER} to ${MAX_ANSWER} letters from ${FA_LETTERS}, no spaces, no ZWNJ, use ک and ی not ك ي.`
      : `- 5 to 8 answers, each a single word, ${MIN_ANSWER} to ${MAX_ANSWER} letters, A-Z only, no spaces or hyphens.`;
  const clueRule =
    lang === "fa"
      ? `- Each clue is one short Persian sentence under ${MAX_CLUE} characters, in Persian script only, and must not contain its answer.`
      : `- Each clue is one short sentence under ${MAX_CLUE} characters and must not contain its answer.`;
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
    lang === "fa"
      ? `Design a small Persian (Farsi) crossword on the theme "${theme}" for a ${rows} by ${cols} grid.`
      : `Design a small English crossword on the theme "${theme}" for a ${rows} by ${cols} grid.`,
    ...(lang === "fa"
      ? [
          `Answers are written in Persian script. Every answer must itself be an example of "${theme}".`,
          /* The grid is indexed the same way in both languages, and saying so
             prevents the model helpfully mirroring the coordinates to match
             the reading direction. Direction is a rendering concern and is
             handled by `dir` on the board, never by the model. */
          `Coordinates are unaffected by writing direction: col 0 is the first letter of an across answer, whichever way the script reads.`,
        ]
      : []),
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
    answerRule,
    /* Constructive rather than prohibitive. "No two answers may sit side by
       side without crossing" is hard to parse, let alone satisfy. */
    `- Place the first answer, then place every later answer so it shares a square with an already placed answer, with the same letter on that square.`,
    `- Leave at least one empty square between parallel answers. Most of the grid stays empty; a sparse puzzle is correct.`,
    `- No letter may go past row ${rows - 1} or col ${cols - 1}.`,
    clueRule,
    `Before replying, check every shared square: the across letter must equal the down letter.`,
    `Reply with JSON only, no prose:`,
    `{"entries":[{"dir":"across","row":5,"col":2,"answer":"PLANET","clue":"..."},{"dir":"down","row":5,"col":5,"answer":"NOVEL","clue":"..."}]}`,
  ].join("\n");
}

/* Model output for a layout, in the one shape the schema permits.
   `len` and `number` are derived rather than read: the model has no business
   deciding either, since length follows from the answer and numbering follows
   from the grid, and letting it propose them would create two more ways for it
   to contradict itself.

   This used to accept `{across:[...],down:[...]}` and a bare array as well,
   and to fall back to salvaging loose objects out of the raw text. All of that
   was tolerance for a model that could not be held to a shape. `ENTRY_SCHEMA`
   requires `entries`, so anything else is the schema not being honoured, which
   is worth failing on rather than absorbing.

   What stays is the per-entry validation below, which is not tolerance: it is
   the trust boundary. A schema guarantees the document's shape and says
   nothing about whether `row` is inside the grid or `answer` is a word, and
   invariant 10 is enforced downstream by the validator on exactly that
   basis. */
function readEntries(raw: unknown, lang: "en" | "fa" = "en"): Entry[] {
  const rules = RULES[lang];
  const source = raw as { entries?: unknown } | null;
  const list = Array.isArray(source?.entries) ? source.entries : [];
  if (!list.length) return [];
  const out: Entry[] = [];
  for (const item of list) {
    const e = item as Record<string, unknown>;
    /* Folded here, so what reaches the grid, the validator and the packer is
       already canonical and nothing downstream needs a language. */
    const answer = rules.normalize(String(e?.answer ?? ""));
    const clue = String(e?.clue ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const dir = e?.dir === "down" ? "down" : "across";
    const row = Number(e?.row);
    const col = Number(e?.col);
    if (!rules.isAnswer(answer) || !clue) continue;
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
    /* `len` counts squares, which after folding is the code point count in
       both languages. Reading `.length` here would be right in English and
       wrong in Persian for any word that arrived with a ZWNJ. */
    out.push({
      number: 0,
      dir,
      row,
      col,
      len: rules.length(answer),
      clue,
      answer,
    });
  }
  return out;
}

export function workersAiProvider(
  ai: AiBinding,
  debug = false,
  model: string = GENERATION_MODEL,
  /* The puzzle's language, which decides both the prompt and how answers are
     folded on the way back. Defaulted so every existing caller and test keeps
     the English behaviour it had. */
  lang: "en" | "fa" = "en",
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
        /* Never set until 2026-08-04, and Workers AI defaults it low enough to
           cut a reply off in the middle of a word. Three layout attempts in a
           row stopped at `"answer": "COMET` and `"answer": "`, which read as the
           model being incapable when it was being silenced.

           A twelve entry layout with clues is roughly 700 tokens, so this is
           generous rather than tight. Output is what we pay for, but a reply
           truncated into invalid JSON costs the whole attempt and is spent
           either way, which makes a low ceiling the more expensive choice. */
        max_tokens: 2048,
      };
      if (withSchema) {
        input.response_format = { type: "json_schema", json_schema: schema };
      }
      const result = await ai.run(model, input);
      return result?.response ?? "";
    };

    /* The schema is the contract now, not an attempt.

       Until 2026-08-05 this tried a schema, fell back to a free-form call on
       any error, and then guessed at the result with three layers of salvage.
       That was the right shape for a model that cannot do JSON Mode, which is
       what the 8B was: every single call took the fallback.

       With a model that honours the schema there is nothing to fall back to,
       and falling back would be worse than failing, because it would quietly
       reintroduce the malformed replies the schema exists to prevent.

       Two kinds of error, and they must not be conflated. Cloudflare returns
       an error when a model **cannot satisfy the schema**, which is a real
       failed attempt: the theme produced nothing usable, the caller keeps
       their quota's worth of honesty, and the loop retries. Anything else, a
       timeout or a 5xx, is the service being unreachable, which the loop
       reports differently and refunds. Telling somebody their theme was bad
       when the model was down is the exact failure section 12 spent a lesson
       on. */
    let raw = "";
    const mode = "schema";
    try {
      raw = await call(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/json mode|json schema|schema/i.test(message)) throw err;
      last = {
        prompt: content,
        reply: "",
        parsed: false,
        ms: Date.now() - began,
        mode: "schema-refused",
      };
      return null;
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
          await ask(layoutPrompt(theme, rows, cols, lang), ENTRY_SCHEMA),
          lang,
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
        /* The arithmetic, done rather than implied. Told "reaches 11,6, outside
           an 11 by 11 grid", the model moved a six letter answer from row 9 to
           row 8 to row 8 col 5, never once computing that it must start at row
           5 or less. Three attempts, no progress. Stating the legal range costs
           a few tokens and removes the calculation entirely. */
        `Longest legal start for a down answer of N letters is row ${previous.rows} minus N. For an across answer it is col ${previous.cols} minus N. A ${previous.rows}-row grid cannot hold a 6-letter down answer starting below row ${previous.rows - 6}.`,
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
        entries: readEntries(await ask(content, ENTRY_SCHEMA), lang),
      };
    },

    async propose(theme: string, count: number): Promise<Proposal> {
      /* Same schema treatment as the layout. This is the fallback that exists
         so the button always works. */
      const parsed = (await ask(prompt(theme, count, lang), WORD_SCHEMA)) as {
        candidates?: Candidate[];
      } | null;
      const listed = parsed?.candidates ?? [];
      /* A response that parses to nothing is an empty proposal rather than an
         exception. The loop above already knows how to retry an unusable
         proposal and how to give up, and a throw here would need a second,
         parallel way of expressing the same outcome. */
      return clean({ theme, candidates: listed ?? [] }, lang);
    },
  };
}
