/* The validator, B3. Section 12 names three cases specifically: a disagreeing
   crossing, an entry running off-grid, and an unintended adjacency.

   This is the function that decides whether untrusted client output becomes a
   stored puzzle, so the tests care as much about what it *accepts* as what it
   rejects. A validator that rejects everything passes every rejection test and
   is useless. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Cell, Entry } from "../types.ts";
import {
  cellsFrom,
  numberEntries,
  solution,
  validate,
  type Rejection,
} from "./validate.ts";

/* `#` is an answer cell, anything else is dead. Same convention as runs.test. */
function grid(...rows: string[]): Cell[][] {
  return rows.map((row) =>
    [...row].map((ch): Cell => ({ type: ch === "#" ? "answer" : "dead" })),
  );
}

const entry = (
  number: number,
  dir: "across" | "down",
  row: number,
  col: number,
  answer: string,
  clue = "a clue",
): Entry => ({ number, dir, row, col, len: answer.length, clue, answer });

const codes = (v: ReturnType<typeof validate>): Rejection["code"][] =>
  v.ok ? [] : v.rejections.map((r) => r.code);

const has = (v: ReturnType<typeof validate>, code: Rejection["code"]) =>
  codes(v).includes(code);

/* A minimal correct puzzle: CAT across and COT down, sharing the C.

     C A T
     O . .
     T . .
*/
const okCells = grid("###", "#..", "#..");
const okEntries = [
  entry(1, "across", 0, 0, "CAT"),
  entry(1, "down", 0, 0, "COT"),
];

/* ---- Accepting what should be accepted ---- */

test("a correct puzzle validates", () => {
  const result = validate(okCells, okEntries);
  assert.equal(result.ok, true, JSON.stringify(codes(result)));
});

test("a puzzle whose crossings agree validates even when it is dense", () => {
  //  C A T
  //  O . O
  //  T A P
  const cells = grid("###", "#.#", "###");
  const result = validate(cells, [
    entry(1, "across", 0, 0, "CAT"),
    entry(1, "down", 0, 0, "COT"),
    entry(2, "down", 0, 2, "TOP"),
    entry(3, "across", 2, 0, "TAP"),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result));
});

/* ---- Named in section 12: a disagreeing crossing ---- */

test("a disagreeing crossing is rejected", () => {
  const result = validate(okCells, [
    entry(1, "across", 0, 0, "CAT"),
    /* Starts with D where the across entry says C. */
    entry(1, "down", 0, 0, "DOT"),
  ]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "crossing-disagrees"));
});

test("the disagreement names the square and both letters", () => {
  const result = validate(okCells, [
    entry(1, "across", 0, 0, "CAT"),
    entry(1, "down", 0, 0, "DOT"),
  ]);
  assert.equal(result.ok, false);
  const found = result.ok
    ? undefined
    : result.rejections.find((r) => r.code === "crossing-disagrees");
  assert.match(found?.detail ?? "", /0,0/);
  assert.match(found?.detail ?? "", /C/);
  assert.match(found?.detail ?? "", /D/);
});

/* ---- Named in section 12: an entry running off-grid ---- */

test("an entry running off the right edge is rejected", () => {
  const result = validate(grid("###"), [entry(1, "across", 0, 0, "CATS")]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "off-grid"));
});

test("an entry running off the bottom edge is rejected", () => {
  const result = validate(grid("#", "#"), [entry(1, "down", 0, 0, "CAT")]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "off-grid"));
});

test("an entry starting outside the grid entirely is rejected", () => {
  const result = validate(grid("###"), [entry(1, "across", 9, 0, "CAT")]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "off-grid"));
});

test("a negative coordinate is rejected rather than wrapping", () => {
  const result = validate(grid("###"), [entry(1, "across", 0, -1, "CAT")]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "off-grid"));
});

/* ---- Named in section 12: an unintended adjacency ---- */

test("two entries side by side create an unclued run and are rejected", () => {
  //  C A T
  //  O A R      COT and OAR are declared down entries, CAT across.
  //  T . .      Row 1 reads "OA", which nobody wrote a clue for.
  const cells = grid("###", "##.", "#..");
  const result = validate(cells, [
    entry(1, "across", 0, 0, "CAT"),
    entry(1, "down", 0, 0, "COT"),
    entry(2, "down", 0, 1, "AA"),
  ]);
  assert.equal(result.ok, false);
  assert.ok(
    has(result, "unclued-run"),
    `expected an unclued run, got ${JSON.stringify(codes(result))}`,
  );
});

test("the unclued run says where it is", () => {
  const cells = grid("###", "##.", "#..");
  const result = validate(cells, [
    entry(1, "across", 0, 0, "CAT"),
    entry(1, "down", 0, 0, "COT"),
    entry(2, "down", 0, 1, "AA"),
  ]);
  const found = result.ok
    ? undefined
    : result.rejections.find((r) => r.code === "unclued-run");
  assert.match(found?.detail ?? "", /1,0/);
});

test("a run the entries do declare is not reported as unclued", () => {
  const result = validate(okCells, okEntries);
  assert.equal(has(result, "unclued-run"), false);
});

/* ---- Cells an entry may not cover ---- */

test("an entry covering a dead cell is rejected", () => {
  const result = validate(grid("#.#"), [entry(1, "across", 0, 0, "CAT")]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "not-answer-cell"));
});

test("an entry covering a clue cell is rejected", () => {
  const cells: Cell[][] = [
    [{ type: "answer" }, { type: "clue" }, { type: "answer" }],
  ];
  const result = validate(cells, [entry(1, "across", 0, 0, "CAT")]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "not-answer-cell"));
});

/* Section 3 says a generated puzzle contains no prefilled cells (invariant 12),
   so an entry laid over one is a proposal that broke a different rule. */
test("an entry covering a prefilled cell is rejected", () => {
  const cells: Cell[][] = [
    [{ type: "answer" }, { type: "prefilled", letter: "A" }],
  ];
  const result = validate(cells, [entry(1, "across", 0, 0, "CA")]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "not-answer-cell"));
});

/* ---- Bookkeeping that would make a grid unrenderable ---- */

test("an answer whose length disagrees with len is rejected", () => {
  const result = validate(okCells, [
    { ...entry(1, "across", 0, 0, "CAT"), len: 2 },
    entry(1, "down", 0, 0, "COT"),
  ]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "length-mismatch"));
});

test("two entries starting at the same cell in the same direction are rejected", () => {
  const result = validate(okCells, [
    entry(1, "across", 0, 0, "CAT"),
    entry(2, "across", 0, 0, "CAT"),
    entry(1, "down", 0, 0, "COT"),
  ]);
  assert.equal(result.ok, false);
  assert.ok(has(result, "duplicate-entry"));
});

test("an across and a down starting at the same cell are fine", () => {
  assert.equal(validate(okCells, okEntries).ok, true);
});

/* ---- Structural refusals ---- */

test("an empty grid is rejected", () => {
  assert.ok(has(validate([], okEntries), "empty"));
});

test("a grid with no entries is rejected", () => {
  assert.ok(has(validate(okCells, []), "empty"));
});

test("a grid past the size limit is rejected", () => {
  const wide = grid("#".repeat(20));
  assert.ok(
    has(
      validate(wide, [entry(1, "across", 0, 0, "A".repeat(20))]),
      "grid-too-large",
    ),
  );
});

test("more entries than the limit is rejected", () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    entry(i + 1, "across", 0, 0, "CAT"),
  );
  assert.ok(has(validate(okCells, many), "too-many-entries"));
});

/* ---- Reporting ---- */

/* A model that produced one bad crossing usually produced several, and a repair
   step that sees them all at once converges where one fixing them singly does
   not. */
test("every disagreement is reported, not just the first", () => {
  //  C A T
  //  O . O
  //  T A P     both down entries start with the wrong letter
  const cells = grid("###", "#.#", "###");
  const result = validate(cells, [
    entry(1, "across", 0, 0, "CAT"),
    entry(1, "down", 0, 0, "XOT"),
    entry(2, "down", 0, 2, "YOP"),
    entry(3, "across", 2, 0, "TAP"),
  ]);
  assert.equal(result.ok, false);
  const disagreements = result.ok
    ? []
    : result.rejections.filter((r) => r.code === "crossing-disagrees");
  assert.equal(disagreements.length, 2);
});

test("a rejection always carries a detail a person could act on", () => {
  const result = validate(grid("###"), [entry(1, "across", 0, 0, "CATS")]);
  assert.equal(result.ok, false);
  for (const r of result.ok ? [] : result.rejections) {
    assert.ok(r.detail.length > 10, `bare detail: ${r.detail}`);
  }
});

/* ---- solution() ---- */

test("solution maps every covered square to its letter", () => {
  assert.deepEqual(solution(okEntries), {
    "0,0": "C",
    "0,1": "A",
    "0,2": "T",
    "1,0": "O",
    "2,0": "T",
  });
});

/* ---- cellsFrom: the grid is derived, never proposed ---- */

test("cellsFrom marks every cell an entry covers as an answer", () => {
  const cells = cellsFrom(okEntries, 3, 3);
  assert.equal(cells[0]?.[0]?.type, "answer");
  assert.equal(cells[0]?.[2]?.type, "answer");
  assert.equal(cells[2]?.[0]?.type, "answer");
});

test("cellsFrom marks everything else dead", () => {
  const cells = cellsFrom(okEntries, 3, 3);
  assert.equal(cells[1]?.[1]?.type, "dead");
  assert.equal(cells[2]?.[2]?.type, "dead");
});

test("a derived grid validates against the entries that produced it", () => {
  const cells = cellsFrom(okEntries, 3, 3);
  assert.equal(validate(cells, okEntries).ok, true);
});

/* The grid must not quietly grow to fit a bad entry. If it did, an off-grid
   proposal would become a valid puzzle of unexpected size, which is exactly the
   fudging the ADR rejects. */
test("cellsFrom does not grow the grid to fit an entry that overflows", () => {
  const cells = cellsFrom([entry(1, "across", 0, 0, "CATS")], 1, 3);
  assert.equal(cells[0]?.length, 3);
  assert.equal(
    validate(cells, [entry(1, "across", 0, 0, "CATS")]).ok,
    false,
    "an overflowing entry must still be caught",
  );
});

test("cellsFrom ignores negative coordinates rather than throwing", () => {
  const cells = cellsFrom([entry(1, "across", -1, -1, "CAT")], 2, 2);
  assert.equal(cells.length, 2);
  assert.equal(cells[0]?.[0]?.type, "dead");
});

test("a zero-sized grid is empty rather than an error", () => {
  assert.deepEqual(cellsFrom(okEntries, 0, 0), []);
});

test("solution agrees with itself at a crossing", () => {
  const map = solution(okEntries);
  assert.equal(map["0,0"], "C", "both CAT and COT start at the shared square");
});

/* ---- numberEntries ----

   The layout path had no numbering at all: `readEntries` stamps `number: 0` and
   nothing ever replaced it, so the first model layout that validated would have
   rendered 0 on every starting square and a clue list of nothing but zeros. It
   never surfaced because no layout survived validation in production, which is
   the kind of bug that waits for the day everything else starts working. */

test("numbering starts at one and has no gaps", () => {
  const out = numberEntries(okEntries);
  const unique = [...new Set(out.map((e) => e.number))].sort((a, b) => a - b);
  assert.deepEqual(
    unique,
    unique.map((_, i) => i + 1),
  );
});

test("an across and a down starting on one square share a number", () => {
  const out = numberEntries(okEntries);
  assert.equal(out[0]?.number, out[1]?.number);
});

test("numbering follows reading order, not the order given", () => {
  const out = numberEntries([
    entry(0, "across", 2, 0, "TAP"),
    entry(0, "across", 0, 0, "CAT"),
  ]);
  const first = out.find((e) => e.row === 0);
  const second = out.find((e) => e.row === 2);
  assert.equal(first?.number, 1);
  assert.equal(second?.number, 2);
});

test("nothing keeps the zero readEntries stamps", () => {
  const out = numberEntries([
    entry(0, "across", 0, 0, "CAT"),
    entry(0, "down", 0, 0, "COT"),
    entry(0, "across", 2, 0, "TAP"),
  ]);
  assert.equal(
    out.every((e) => e.number > 0),
    true,
    "an unnumbered entry survived",
  );
});

test("numbering an empty list is an empty list", () => {
  assert.deepEqual(numberEntries([]), []);
});
