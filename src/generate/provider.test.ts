/* The provider boundary, B3. No key, no network, no neurons.

   `clean()` gets most of the attention because it is the only thing standing
   between model output and a grid. Section 7 calls model output untrusted twice
   over: structurally, which the validator handles, and as text, which is
   sanitized where it is stored. This is the structural half. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, recordedProvider, type Proposal } from "./provider.ts";
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
