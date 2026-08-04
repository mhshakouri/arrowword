/* Answer checking, generated puzzles only. See the ADR-1 amendment.

   The case that matters most is the false accusation: telling somebody a
   correct letter is wrong is worse than not checking at all, because it sends
   them to undo the one square they had right. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entry, LetterValue } from "../../types.ts";
import { mark } from "./check.ts";

const entry = (
  number: number,
  dir: "across" | "down",
  row: number,
  col: number,
  answer: string,
): Entry => ({ number, dir, row, col, len: answer.length, clue: "c", answer });

/* CAT across and COT down, sharing the C at 0,0. */
const ENTRIES = [
  entry(1, "across", 0, 0, "CAT"),
  entry(1, "down", 0, 0, "COT"),
];

const letters = (map: Record<string, string>): Record<string, LetterValue> =>
  Object.fromEntries(
    Object.entries(map).map(([k, ch]) => [k, { ch, at: 0, by: "me" }]),
  );

const FULL_CORRECT = letters({
  "0,0": "C",
  "0,1": "A",
  "0,2": "T",
  "1,0": "O",
  "2,0": "T",
});

test("an empty grid is all blank and nothing is wrong", () => {
  const out = mark(ENTRIES, {});
  assert.deepEqual(out.wrong, []);
  assert.equal(out.blank, 5);
  assert.equal(out.solved, 0);
  assert.equal(out.complete, false);
});

test("a correct grid is complete with nothing wrong", () => {
  const out = mark(ENTRIES, FULL_CORRECT);
  assert.deepEqual(out.wrong, []);
  assert.equal(out.blank, 0);
  assert.equal(out.solved, 2);
  assert.equal(out.complete, true);
});

test("a wrong letter is named by its square", () => {
  const out = mark(ENTRIES, { ...FULL_CORRECT, ...letters({ "0,1": "X" }) });
  assert.deepEqual(out.wrong, [{ row: 0, col: 1 }]);
  assert.equal(out.complete, false);
});

/* The one that matters. A shared square is walked by both entries, and
   reporting it twice would tell somebody they have two mistakes in one cell. */
test("a wrong crossing square is reported once, not once per entry", () => {
  const out = mark(ENTRIES, { ...FULL_CORRECT, ...letters({ "0,0": "X" }) });
  assert.equal(out.wrong.length, 1);
  assert.deepEqual(out.wrong[0], { row: 0, col: 0 });
});

test("a blank crossing square is counted once", () => {
  const out = mark(
    ENTRIES,
    letters({ "0,1": "A", "0,2": "T", "1,0": "O", "2,0": "T" }),
  );
  assert.equal(out.blank, 1);
});

/* Never accuse somebody who is right. The grid uppercases what it captures, but
   a letter from a paste, another device, or an older client may not be. */
test("case does not make a correct letter wrong", () => {
  const out = mark(
    ENTRIES,
    letters({
      "0,0": "c",
      "0,1": "a",
      "0,2": "t",
      "1,0": "o",
      "2,0": "t",
    }),
  );
  assert.deepEqual(out.wrong, []);
  assert.equal(out.complete, true);
});

test("surrounding whitespace does not make a correct letter wrong", () => {
  const out = mark(ENTRIES, { ...FULL_CORRECT, ...letters({ "0,2": " T " }) });
  assert.deepEqual(out.wrong, []);
});

test("a blank square is not reported as wrong", () => {
  const out = mark(ENTRIES, letters({ "0,0": "C" }));
  assert.deepEqual(out.wrong, []);
  assert.ok(out.blank > 0);
});

test("an entry is solved only when it is both full and right", () => {
  const partial = mark(ENTRIES, letters({ "0,0": "C", "0,1": "A" }));
  assert.equal(partial.solved, 0);
  const oneDone = mark(
    ENTRIES,
    letters({ "0,0": "C", "0,1": "A", "0,2": "T" }),
  );
  assert.equal(oneDone.solved, 1, "CAT is done, COT is not");
});

test("no entries means nothing to be complete about", () => {
  const out = mark([], FULL_CORRECT);
  assert.equal(out.complete, false);
  assert.equal(out.entries, 0);
});

/* The feature says what is wrong and never what is right: `mark` returns
   coordinates and counts, and no correct letter anywhere. A reveal is a
   different feature with a different argument. */
test("nothing in the result carries a correct answer", () => {
  const out = mark(ENTRIES, { ...FULL_CORRECT, ...letters({ "0,1": "X" }) });
  assert.equal(JSON.stringify(out).includes("CAT"), false);
  assert.equal(JSON.stringify(out).includes("COT"), false);
});
