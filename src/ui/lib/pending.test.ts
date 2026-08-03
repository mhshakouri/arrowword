/* A4's pending-write logic. The behavior here is the difference between a
   reconnect that repairs and one that quietly destroys somebody else's work, and
   neither outcome is visible in a screenshot, so it is tested rather than
   demonstrated. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Letters, PendingMap } from "./pending.ts";
import { confirm, echo, key, remember, retriable, revert } from "./pending.ts";

const ME = "me";
const THEM = "them";

test("an optimistic write shows immediately, credited to the writer", () => {
  const letters: Letters = {};
  const pending = remember({}, letters, 1, 2, "م", 100);
  const shown = echo(letters, pending, ME);
  assert.deepEqual(shown[key(1, 2)], { ch: "م", at: 100, by: ME });
});

test("an optimistic clear hides a letter immediately", () => {
  const letters: Letters = { "1,2": { ch: "م", at: 50, by: THEM } };
  const pending = remember({}, letters, 1, 2, null, 100);
  assert.equal(echo(letters, pending, ME)[key(1, 2)], undefined);
});

test("echo leaves other cells alone", () => {
  const letters: Letters = { "0,0": { ch: "ک", at: 10, by: THEM } };
  const pending = remember({}, letters, 1, 2, "م", 100);
  const shown = echo(letters, pending, ME);
  assert.deepEqual(shown["0,0"], { ch: "ک", at: 10, by: THEM });
});

test("a refusal puts back exactly what was there before", () => {
  const before = { ch: "ک", at: 10, by: THEM };
  const letters: Letters = { "1,2": before };
  const pending = remember({}, letters, 1, 2, "م", 100);
  const out = revert(echo(letters, pending, ME), pending, 1, 2);
  assert.deepEqual(out.letters[key(1, 2)], before);
  assert.deepEqual(out.pending, {});
});

test("a refusal on a cell that was empty leaves it empty", () => {
  const pending = remember({}, {}, 3, 4, "م", 100);
  const out = revert(echo({}, pending, ME), pending, 3, 4);
  assert.equal(out.letters[key(3, 4)], undefined);
});

test("reverting several edits to one cell undoes all of them, not one", () => {
  /* Typing three letters into a cell while offline, then being refused, has to
     land back on the original rather than on the second guess. */
  const original = { ch: "ک", at: 10, by: THEM };
  let letters: Letters = { "1,1": original };
  let pending: PendingMap = {};
  for (const [i, ch] of ["ا", "ب", "پ"].entries()) {
    pending = remember(pending, letters, 1, 1, ch, 100 + i);
    letters = echo(letters, pending, ME);
  }
  const out = revert(letters, pending, 1, 1);
  assert.deepEqual(out.letters["1,1"], original);
});

test("a matching broadcast stops the write being pending", () => {
  const pending = remember({}, {}, 1, 2, "م", 100);
  assert.deepEqual(confirm(pending, 1, 2), {});
});

test("a broadcast for an untouched cell changes nothing", () => {
  const pending = remember({}, {}, 1, 2, "م", 100);
  assert.deepEqual(confirm(pending, 5, 5), pending);
});

test("a write that already landed is not retried", () => {
  const pending = remember({}, {}, 1, 2, "م", 100);
  const fresh: Letters = { "1,2": { ch: "م", at: 105, by: ME } };
  assert.deepEqual(retriable(pending, fresh, ME), []);
});

test("a write that never arrived is retried", () => {
  const pending = remember({}, {}, 1, 2, "م", 100);
  assert.deepEqual(retriable(pending, {}, ME), [{ row: 1, col: 2, ch: "م" }]);
});

test("a retry is skipped when somebody else wrote the cell later", () => {
  /* The case that makes this conditional rather than unconditional. Retrying
     here would silently undo their work, and last-write-wins would hand it to
     the stale side simply because it arrived later. */
  const pending = remember({}, {}, 1, 2, "م", 100);
  const fresh: Letters = { "1,2": { ch: "ب", at: 200, by: THEM } };
  assert.deepEqual(retriable(pending, fresh, ME), []);
});

test("a retry proceeds when the other write was older than ours", () => {
  const pending = remember({}, {}, 1, 2, "م", 300);
  const fresh: Letters = { "1,2": { ch: "ب", at: 200, by: THEM } };
  assert.deepEqual(retriable(pending, fresh, ME), [
    { row: 1, col: 2, ch: "م" },
  ]);
});

test("a pending clear is retried when the letter is still there", () => {
  const pending = remember(
    {},
    { "1,2": { ch: "م", at: 50, by: ME } },
    1,
    2,
    null,
    100,
  );
  const fresh: Letters = { "1,2": { ch: "م", at: 50, by: ME } };
  assert.deepEqual(retriable(pending, fresh, ME), [
    { row: 1, col: 2, ch: null },
  ]);
});

test("a pending clear is not retried once the cell is already empty", () => {
  const pending = remember(
    {},
    { "1,2": { ch: "م", at: 50, by: ME } },
    1,
    2,
    null,
    100,
  );
  assert.deepEqual(retriable(pending, {}, ME), []);
});

test("several waiting cells all come back, and only once each", () => {
  let pending: PendingMap = {};
  pending = remember(pending, {}, 0, 0, "ا", 100);
  pending = remember(pending, {}, 1, 1, "ب", 101);
  /* Typed twice into the same cell: the later value is what gets retried. */
  pending = remember(pending, {}, 1, 1, "پ", 102);
  const out = retriable(pending, {}, ME).sort((a, b) => a.row - b.row);
  assert.deepEqual(out, [
    { row: 0, col: 0, ch: "ا" },
    { row: 1, col: 1, ch: "پ" },
  ]);
});
