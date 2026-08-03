/* Run detection, B1. Section 12 names four of these cases specifically: a
   single-cell run, an entry touching each edge, and a grid with no runs at all.

   Grids are written as strings because a nested array of cell objects is
   unreadable at this size, and a test whose fixture nobody can picture is a test
   nobody will maintain. `#` is an answer cell, `.` is anything else. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Cell } from "./types.ts";
import { crossing, detectRuns, runCells, type Run } from "./runs.ts";

function grid(...rows: string[]): Cell[][] {
  return rows.map((row) =>
    [...row].map((ch): Cell => ({ type: ch === "#" ? "answer" : "dead" })),
  );
}

const at = (runs: Run[], dir: "across" | "down", row: number, col: number) =>
  runs.find((r) => r.dir === dir && r.row === row && r.col === col);

test("an empty grid has no runs", () => {
  assert.deepEqual(detectRuns([]), []);
});

test("a grid with no answer cells at all has no runs", () => {
  assert.deepEqual(detectRuns(grid("...", "...", "...")), []);
});

test("a grid of clue cells only has no runs", () => {
  const cells: Cell[][] = [[{ type: "clue" }, { type: "clue" }]];
  assert.deepEqual(detectRuns(cells), []);
});

test("prefilled cells do not form runs, because only answer cells are writable", () => {
  const cells: Cell[][] = [
    [
      { type: "prefilled", letter: "ب" },
      { type: "prefilled", letter: "ا" },
    ],
  ];
  assert.deepEqual(detectRuns(cells), []);
});

test("one horizontal word is one across run", () => {
  const runs = detectRuns(grid("###"));
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], {
    dir: "across",
    row: 0,
    col: 0,
    len: 3,
    number: 1,
  });
});

test("one vertical word is one down run", () => {
  const runs = detectRuns(grid("#", "#", "#"));
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], { dir: "down", row: 0, col: 0, len: 3, number: 1 });
});

/* Named in section 12. A lone cell is not a word, so by default it produces
   nothing, and asking for minLength 1 is what makes it visible. */
test("a single cell is not a run by default", () => {
  assert.deepEqual(detectRuns(grid("#")), []);
});

test("a single cell is a run of one when minLength allows it", () => {
  const runs = detectRuns(grid("#"), { minLength: 1 });
  assert.equal(runs.length, 2, "a lone cell starts both an across and a down");
  assert.equal(runs[0]?.len, 1);
  assert.equal(runs[1]?.len, 1);
  assert.equal(runs[0]?.number, runs[1]?.number, "and they share one number");
});

test("a minLength of zero is floored rather than minting a run everywhere", () => {
  assert.deepEqual(detectRuns(grid("..."), { minLength: 0 }), []);
});

/* Named in section 12: an entry touching each edge. */
test("a run along the top edge is found", () => {
  const runs = detectRuns(grid("###", "...", "..."));
  assert.equal(at(runs, "across", 0, 0)?.len, 3);
});

test("a run along the bottom edge is found", () => {
  const runs = detectRuns(grid("...", "...", "###"));
  assert.equal(at(runs, "across", 2, 0)?.len, 3);
});

test("a run along the left edge is found", () => {
  const runs = detectRuns(grid("#..", "#..", "#.."));
  assert.equal(at(runs, "down", 0, 0)?.len, 3);
});

test("a run along the right edge is found", () => {
  const runs = detectRuns(grid("..#", "..#", "..#"));
  assert.equal(at(runs, "down", 0, 2)?.len, 3);
});

test("a run filling the whole grid touches every edge at once", () => {
  const runs = detectRuns(grid("##", "##"));
  assert.equal(runs.length, 4, "two across and two down");
  assert.equal(at(runs, "across", 0, 0)?.len, 2);
  assert.equal(at(runs, "across", 1, 0)?.len, 2);
  assert.equal(at(runs, "down", 0, 0)?.len, 2);
  assert.equal(at(runs, "down", 0, 1)?.len, 2);
});

/* ---- Numbering, which is the part a clue list depends on ---- */

test("a cell starting both directions gets one number, not two", () => {
  const runs = detectRuns(grid("###", "#..", "#.."));
  const across = at(runs, "across", 0, 0);
  const down = at(runs, "down", 0, 0);
  assert.equal(across?.number, 1);
  assert.equal(down?.number, 1);
});

test("numbers run in reading order, top to bottom then left to right", () => {
  //  1###
  //  #..#     the down runs at (0,0) and (0,3) share numbers with 1
  //  ####
  const runs = detectRuns(grid("####", "#..#", "####"));
  const numbers = runs.map((r) => r.number);
  assert.deepEqual(
    [...numbers].sort((a, b) => a - b),
    numbers,
    "runs come out already in numbering order",
  );
  assert.equal(at(runs, "across", 0, 0)?.number, 1);
  assert.equal(at(runs, "down", 0, 0)?.number, 1);
});

test("numbers are consecutive with no gaps", () => {
  const runs = detectRuns(grid("###", "#.#", "###"));
  const unique = [...new Set(runs.map((r) => r.number))].sort((a, b) => a - b);
  assert.deepEqual(
    unique,
    unique.map((_, i) => i + 1),
    `expected 1..n with no gaps, got ${unique.join(",")}`,
  );
});

test("two separate words on one row are two runs with different numbers", () => {
  const runs = detectRuns(grid("##.##"));
  assert.equal(runs.length, 2);
  assert.equal(at(runs, "across", 0, 0)?.number, 1);
  assert.equal(at(runs, "across", 0, 3)?.number, 2);
});

test("a gap breaks a run rather than spanning it", () => {
  const runs = detectRuns(grid("##.##"));
  assert.equal(at(runs, "across", 0, 0)?.len, 2);
  assert.equal(at(runs, "across", 0, 3)?.len, 2);
});

/* A ragged grid should not throw. Nothing guarantees a stored document is
   rectangular, and this function runs on whatever was saved. */
test("a ragged grid is read without reaching past a short row", () => {
  const cells: Cell[][] = [
    [{ type: "answer" }, { type: "answer" }, { type: "answer" }],
    [{ type: "answer" }],
  ];
  const runs = detectRuns(cells);
  assert.equal(at(runs, "across", 0, 0)?.len, 3);
  assert.equal(at(runs, "down", 0, 0)?.len, 2);
});

/* ---- runCells and crossing, which invariant 10 will lean on ---- */

test("runCells walks an across run left to right", () => {
  assert.deepEqual(
    runCells({ dir: "across", row: 1, col: 2, len: 3, number: 1 }),
    [
      { row: 1, col: 2 },
      { row: 1, col: 3 },
      { row: 1, col: 4 },
    ],
  );
});

test("runCells walks a down run top to bottom", () => {
  assert.deepEqual(
    runCells({ dir: "down", row: 0, col: 1, len: 2, number: 1 }),
    [
      { row: 0, col: 1 },
      { row: 1, col: 1 },
    ],
  );
});

test("two runs in the same direction never cross", () => {
  const a: Run = { dir: "across", row: 0, col: 0, len: 3, number: 1 };
  const b: Run = { dir: "across", row: 1, col: 0, len: 3, number: 2 };
  assert.equal(crossing(a, b), null);
});

test("a crossing is the shared cell, whichever order the pair is given in", () => {
  const across: Run = { dir: "across", row: 1, col: 0, len: 3, number: 1 };
  const down: Run = { dir: "down", row: 0, col: 1, len: 3, number: 2 };
  assert.deepEqual(crossing(across, down), { row: 1, col: 1 });
  assert.deepEqual(crossing(down, across), { row: 1, col: 1 });
});

test("runs that would meet if extended do not cross", () => {
  const across: Run = { dir: "across", row: 5, col: 0, len: 2, number: 1 };
  const down: Run = { dir: "down", row: 0, col: 9, len: 2, number: 2 };
  assert.equal(crossing(across, down), null);
});

test("every crossing found in a real grid lies on both runs", () => {
  const runs = detectRuns(grid("####", "#..#", "####"));
  for (const a of runs) {
    for (const b of runs) {
      const hit = crossing(a, b);
      if (!hit) continue;
      const onA = runCells(a).some(
        (c) => c.row === hit.row && c.col === hit.col,
      );
      const onB = runCells(b).some(
        (c) => c.row === hit.row && c.col === hit.col,
      );
      assert.ok(onA && onB, `${JSON.stringify(hit)} is not on both runs`);
    }
  }
});
