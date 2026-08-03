/* Where words and clues come from. B3, spec section 7.

   Behind an interface for one stated reason: the acceptance suite must run
   without an API key and without spending a neuron budget, and CI must hold no
   credential at all. A recorded provider replays proposals from disk; the real
   one calls Workers AI. Both satisfy the same shape, so the generation loop
   above them never learns which it is talking to.

   The model is asked for words and clues, **not for a layout.** ADR-12 decided
   that the model proposes and a validator decides, and packing runs in the
   browser against the word list this returns. A model asked to place words on a
   grid produces confident nonsense that then has to be repaired; a model asked
   for twelve words about rivers produces twelve words about rivers. */

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

export interface Provider {
  /* Ask for roughly `count` candidates on a theme. Returning fewer is allowed
     and normal: the packer works with what it gets, and a theme that yields six
     usable words makes a real puzzle. Returning more is also allowed, since
     trimming is cheaper than a second call. */
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
    /* A clue that contains its own answer is not a clue. Models do this
       constantly when a theme word is rare. */
    if (clue.toUpperCase().includes(answer)) continue;

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
export function recordedProvider(proposals: Proposal[]): Provider & {
  calls: number;
} {
  if (!proposals.length) throw new Error("a recorded provider needs proposals");
  const provider = {
    calls: 0,
    async propose(theme: string): Promise<Proposal> {
      const index = Math.min(provider.calls, proposals.length - 1);
      provider.calls += 1;
      const recorded = proposals[index]!;
      return clean({ ...recorded, theme });
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
   changing the model means re-running the measurement. */
export const GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct";

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
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
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

export function workersAiProvider(ai: AiBinding): Provider {
  return {
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
