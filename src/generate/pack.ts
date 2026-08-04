/* The deterministic packer. B3, step 4 of the layout ADR.

   When the model cannot lay out a puzzle it can be repaired into, this places
   its word list instead, "so the button always works". It is the floor under
   generation: a theme that produces eight usable words always produces a
   puzzle, whatever the model did with coordinates.

   **This runs in the browser.** Workers Free allows 10 ms of CPU per request and
   backtracking search does not fit in that. The worker validates what comes
   back (invariant 10), which is the trust boundary, and moving the work outward
   moved none of the verification with it.

   Two properties matter as much as the output:

   Deterministic. The same word list in the same order produces the same grid,
   every time, with no randomness anywhere. A packer that shuffles is a packer
   whose failures cannot be reproduced from a bug report, and "it usually works"
   is not a thing a validator can be written against.

   Bounded. Every search is capped by a step budget rather than by a timer,
   because a step count behaves the same on a fast laptop and a slow phone
   whereas a timeout silently produces worse puzzles on worse hardware. Running
   out returns the best grid found so far rather than nothing. */

import type { Entry } from "../types.ts";
import type { Candidate } from "./provider.ts";
import { cellsFrom, numberEntries, validate } from "./validate.ts";

export interface PackOptions {
  rows?: number;
  cols?: number;
  /* Placements attempted before giving up and keeping the best so far. Chosen
     to be comfortably under a second on a slow phone, which at this grid size
     is thousands of steps rather than millions. */
  budget?: number;
  /* A puzzle worth showing. One word crossing nothing is a word, not a
     crossword. */
  minEntries?: number;
}

export interface Packed {
  rows: number;
  cols: number;
  entries: Entry[];
  /* How much of the search was spent, so a caller can tell "found quickly" from
     "found at the limit" without instrumenting the packer. */
  steps: number;
}

const DEFAULT_ROWS = 11;
const DEFAULT_COLS = 11;
const DEFAULT_BUDGET = 20_000;
const DEFAULT_MIN_ENTRIES = 4;

interface Placement {
  answer: string;
  clue: string;
  dir: "across" | "down";
  row: number;
  col: number;
}

/* Longest first. A long word placed early constrains the grid in ways that make
   later crossings easy to find; the same word placed last usually will not fit
   anywhere. Ties break on the answer itself so the order is total and the run
   is reproducible from the word list alone. */
function ordered(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.answer.length - a.answer.length || a.answer.localeCompare(b.answer),
  );
}

/* Whether `answer` can sit at row,col going `dir` given what is already placed.

   The rules are the validator's, checked here so the packer never proposes
   something it knows will be rejected. Duplicating them is deliberate: the
   validator is the authority and this is an optimization, so the packer being
   wrong costs a rejected proposal rather than a broken puzzle. */
function fits(
  grid: Map<string, string>,
  occupied: Set<string>,
  rows: number,
  cols: number,
  answer: string,
  dir: "across" | "down",
  row: number,
  col: number,
): boolean {
  const len = answer.length;
  if (row < 0 || col < 0) return false;
  if (dir === "across" ? col + len > cols : row + len > rows) return false;
  if (dir === "across" ? row >= rows : col >= cols) return false;

  /* The squares immediately before and after must be empty, or the word runs
     into another and forms something longer than either. */
  const beforeRow = dir === "across" ? row : row - 1;
  const beforeCol = dir === "across" ? col - 1 : col;
  const afterRow = dir === "across" ? row : row + len;
  const afterCol = dir === "across" ? col + len : col;
  if (occupied.has(`${beforeRow},${beforeCol}`)) return false;
  if (occupied.has(`${afterRow},${afterCol}`)) return false;

  let crossings = 0;
  for (let i = 0; i < len; i += 1) {
    const r = dir === "across" ? row : row + i;
    const c = dir === "across" ? col + i : col;
    const key = `${r},${c}`;
    const existing = grid.get(key);

    if (existing !== undefined) {
      /* A shared square must agree, which is invariant 10 seen from the other
         side: the packer enforces it rather than discovering it. */
      if (existing !== answer[i]) return false;
      crossings += 1;
      continue;
    }

    /* An empty square this word wants must not touch an existing word
       sideways, or the two form an unclued run in the other direction. */
    const sideA = dir === "across" ? `${r - 1},${c}` : `${r},${c - 1}`;
    const sideB = dir === "across" ? `${r + 1},${c}` : `${r},${c + 1}`;
    if (occupied.has(sideA) || occupied.has(sideB)) return false;
  }

  /* Every word after the first must cross something. A word floating alone in
     the grid is a second puzzle sharing a page. */
  return grid.size === 0 || crossings > 0;
}

/* Greedy with restarts rather than full backtracking.

   Full backtracking on twelve words in an 11x11 grid is a large search and the
   marginal puzzle is no better: past a handful of words the grid is decided by
   the first two or three placements. So the first word is tried at every
   sensible offset, each start is packed greedily, and the best result wins.
   That is bounded, deterministic, and about as good, and it fails by producing
   a smaller puzzle rather than by taking longer. */
export function pack(
  candidates: Candidate[],
  options: PackOptions = {},
): Packed | null {
  const rows = options.rows ?? DEFAULT_ROWS;
  const cols = options.cols ?? DEFAULT_COLS;
  const budget = options.budget ?? DEFAULT_BUDGET;
  const minEntries = options.minEntries ?? DEFAULT_MIN_ENTRIES;

  const words = ordered(candidates).filter(
    (c) => c.answer.length <= Math.max(rows, cols),
  );
  if (words.length < minEntries) return null;

  let steps = 0;
  let best: Placement[] = [];

  const first = words[0]!;
  /* Start positions for the longest word, centered outward: a word through the
     middle leaves room on both sides, and the loop still reaches the edges. */
  const starts: Array<{ dir: "across" | "down"; row: number; col: number }> =
    [];
  const midRow = Math.floor((rows - 1) / 2);
  const midCol = Math.floor((cols - first.answer.length) / 2);
  for (let offset = 0; offset < rows; offset += 1) {
    starts.push({
      dir: "across",
      row: (midRow + offset) % rows,
      col: Math.max(0, midCol),
    });
  }

  for (const start of starts) {
    if (steps >= budget) break;

    const grid = new Map<string, string>();
    const occupied = new Set<string>();
    const placed: Placement[] = [];

    const place = (word: Candidate, p: Omit<Placement, "answer" | "clue">) => {
      for (let i = 0; i < word.answer.length; i += 1) {
        const r = p.dir === "across" ? p.row : p.row + i;
        const c = p.dir === "across" ? p.col + i : p.col;
        grid.set(`${r},${c}`, word.answer[i]!);
        occupied.add(`${r},${c}`);
      }
      placed.push({ answer: word.answer, clue: word.clue, ...p });
    };

    if (
      !fits(
        grid,
        occupied,
        rows,
        cols,
        first.answer,
        start.dir,
        start.row,
        start.col,
      )
    ) {
      continue;
    }
    place(first, start);

    /* Each remaining word takes the first position that fits, scanned in a
       fixed order. First rather than best: "best" needs a scoring function
       nobody can justify at this size, and the restart loop above already
       explores the variation that would have bought. */
    for (const word of words.slice(1)) {
      if (placed.length >= 12) break;
      let done = false;
      for (let row = 0; row < rows && !done; row += 1) {
        for (let col = 0; col < cols && !done; col += 1) {
          for (const dir of ["across", "down"] as const) {
            steps += 1;
            if (steps >= budget) break;
            if (fits(grid, occupied, rows, cols, word.answer, dir, row, col)) {
              place(word, { dir, row, col });
              done = true;
              break;
            }
          }
        }
      }
    }

    if (placed.length > best.length) best = placed;
    /* Every word placed is as good as this gets, so stop looking. */
    if (best.length === words.length) break;
  }

  if (best.length < minEntries) return null;

  /* Trim to what is actually used, so a sparse packing does not ship a grid
     mostly made of empty squares. */
  const usedRows = best.flatMap((p) =>
    p.dir === "across" ? [p.row] : [p.row, p.row + p.answer.length - 1],
  );
  const usedCols = best.flatMap((p) =>
    p.dir === "across" ? [p.col, p.col + p.answer.length - 1] : [p.col],
  );
  const top = Math.min(...usedRows);
  const left = Math.min(...usedCols);
  const height = Math.max(...usedRows) - top + 1;
  const width = Math.max(...usedCols) - left + 1;

  const shifted = best.map((p) => ({
    ...p,
    row: p.row - top,
    col: p.col - left,
  }));

  /* Numbering comes from the shared helper rather than from placement order,
     because the numbers a clue list prints are a function of the grid and
     nothing else, and because two implementations of it is how the layout path
     ended up with none. */
  const entries = numberEntries(
    shifted.map((p) => ({
      number: 0,
      dir: p.dir,
      row: p.row,
      col: p.col,
      len: p.answer.length,
      clue: p.clue,
      answer: p.answer,
    })),
  );

  /* The packer is not the authority. If its own output does not validate, say
     so by returning nothing rather than shipping a grid the server will refuse:
     a caller that gets null can fail cleanly, where one that gets a rejected
     proposal has to explain a round trip. */
  const cells = cellsFrom(entries, height, width);
  return validate(cells, entries).ok
    ? { rows: height, cols: width, entries, steps }
    : null;
}
