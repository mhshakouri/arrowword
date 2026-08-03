/* Run detection. B1, spec section 12.

   A run is a maximal straight line of adjacent `answer` cells. Runs are what an
   entry sits on: without them the app knows individual cells and nothing about
   which cells form a word, which is why ADR-5 deferred this until generation
   made it due. A generated puzzle needs runs to place answers into and numbers
   to print beside clues.

   Deliberately not stored. Runs are a pure function of `cells`, and `cells` is
   immutable once the puzzle is saved (invariant 4), so the result can never go
   stale and a stored copy could only ever disagree with the grid. Section 4
   keeps `entries` empty for photo puzzles for the same reason.

   Two things stay out, both upheld rather than forgotten: arrow rendering,
   because generated puzzles are crossword-style and have no arrows, and
   auto-advance, which ADR-5 rules out entirely and which having runs makes
   newly tempting. Knowing where a word ends is not permission to move the
   cursor there. */

import type { Cell } from "./types";

export interface Run {
  dir: "across" | "down";
  row: number;
  col: number;
  len: number;
  /* The display number of the cell this run starts at. Shared with a run in the
     other direction that starts at the same cell, which is what lets a clue
     list read "3 Across" and "3 Down". */
  number: number;
}

/* A run of one is not a word. Crosswords never clue a single cell, and a
   1-length "entry" would collect a number and a clue for something that cannot
   be answered wrongly. Callers that genuinely want every cell can ask for
   `minLength: 1`, which is what makes the single-cell case testable rather than
   invisible. */
const DEFAULT_MIN_LENGTH = 2;

function isAnswer(cells: Cell[][], row: number, col: number): boolean {
  return cells[row]?.[col]?.type === "answer";
}

/* A run starts where a word starts: an answer cell with no answer cell before
   it in that direction, and room for at least the minimum length after it.
   Expressed as "is there a cell behind me" rather than by scanning forward,
   because that is the same rule crossword numbering uses and it makes the two
   directions symmetrical. */
function startsAcross(cells: Cell[][], row: number, col: number): boolean {
  return isAnswer(cells, row, col) && !isAnswer(cells, row, col - 1);
}

function startsDown(cells: Cell[][], row: number, col: number): boolean {
  return isAnswer(cells, row, col) && !isAnswer(cells, row - 1, col);
}

function lengthAcross(cells: Cell[][], row: number, col: number): number {
  let len = 0;
  while (isAnswer(cells, row, col + len)) len += 1;
  return len;
}

function lengthDown(cells: Cell[][], row: number, col: number): number {
  let len = 0;
  while (isAnswer(cells, row + len, col)) len += 1;
  return len;
}

/* Numbering runs across the grid in reading order, and a cell that begins both
   an across and a down run takes one number for both. Numbers are assigned to
   cells, not to runs, which is the whole reason "3 Across" and "3 Down" can
   refer to the same square.

   Reading order here is top to bottom, left to right, which is how crossword
   numbering works in every language including right-to-left ones: the numbers
   follow the grid, not the script. That is why this function has no direction
   awareness beyond across and down, and why ADR-5's point about RTL affecting
   nothing until auto-advance exists still holds. */
export function detectRuns(
  cells: Cell[][],
  options: { minLength?: number } = {},
): Run[] {
  /* Floored at 1, because a minimum of 0 would make a length of zero qualify
     and mint a run at every cell that starts nothing. */
  const minLength = Math.max(1, options.minLength ?? DEFAULT_MIN_LENGTH);
  const runs: Run[] = [];
  let next = 1;

  for (let row = 0; row < cells.length; row += 1) {
    /* Per row, not a single width: nothing guarantees a stored grid is
       rectangular, and reading past a short row would throw rather than simply
       finding no cell. */
    const width = cells[row]?.length ?? 0;
    for (let col = 0; col < width; col += 1) {
      const across = startsAcross(cells, row, col)
        ? lengthAcross(cells, row, col)
        : 0;
      const down = startsDown(cells, row, col)
        ? lengthDown(cells, row, col)
        : 0;

      const takesAcross = across >= minLength;
      const takesDown = down >= minLength;
      if (!takesAcross && !takesDown) continue;

      /* One number for the cell, then both directions borrow it. Incrementing
         per run instead would number the same square twice and break every
         clue list that expects a shared number. */
      const number = next;
      next += 1;
      if (takesAcross)
        runs.push({ dir: "across", row, col, len: across, number });
      if (takesDown) runs.push({ dir: "down", row, col, len: down, number });
    }
  }

  return runs;
}

/* The cells a run covers, in order. What an entry's answer is written into and
   what a validator checks a crossing against. */
export function runCells(run: Run): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = [];
  for (let i = 0; i < run.len; i += 1) {
    out.push(
      run.dir === "across"
        ? { row: run.row, col: run.col + i }
        : { row: run.row + i, col: run.col },
    );
  }
  return out;
}

/* Where two runs cross, if they do. Invariant 10 requires every pair of
   crossing entries to agree on the shared letter, and this is the function that
   says which letter is shared. Two runs in the same direction never cross:
   parallel runs that touched would have been one run. */
export function crossing(a: Run, b: Run): { row: number; col: number } | null {
  if (a.dir === b.dir) return null;
  const [across, down] = a.dir === "across" ? [a, b] : [b, a];
  const row = across.row;
  const col = down.col;
  const onAcross = col >= across.col && col < across.col + across.len;
  const onDown = row >= down.row && row < down.row + down.len;
  return onAcross && onDown ? { row, col } : null;
}
