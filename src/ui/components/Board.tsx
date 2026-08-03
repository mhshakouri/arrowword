/* The play grid, drawn over the photo. Spec sections 3, 9 and 11.

   Cells are absolutely positioned quads in image space, which is why direction
   never enters: CSS `direction` has no effect on absolutely positioned elements,
   and the app has no concept of words. See ADR-5. */

import { useEffect, useRef } from "preact/hooks";
import type { Cell, GridAlignment, LetterValue, PeerInfo } from "../../types";
import { cellQuad } from "../lib/alignment.ts";
import { firstGrapheme } from "../lib/grapheme.ts";

export interface BoardProps {
  photoSrc: string;
  alignment: GridAlignment;
  rows: number;
  cols: number;
  cells: Cell[][];
  letters: Record<string, LetterValue>;
  peers: PeerInfo[];
  selected: { row: number; col: number } | null;
  readOnly: boolean;
  onSelect: (row: number, col: number) => void;
  onClue: (row: number, col: number) => void;
  onType: (row: number, col: number, ch: string) => void;
  onClear: (row: number, col: number) => void;
}

/* The four types have to be distinguishable through the photo rather than on
   top of it, so fills stay translucent and the letters carry the contrast. */
const FILL: Record<Cell["type"], string> = {
  answer: "transparent",
  clue: "transparent",
  dead: "color-mix(in srgb, var(--foreground) 45%, transparent)",
  prefilled: "color-mix(in srgb, var(--accent) 14%, transparent)",
};

export function Board({
  photoSrc,
  alignment,
  rows,
  cols,
  cells,
  letters,
  peers,
  selected,
  readOnly,
  onSelect,
  onClue,
  onType,
  onClear,
}: BoardProps) {
  const captureRef = useRef<HTMLInputElement>(null);

  /* Focus follows selection, as a fallback for selection that did not come from
     a tap: keyboard navigation, or a later reconnect restoring a selection. */
  useEffect(() => {
    if (selected && !readOnly) captureRef.current?.focus();
  }, [selected, readOnly]);

  /* iOS opens the on-screen keyboard only for a `focus()` that happens inside
     the user gesture that caused it. Focusing from the effect above is a
     different task, so on iOS the cell would select and no keyboard would
     appear, which is the whole interaction gone. Called from the tap handler,
     synchronously, before any state update. Section 12's human check for this
     milestone exists to confirm it on a real device. */
  function focusCapture() {
    if (!readOnly) captureRef.current?.focus();
  }

  function colorFor(playerId: string): string {
    const peer = peers.find((p) => p.id === playerId);
    return peer ? `var(--player-${peer.color % 10})` : "var(--foreground)";
  }

  return (
    <div class="board">
      <img src={photoSrc} alt="The photographed puzzle you are solving." />

      {/* One hidden input for the whole grid rather than one per cell: section 9
          calls for a hidden input to capture keystrokes, and 247 of them would
          be 247 things for a screen reader to walk past. */}
      <input
        ref={captureRef}
        class="capture"
        type="text"
        inputMode="text"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
        aria-hidden="true"
        tabIndex={-1}
        onInput={(e) => {
          const field = e.currentTarget as HTMLInputElement;
          const typed = field.value;
          field.value = "";
          if (!selected || readOnly) return;
          /* One grapheme, not one code point: a Persian letter with a combining
             mark is several code points and one letter. Taking the first is
             kinder than rejecting, since a keyboard or a paste can deliver
             more. */
          const letter = firstGrapheme(typed);
          if (letter) onType(selected.row, selected.col, letter);
        }}
        onKeyDown={(e) => {
          if (!selected || readOnly) return;
          if (e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            onClear(selected.row, selected.col);
          }
        }}
      />

      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style="position:absolute;inset:0;width:100%;height:100%"
      >
        {cells.map((line, row) =>
          line.map((cell, col) => {
            const quad = cellQuad(alignment, rows, cols, row, col);
            const points = [
              quad.topLeft,
              quad.topRight,
              quad.bottomRight,
              quad.bottomLeft,
            ]
              .map((p) => `${p.x * 100},${p.y * 100}`)
              .join(" ");
            const isSelected = selected?.row === row && selected?.col === col;
            const value = letters[`${row},${col}`];
            const shown = cell.type === "prefilled" ? cell.letter : value?.ch;
            const cx = ((quad.topLeft.x + quad.bottomRight.x) / 2) * 100;
            const cy = ((quad.topLeft.y + quad.bottomRight.y) / 2) * 100;
            /* Sized from the cell so letters scale with the grid rather than
               with the viewport. */
            const size =
              Math.abs(quad.bottomRight.y - quad.topLeft.y) * 100 * 0.62;

            const label =
              cell.type === "clue"
                ? `Clue at row ${row + 1}, column ${col + 1}. Tap to read it.`
                : cell.type === "dead"
                  ? `Row ${row + 1}, column ${col + 1}, not part of the puzzle`
                  : cell.type === "prefilled"
                    ? `Row ${row + 1}, column ${col + 1}, given letter ${cell.letter}`
                    : `Row ${row + 1}, column ${col + 1}${
                        value ? `, contains ${value.ch}` : ", empty"
                      }`;

            const interactive = cell.type === "clue" || cell.type === "answer";

            return (
              <g key={`${row},${col}`}>
                <polygon
                  points={points}
                  fill={
                    isSelected
                      ? "color-mix(in srgb, var(--accent) 32%, transparent)"
                      : FILL[cell.type]
                  }
                  stroke={
                    cell.type === "clue" ? "var(--accent)" : "transparent"
                  }
                  stroke-width={cell.type === "clue" ? "0.3" : "0"}
                  vector-effect="non-scaling-stroke"
                  role={interactive ? "button" : "presentation"}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={interactive ? label : undefined}
                  style={`cursor:${interactive ? "pointer" : "default"};outline-offset:2px`}
                  onClick={() => {
                    if (cell.type === "clue") {
                      onClue(row, col);
                    } else if (cell.type === "answer") {
                      focusCapture();
                      onSelect(row, col);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    if (cell.type === "clue") {
                      onClue(row, col);
                    } else if (cell.type === "answer") {
                      focusCapture();
                      onSelect(row, col);
                    }
                  }}
                />
                {shown && (
                  <text
                    x={cx}
                    y={cy}
                    text-anchor="middle"
                    dominant-baseline="central"
                    fill={
                      cell.type === "prefilled"
                        ? "var(--foreground)"
                        : value
                          ? colorFor(value.by)
                          : "var(--foreground)"
                    }
                    style={`font-size:${size}px;font-weight:700;pointer-events:none;
                            /* Section 9: the site's Geist fonts carry no
                               Arabic-script glyphs, so letters fall back to the
                               system stack. */
                            font-family:system-ui,-apple-system,"Segoe UI",sans-serif`}
                  >
                    {shown}
                  </text>
                )}
              </g>
            );
          }),
        )}
      </svg>
    </div>
  );
}
