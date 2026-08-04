/* The trust boundary for generated puzzles. B3, spec section 7.

   Packing runs in the browser because Workers Free allows 10 ms of CPU per
   request and a backtracking packer does not fit in that. Moving the work
   outward does not move the verification outward: what comes back is untrusted
   input exactly like an uploaded photo, and this is the function that says so.

   The rule it enforces is invariant 10. Every entry lies wholly within the
   grid, covers only `answer` cells, and agrees with every entry it crosses on
   the shared letter. Plus one thing invariant 10 does not spell out and a real
   crossword needs: no unintended adjacency. Two entries laid side by side
   create a run in the perpendicular direction that nobody wrote a clue for, and
   a grid full of those is unsolvable rather than merely ugly.

   Nothing here is repairable in place on purpose. This function's answer is
   yes or no with a reason; deciding whether to repair, retry, or fall back
   belongs to the caller, so that a validator can never be talked into
   accepting something by the code that wants it accepted. */

import { detectRuns, runCells } from "../runs.ts";
import type { Cell, Entry } from "../types.ts";

export type Rejection =
  /* Structural, before anything can be checked against the grid. */
  | { code: "empty"; detail: string }
  | { code: "too-many-entries"; detail: string }
  | { code: "grid-too-large"; detail: string }
  /* Invariant 10, the three parts of it. */
  | { code: "off-grid"; detail: string; entry: number }
  | { code: "not-answer-cell"; detail: string; entry: number }
  | { code: "crossing-disagrees"; detail: string; entry: number }
  /* The fourth rule, which invariant 10 implies rather than states. */
  | { code: "unclued-run"; detail: string }
  /* Bookkeeping that would make a grid unrenderable rather than unsolvable. */
  | { code: "length-mismatch"; detail: string; entry: number }
  | { code: "duplicate-entry"; detail: string; entry: number };

export interface Limits {
  maxRows: number;
  maxCols: number;
  maxEntries: number;
}

/* Section 7: 11 by 11 and 12 entries at most, both deliberately small. Passed
   in rather than imported so a test can shrink them without editing config, and
   so the caller is the one place that decides what "too big" means. */
export const DEFAULT_LIMITS: Limits = {
  maxRows: 11,
  maxCols: 11,
  maxEntries: 12,
};

export type Validation = { ok: true } | { ok: false; rejections: Rejection[] };

const at = (cells: Cell[][], row: number, col: number): Cell | undefined =>
  cells[row]?.[col];

/* Graphemes, not code points, for the same reason invariant 5 counts them: a
   letter with a combining mark is several code points and one square. English
   is the only generated language in B3, so this is defensive rather than
   load-bearing today, and it is cheaper to be right now than to discover it
   when a second language arrives. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function letters(value: string): string[] {
  return [...segmenter.segment(value)].map((s) => s.segment);
}

/* Every rejection is collected rather than thrown on the first one. A model
   that produced one bad crossing usually produced several, and a repair step
   that can see all of them at once converges where one that fixes them one at a
   time does not. */
export function validate(
  cells: Cell[][],
  entries: Entry[],
  limits: Limits = DEFAULT_LIMITS,
): Validation {
  const rejections: Rejection[] = [];
  const rows = cells.length;
  const cols = Math.max(0, ...cells.map((r) => r.length));

  if (!rows || !cols || !entries.length) {
    return {
      ok: false,
      rejections: [
        {
          code: "empty",
          detail: `grid is ${rows}x${cols} with ${entries.length} entries`,
        },
      ],
    };
  }
  if (rows > limits.maxRows || cols > limits.maxCols) {
    rejections.push({
      code: "grid-too-large",
      detail: `${rows}x${cols} exceeds ${limits.maxRows}x${limits.maxCols}`,
    });
  }
  if (entries.length > limits.maxEntries) {
    rejections.push({
      code: "too-many-entries",
      detail: `${entries.length} exceeds ${limits.maxEntries}`,
    });
  }

  /* What each square is claimed to hold, and by whom. Built once, then read for
     both the crossing check and the adjacency check. */
  const claimed = new Map<string, { letter: string; entry: number }>();
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const answer = letters(entry.answer);

    if (answer.length !== entry.len) {
      rejections.push({
        code: "length-mismatch",
        entry: index,
        detail: `answer "${entry.answer}" is ${answer.length} letters but len is ${entry.len}`,
      });
      /* Everything below indexes the answer by position, so a length that
         disagrees would produce a cascade of misleading crossing failures. */
      return;
    }

    const identity = `${entry.dir}:${entry.row},${entry.col}`;
    if (seen.has(identity)) {
      rejections.push({
        code: "duplicate-entry",
        entry: index,
        detail: `a second ${entry.dir} entry starts at ${entry.row},${entry.col}`,
      });
      return;
    }
    seen.add(identity);

    const cellsOf = runCells({
      dir: entry.dir,
      row: entry.row,
      col: entry.col,
      len: entry.len,
      number: entry.number,
    });

    for (const [i, cell] of cellsOf.entries()) {
      const square = at(cells, cell.row, cell.col);
      if (!square) {
        rejections.push({
          code: "off-grid",
          entry: index,
          detail: `${entry.dir} entry at ${entry.row},${entry.col} reaches ${cell.row},${cell.col}, outside a ${rows}x${cols} grid`,
        });
        return;
      }
      if (square.type !== "answer") {
        rejections.push({
          code: "not-answer-cell",
          entry: index,
          detail: `${cell.row},${cell.col} is a ${square.type} cell, which no entry may cover`,
        });
        return;
      }

      const letter = answer[i] ?? "";
      const key = `${cell.row},${cell.col}`;
      const existing = claimed.get(key);
      if (existing && existing.letter !== letter) {
        rejections.push({
          code: "crossing-disagrees",
          entry: index,
          detail: `${key} is "${existing.letter}" in entry ${existing.entry} and "${letter}" here`,
        });
        /* Not returning: the rest of this entry may cross other entries and
           those disagreements are worth reporting in the same pass. */
        continue;
      }
      if (!existing) claimed.set(key, { letter, entry: index });
    }
  });

  /* Unintended adjacency. Every run of answer cells the grid actually contains
     must be an entry somebody wrote a clue for. B1's `detectRuns` already knows
     how to find them, which is most of why B1 came first: the packer's output is
     checked against the same geometry the renderer will number.

     Only meaningful once the entries themselves are sound. Running it over a
     grid that already failed above produces noise about runs whose entries were
     rejected for a different reason. */
  if (!rejections.length) {
    const declared = new Set(
      entries.map((e) => `${e.dir}:${e.row},${e.col}:${e.len}`),
    );
    for (const run of detectRuns(cells)) {
      const key = `${run.dir}:${run.row},${run.col}:${run.len}`;
      if (!declared.has(key)) {
        rejections.push({
          code: "unclued-run",
          detail: `${run.len} cells run ${run.dir} from ${run.row},${run.col} with no entry, so the grid asks a question nobody wrote`,
        });
      }
    }
  }

  return rejections.length ? { ok: false, rejections } : { ok: true };
}

/* Build the grid an entry list implies: `answer` where some entry lies, `dead`
   everywhere else.

   Derived rather than proposed, which deletes a whole class of disagreement
   instead of validating it. A model that got to propose black squares could
   contradict its own word placements, and then the validator would be arbitrating
   between two things the same model said. Entries are the source of truth and
   the grid follows.

   Cells outside the declared size are silently not created, so an entry that
   runs off-grid produces a grid too small to hold it and `validate` reports
   `off-grid` rather than this function quietly growing the puzzle to fit. */
export function cellsFrom(
  entries: Entry[],
  rows: number,
  cols: number,
): Cell[][] {
  const grid: Cell[][] = Array.from({ length: Math.max(0, rows) }, () =>
    Array.from({ length: Math.max(0, cols) }, (): Cell => ({ type: "dead" })),
  );
  for (const entry of entries) {
    for (const cell of runCells({
      dir: entry.dir,
      row: entry.row,
      col: entry.col,
      len: entry.len,
      number: entry.number,
    })) {
      const row = grid[cell.row];
      if (row && cell.col >= 0 && cell.col < row.length) {
        row[cell.col] = { type: "answer" };
      }
    }
  }
  return grid;
}

/* Assign the display numbers a clue list prints, in reading order, with an
   across and a down that start on the same square sharing one number.

   Shared by both paths on purpose. The packer had its own copy and the layout
   path had none at all, so every entry the model placed kept the `number: 0`
   that `readEntries` stamps, and the first layout that ever validated would
   have rendered a grid with 0 on every starting square and a clue list of
   nothing but zeros. It never surfaced because no layout ever survived
   validation in production, which is the kind of bug that waits for the day
   everything else starts working.

   Numbers are a function of the grid and nothing else, so they are computed
   here rather than trusted from the model: it has no business proposing them,
   and letting it would be one more thing for it to contradict itself about. */
export function numberEntries(entries: Entry[]): Entry[] {
  const starts = new Map<string, number>();
  let next = 1;
  const inOrder = [...entries].sort(
    (a, b) => a.row - b.row || a.col - b.col || a.dir.localeCompare(b.dir),
  );
  for (const entry of inOrder) {
    const key = `${entry.row},${entry.col}`;
    if (!starts.has(key)) {
      starts.set(key, next);
      next += 1;
    }
  }
  return inOrder.map((entry) => ({
    ...entry,
    number: starts.get(`${entry.row},${entry.col}`) ?? 0,
  }));
}

/* The letters a valid grid implies, keyed "row,col". Used by the renderer for
   nothing and by tests for everything: it is the cheapest way to assert that a
   proposal means what it claims. Answers are not secret (ADR-13), so exposing
   this costs nothing. */
export function solution(entries: Entry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const answer = letters(entry.answer);
    runCells({
      dir: entry.dir,
      row: entry.row,
      col: entry.col,
      len: entry.len,
      number: entry.number,
    }).forEach((cell, i) => {
      out[`${cell.row},${cell.col}`] = answer[i] ?? "";
    });
  }
  return out;
}
