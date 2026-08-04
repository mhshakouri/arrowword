/* The provider boundary, B3. No key, no network, no neurons.

   `clean()` gets most of the attention because it is the only thing standing
   between model output and a grid. Section 7 calls model output untrusted twice
   over: structurally, which the validator handles, and as text, which is
   sanitized where it is stored. This is the structural half. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clean,
  GENERATION_MODEL,
  recordedProvider,
  workersAiProvider,
  type Proposal,
} from "./provider.ts";
import {
  CROSSING_RICH,
  MESSY,
  NEVER_VALID,
  RECOVERS,
  RIVERS,
  UNUSABLE,
} from "./fixtures.ts";

const answers = (p: Proposal) => p.candidates.map((c) => c.answer);

/* ---- clean(), the structural gate ---- */

test("a clean proposal survives intact", () => {
  const out = clean(RIVERS);
  assert.equal(out.candidates.length, RIVERS.candidates.length);
});

test("lowercase answers are uppercased rather than dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "whisk", clue: "You beat eggs with it" }],
  });
  assert.deepEqual(answers(out), ["WHISK"]);
});

test("a two-word answer is dropped, not stripped of its space", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "FRYING PAN", clue: "Flat, with a handle" }],
  });
  assert.deepEqual(answers(out), []);
});

test("an answer with an accent is dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "CAFÉ", clue: "Somewhere to sit" }],
  });
  assert.deepEqual(answers(out), []);
});

test("digits are not letters", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "12345", clue: "Numbers" }],
  });
  assert.deepEqual(answers(out), []);
});

test("answers outside the length range are dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [
      { answer: "PA", clue: "Too short" },
      { answer: "SUPERCALIFRAGILISTIC", clue: "Too long" },
      { answer: "CAT", clue: "Just right" },
    ],
  });
  assert.deepEqual(answers(out), ["CAT"]);
});

/* Models do this constantly when a theme word is rare, and it makes the puzzle
   unsolvable in the sense that matters: the answer is already printed. */
test("a clue containing its own answer is dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "LADLE", clue: "A ladle for serving soup" }],
  });
  assert.deepEqual(answers(out), []);
});

test("the answer check is case insensitive inside the clue", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "The oven in your kitchen" }],
  });
  assert.deepEqual(answers(out), []);
});

test("an empty clue is dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "" }],
  });
  assert.deepEqual(answers(out), []);
});

test("a clue past the length cap is dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "x".repeat(121) }],
  });
  assert.deepEqual(answers(out), []);
});

test("a clue at exactly the cap is kept", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "x".repeat(120) }],
  });
  assert.deepEqual(answers(out), ["OVEN"]);
});

test("whitespace in clues is collapsed", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "  It   gets\n\nhot  " }],
  });
  assert.equal(out.candidates[0]?.clue, "It gets hot");
});

/* A duplicate produces two entries with the same solution, which reads as a
   mistake even when it validates. */
test("a duplicate answer is dropped, including one differing only in case", () => {
  const out = clean({
    theme: "t",
    candidates: [
      { answer: "WHISK", clue: "You beat eggs with it" },
      { answer: "whisk", clue: "For whipping cream by hand" },
    ],
  });
  assert.deepEqual(answers(out), ["WHISK"]);
});

test("missing or malformed candidates do not throw", () => {
  const out = clean({ theme: "t" } as unknown as Proposal);
  assert.deepEqual(out.candidates, []);
  const out2 = clean({
    theme: "t",
    candidates: [null, undefined, {}] as unknown as Proposal["candidates"],
  });
  assert.deepEqual(out2.candidates, []);
});

/* ---- The fixtures themselves, which are recordings and not ideal input ---- */

test("the messy fixture loses exactly its four bad candidates", () => {
  const out = clean(MESSY);
  assert.deepEqual(answers(out), ["WHISK", "SIEVE", "KNIFE", "GRATER"]);
});

test("the unusable fixture yields nothing at all", () => {
  assert.deepEqual(clean(UNUSABLE).candidates, []);
});

test("the crossing-rich fixture survives cleaning, since packing needs it", () => {
  assert.equal(
    clean(CROSSING_RICH).candidates.length,
    CROSSING_RICH.candidates.length,
  );
});

test("every fixture is clean-safe, meaning cleaning twice changes nothing", () => {
  for (const fixture of [RIVERS, MESSY, UNUSABLE, CROSSING_RICH]) {
    const once = clean(fixture);
    assert.deepEqual(clean(once), once, `${fixture.theme} is not idempotent`);
  }
});

/* ---- recordedProvider ---- */

test("a recorded provider replays proposals in order", async () => {
  const provider = recordedProvider(RECOVERS);
  assert.deepEqual((await provider.propose("t", 10)).candidates, []);
  assert.ok((await provider.propose("t", 10)).candidates.length > 0);
});

/* Repeating rather than throwing is what lets a test exercise "the model kept
   saying the same unusable thing" instead of "the fixture list ran out". */
test("a recorded provider repeats its last proposal forever", async () => {
  const provider = recordedProvider(NEVER_VALID);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual((await provider.propose("t", 10)).candidates, []);
  }
  assert.equal(provider.calls, 5);
});

test("a recorded provider stamps the theme it was asked for", async () => {
  const provider = recordedProvider([RIVERS]);
  assert.equal((await provider.propose("mountains", 10)).theme, "mountains");
});

test("a recorded provider cleans what it replays", async () => {
  const provider = recordedProvider([MESSY]);
  const out = await provider.propose("kitchen", 10);
  assert.equal(
    out.candidates.some((c) => c.answer.includes(" ")),
    false,
  );
});

test("a recorded provider with no proposals is a programming error", () => {
  assert.throws(() => recordedProvider([]), /needs proposals/);
});

/* ---- The model id ----

   B3 shipped with `@cf/meta/llama-3.1-8b-instruct`, which Workers AI does not
   serve; the real id carries an `-fp8` suffix. Every call threw, the loop
   counted each throw as a failed attempt exactly as designed, and the first
   person to try the feature was told their theme was the problem.

   Nothing here can ask Cloudflare what exists, because CI holds no credential
   and must not. What it can do is stop the value drifting silently: this test
   fails if the id changes, so changing it is a deliberate act with a reason in
   the diff rather than an edit nobody reviews. `wrangler ai models list` is
   the ten seconds that would have caught it. */

test("the generation model id is pinned, and changing it is deliberate", () => {
  assert.equal(GENERATION_MODEL, "@cf/meta/llama-3.1-8b-instruct-fp8");
});

test("the model id looks like a Workers AI id at all", () => {
  assert.match(GENERATION_MODEL, /^@cf\/[a-z0-9-]+\/[a-z0-9.-]+$/);
});

/* ---- The clue-gives-it-away rule matches words, not substrings ----

   Shipped as `clue.toUpperCase().includes(answer)`, which kills a three letter
   answer whenever its letters appear anywhere in the clue. Short answers are
   the ones a small grid needs most, and enough of them were dropped that the
   word list came back empty and the packing fallback could not run. */

const kept = (answer: string, clue: string) =>
  clean({ theme: "t", candidates: [{ answer, clue }] }).candidates.length === 1;

test("a clue merely containing the answer's letters is kept", () => {
  assert.ok(kept("ART", "Departure lounge"), "ART killed by 'departure'");
  assert.ok(kept("ONE", "Money spent on a film"), "ONE killed by 'money'");
  assert.ok(kept("OAT", "Coat of paint"), "OAT killed by 'coat'");
  assert.ok(kept("SET", "Sunset over the studio"), "SET killed by 'sunset'");
  assert.ok(kept("ACT", "A factual scene"), "ACT killed by 'factual'");
});

test("a clue containing the answer as a word is still dropped", () => {
  assert.equal(kept("LADLE", "A ladle for serving soup"), false);
  assert.equal(kept("ART", "The art of film"), false);
  assert.equal(kept("REEL", "A film reel holder"), false);
});

test("the word match ignores case and punctuation around the word", () => {
  assert.equal(kept("SET", "On the set, before dawn"), false);
  assert.equal(kept("SET", "Where filming happens (the SET)"), false);
});

/* ---- readEntries accepts the shapes a model actually produces ---- */

test("a layout split into across and down arrays is read", async () => {
  const ai = {
    async run() {
      return {
        response: JSON.stringify({
          across: [{ row: 0, col: 0, answer: "CAT", clue: "It ignores you" }],
          down: [{ row: 0, col: 0, answer: "COT", clue: "A small bed" }],
        }),
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0]?.dir, "across");
  assert.equal(out.entries[1]?.dir, "down");
});

test("a bare array of entries is read", async () => {
  const ai = {
    async run() {
      return {
        response: JSON.stringify([
          {
            dir: "across",
            row: 0,
            col: 0,
            answer: "CAT",
            clue: "It ignores you",
          },
        ]),
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(out.entries.length, 1);
});

test("prose around the JSON does not stop it being read", async () => {
  const ai = {
    async run() {
      return {
        response:
          'Sure! Here is your crossword:\n```json\n{"entries":[{"dir":"down","row":1,"col":2,"answer":"COT","clue":"A small bed"}]}\n```\nHope that helps.',
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0]?.answer, "COT");
});

test("len is derived from the answer, never read from the model", async () => {
  const ai = {
    async run() {
      return {
        response: JSON.stringify({
          entries: [
            {
              dir: "across",
              row: 0,
              col: 0,
              answer: "CAT",
              clue: "c",
              len: 99,
            },
          ],
        }),
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(out.entries[0]?.len, 3);
});
