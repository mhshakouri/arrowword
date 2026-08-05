/* The grid for a generated puzzle. B3, spec section 11.

   A CSS grid rather than quads over a photo, because there is no photo: a
   generated puzzle has no `photoKey` and no `alignment` (invariant 11). That
   makes this the simpler of the two renderers by some distance, and it shares
   the one thing that matters, a single hidden input capturing keystrokes for
   the whole grid rather than one per cell.

   **No auto-advance** (ADR-5, upheld). B1 made it technically possible and
   section 11 decided against it anyway: minimal and predictable beats clever.
   Tapping a clue moves the selection to its first cell, which is navigation the
   player asked for, and typing a letter moves nothing.

   No correctness checking, no reveal, no solved detection. ADR-1 holds for
   generated puzzles too, which also means the write path never becomes an
   oracle that tells a player they guessed right. */

import { useEffect, useRef } from "preact/hooks";
import type { Cell, Entry, LetterValue, PeerInfo } from "../../types";
import { firstGrapheme } from "../lib/grapheme.ts";
import { useT } from "../i18n/index.ts";

export interface CrosswordBoardProps {
  /* The **puzzle's** language, not the reader's. A Persian solver may be
     reading the app in Persian and solving an English crossword, and the grid
     must follow the puzzle either way. D1's rule, now that there is something
     to apply it to. */
  lang: "en" | "fa";
  rows: number;
  cols: number;
  cells: Cell[][];
  entries: Entry[];
  letters: Record<string, LetterValue>;
  peers: PeerInfo[];
  selected: { row: number; col: number } | null;
  /* The entry whose run is lit up, if any. Set by tapping a clue. */
  highlighted: Entry | null;
  onSelect: (row: number, col: number) => void;
  onType: (row: number, col: number, ch: string) => void;
  onClear: (row: number, col: number) => void;
  /* Squares a check found wrong. Empty unless somebody asked, and cleared by
     the next edit, so the grid never carries a mark that is out of date. */
  wrong?: Array<{ row: number; col: number }>;
}

const key = (row: number, col: number) => `${row},${col}`;

/* Which cells an entry covers. Duplicated from runs.ts rather than imported:
   that module is worker-side and pulling it into the bundle to walk five cells
   would drag the whole generation validator along with it. */
function cellsOf(entry: Entry): Array<{ row: number; col: number }> {
  const out = [];
  for (let i = 0; i < entry.len; i += 1) {
    out.push(
      entry.dir === "across"
        ? { row: entry.row, col: entry.col + i }
        : { row: entry.row + i, col: entry.col },
    );
  }
  return out;
}

export function CrosswordBoard({
  lang,
  rows,
  cols,
  cells,
  entries,
  letters,
  peers,
  selected,
  highlighted,
  onSelect,
  onType,
  onClear,
  wrong = [],
}: CrosswordBoardProps) {
  const t = useT();
  const captureRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selected) captureRef.current?.focus({ preventScroll: true });
  }, [selected]);

  /* Numbers are derived from `entries` rather than stored on cells, because
     they are a function of the layout and storing them twice invites
     disagreement. Section 11 says so explicitly. */
  const numbers = new Map<string, number>();
  for (const entry of entries) {
    const at = key(entry.row, entry.col);
    if (!numbers.has(at)) numbers.set(at, entry.number);
  }

  const lit = new Set(
    highlighted ? cellsOf(highlighted).map((c) => key(c.row, c.col)) : [],
  );
  const colorOf = (by: string) => peers.find((p) => p.id === by)?.color ?? null;
  const marked = new Set(wrong.map((c) => key(c.row, c.col)));

  return (
    /* dir comes from the puzzle, never inherited from the chrome. It was
       pinned to "ltr" until D2, with a comment saying to thread `lang` here
       once generation could write Persian; this is that.

       A Persian grid is genuinely mirrored: `col 0` is the **rightmost**
       square, and the browser does that for free once the flow direction is
       right. The model is told coordinates are unaffected by writing
       direction, so the data means the same thing in both. */
    <div
      class="crossword"
      role="grid"
      aria-label={t.board.gridLabel}
      dir={lang === "fa" ? "rtl" : "ltr"}
    >
      {/* One hidden input for the whole grid, same reasoning as the photo
          board: a per-cell input would be one more thing for a screen reader to
          walk past, times the number of squares. */}
      <input
        ref={captureRef}
        class="capture"
        style={
          selected
            ? `left:${(selected.col / cols) * 100}%;top:${(selected.row / rows) * 100}%`
            : "left:0;top:0"
        }
        type="text"
        inputMode="text"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="characters"
        spellcheck={false}
        aria-hidden="true"
        tabIndex={-1}
        onInput={(e) => {
          const field = e.currentTarget as HTMLInputElement;
          const typed = field.value;
          field.value = "";
          if (!selected) return;
          const letter = firstGrapheme(typed);
          /* Uppercased because generated answers are, and a grid mixing cases
             reads as a bug. The server stores whatever arrives; this is
             presentation meeting the data where it already is. */
          if (letter) onType(selected.row, selected.col, letter.toUpperCase());
        }}
        onKeyDown={(e) => {
          if (!selected) return;
          if (e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            onClear(selected.row, selected.col);
          }
        }}
      />

      <div
        class="crossword-grid"
        style={`grid-template-columns:repeat(${cols},1fr)`}
      >
        {cells.map((line, row) =>
          line.map((cell, col) => {
            if (cell.type !== "answer") {
              return (
                <div
                  key={key(row, col)}
                  class="cw-cell cw-dead"
                  aria-hidden="true"
                />
              );
            }
            const at = key(row, col);
            const value = letters[at];
            const color = value ? colorOf(value.by) : null;
            const isSelected = selected?.row === row && selected?.col === col;
            const number = numbers.get(at);
            return (
              <button
                key={at}
                type="button"
                role="gridcell"
                class={`cw-cell cw-answer${isSelected ? " cw-selected" : ""}${
                  lit.has(at) ? " cw-lit" : ""
                }${marked.has(at) ? " cw-wrong" : ""}`}
                style={
                  color === null
                    ? undefined
                    : `--by-color: var(--player-${color % 10})`
                }
                aria-label={t.board.cellLabel(
                  row,
                  col,
                  value?.ch ?? null,
                  marked.has(at),
                )}
                onClick={() => onSelect(row, col)}
              >
                {number !== undefined && (
                  <span class="cw-number" aria-hidden="true">
                    {number}
                  </span>
                )}
                <span class="cw-letter">{value?.ch ?? ""}</span>
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
