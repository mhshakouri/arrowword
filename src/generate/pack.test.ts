/* The packer, B3 step 4. It is the floor under generation: whatever the model
   did with coordinates, a theme that produced enough usable words must still
   produce a puzzle, "so the button always works".

   The strongest assertion here is not that it packs well. It is that everything
   it emits validates, checked against the same validator the server will use.
   A packer whose output the server refuses is worse than no packer, because the
   failure arrives after a round trip and looks like a server bug. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pack } from "./pack.ts";
import { cellsFrom, validate } from "./validate.ts";
import { clean, type Candidate } from "./provider.ts";
import { crossing } from "../runs.ts";
import { CROSSING_RICH, RIVERS } from "./fixtures.ts";

const words = (p: { candidates: Candidate[] }) => clean(p as never).candidates;

const ok = (result: ReturnType<typeof pack>) => {
  assert.notEqual(result, null, "expected a packing");
  if (!result) return;
  const cells = cellsFrom(result.entries, result.rows, result.cols);
  const check = validate(cells, result.entries);
  assert.equal(
    check.ok,
    true,
    check.ok ? "" : JSON.stringify(check.rejections, null, 2),
  );
};

/* ---- Everything it emits must validate ---- */

test("a crossing-rich word list packs into a valid puzzle", () => {
  ok(pack(words(CROSSING_RICH)));
});

test("a themed word list packs into a valid puzzle", () => {
  ok(pack(words(RIVERS)));
});

test("packing validates at several grid sizes", () => {
  for (const size of [7, 9, 11, 13]) {
    ok(pack(words(RIVERS), { rows: size, cols: size }));
  }
});

test("packing validates at several budgets, including a tiny one", () => {
  for (const budget of [50, 500, 5000, 50_000]) {
    const result = pack(words(RIVERS), { budget });
    if (result) ok(result);
  }
});

/* ---- Determinism, which is what makes a bug report reproducible ---- */

test("the same word list packs identically every time", () => {
  const a = pack(words(RIVERS));
  const b = pack(words(RIVERS));
  assert.deepEqual(a, b);
});

test("input order does not change the result, because the packer sorts", () => {
  const forward = words(RIVERS);
  const backward = [...forward].reverse();
  assert.deepEqual(pack(forward), pack(backward));
});

/* ---- What it refuses ---- */

test("too few words is null rather than a one-word puzzle", () => {
  assert.equal(pack([{ answer: "CAT", clue: "It ignores you" }]), null);
});

test("an empty list is null", () => {
  assert.equal(pack([]), null);
});

test("minEntries is respected", () => {
  const result = pack(words(CROSSING_RICH), { minEntries: 4 });
  assert.notEqual(result, null);
  assert.ok((result?.entries.length ?? 0) >= 4);
});

test("words longer than the grid are dropped rather than overflowing it", () => {
  const result = pack(
    [
      { answer: "ELEPHANT", clue: "Large and grey" },
      { answer: "CAT", clue: "It ignores you" },
      { answer: "COT", clue: "A small bed" },
      { answer: "TAP", clue: "Water" },
      { answer: "TOP", clue: "Highest" },
    ],
    { rows: 4, cols: 4 },
  );
  if (result) {
    ok(result);
    assert.equal(
      result.entries.some((e) => e.answer === "ELEPHANT"),
      false,
      "an 8-letter word cannot fit a 4x4 grid",
    );
  }
});

/* ---- The properties a crossword needs ---- */

/* The real property, checked directly rather than through a size proxy: the
   grid is one connected puzzle, not two puzzles sharing a page. Every entry
   must be reachable from the first by following crossings. */
test("every entry is connected to the rest through crossings", () => {
  for (const fixture of [CROSSING_RICH, RIVERS]) {
    const result = pack(words(fixture));
    assert.notEqual(result, null);
    if (!result) continue;

    const runs = result.entries.map((e) => ({
      dir: e.dir,
      row: e.row,
      col: e.col,
      len: e.len,
      number: e.number,
    }));
    const reached = new Set([0]);
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < runs.length; i += 1) {
        if (reached.has(i)) continue;
        for (const j of reached) {
          if (crossing(runs[i]!, runs[j]!)) {
            reached.add(i);
            grew = true;
            break;
          }
        }
      }
    }
    assert.equal(
      reached.size,
      runs.length,
      `${fixture.theme}: ${runs.length - reached.size} entries float free`,
    );
  }
});

test("the grid is trimmed to what is used, with no empty border", () => {
  const result = pack(words(RIVERS));
  assert.notEqual(result, null);
  if (!result) return;
  const cells = cellsFrom(result.entries, result.rows, result.cols);
  const rowUsed = (r: number) => cells[r]?.some((c) => c.type === "answer");
  const colUsed = (c: number) => cells.some((row) => row[c]?.type === "answer");
  assert.ok(rowUsed(0), "first row is empty");
  assert.ok(rowUsed(result.rows - 1), "last row is empty");
  assert.ok(colUsed(0), "first column is empty");
  assert.ok(colUsed(result.cols - 1), "last column is empty");
});

test("numbers are shared between an across and a down at the same square", () => {
  const result = pack(words(CROSSING_RICH));
  assert.notEqual(result, null);
  if (!result) return;
  for (const a of result.entries) {
    for (const b of result.entries) {
      if (a === b) continue;
      if (a.row === b.row && a.col === b.col) {
        assert.equal(a.number, b.number, "same square, different numbers");
      }
    }
  }
});

test("numbers are consecutive from one", () => {
  const result = pack(words(RIVERS));
  assert.notEqual(result, null);
  if (!result) return;
  const unique = [...new Set(result.entries.map((e) => e.number))].sort(
    (x, y) => x - y,
  );
  assert.deepEqual(
    unique,
    unique.map((_, i) => i + 1),
  );
});

test("clues travel with their answers", () => {
  const source = words(RIVERS);
  const result = pack(source);
  assert.notEqual(result, null);
  if (!result) return;
  for (const e of result.entries) {
    const original = source.find((c) => c.answer === e.answer);
    assert.equal(e.clue, original?.clue, `clue lost for ${e.answer}`);
  }
});

/* ---- Bounded, so it cannot hang a phone ---- */

test("a tiny budget returns quickly rather than looping", () => {
  const result = pack(words(RIVERS), { budget: 10 });
  /* Either it found something small or it found nothing. Both are fine; hanging
     is not, and the assertion is that we get here at all. */
  if (result) assert.ok(result.steps <= 10 + 2);
});

test("steps are reported so a caller can tell fast from at-the-limit", () => {
  const result = pack(words(CROSSING_RICH));
  assert.notEqual(result, null);
  assert.equal(typeof result?.steps, "number");
});

test("packing a large list stays within its budget", () => {
  const many: Candidate[] = Array.from({ length: 40 }, (_, i) => ({
    answer: ["CAT", "COT", "TAP", "TOP", "ART", "OAT", "APT", "PAT"][i % 8]!,
    clue: `clue ${i}`,
  }));
  const result = pack(clean({ theme: "t", candidates: many }).candidates, {
    budget: 2000,
  });
  if (result) {
    ok(result);
    assert.ok(result.steps <= 2000 + 2);
  }
});
