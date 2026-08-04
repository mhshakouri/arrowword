/* Wizard step 4: tag every cell.

   Changed from spec section 10's original "tap cells to cycle type". Cycling
   costs one tap per step and punishes overshooting, which on a 11 by 11 grid is
   121 chances to tap once too many. Picking a type from the legend and then
   painting cells is the same number of taps in the common case, forgiving when
   you miss, and lets a run of dead cells be dragged in one gesture. */

import { useRef, useState } from "preact/hooks";
import type { Cell, CellType, GridAlignment } from "../../types";
import { cellQuad } from "../lib/alignment.ts";
import { firstGrapheme } from "../lib/grapheme.ts";
import { t as messages, useT } from "../i18n/index.ts";

const PAINT_ORDER: CellType[] = ["answer", "clue", "dead", "prefilled"];

/* Distinct without competing with the photo underneath, which players still
   have to read through the overlay. */
const FILL: Record<CellType, string> = {
  answer: "transparent",
  clue: "color-mix(in srgb, var(--accent) 30%, transparent)",
  dead: "color-mix(in srgb, var(--foreground) 55%, transparent)",
  prefilled: "color-mix(in srgb, var(--accent) 12%, transparent)",
};

export interface CellTaggerProps {
  photoSrc: string;
  rows: number;
  cols: number;
  alignment: GridAlignment;
  cells: Cell[][];
  onChange: (cells: Cell[][]) => void;
}

export function CellTagger({
  photoSrc,
  rows,
  cols,
  alignment,
  cells,
  onChange,
}: CellTaggerProps) {
  const t = useT();
  const [paint, setPaint] = useState<CellType>("clue");
  /* A ref for the same reason as the alignment editor: state has not flushed by
     the time the first pointermove arrives, and that cell would be skipped. */
  const paintingRef = useRef(false);

  function apply(row: number, col: number) {
    const current = cells[row]?.[col];
    if (!current) return;

    if (paint === "prefilled") {
      /* Asking mid-drag would be hostile, so given letters are tap-only. */
      const raw = prompt(messages().tagger.letterPrompt, current.letter ?? "");
      if (raw === null) return;
      const letter = firstGrapheme(raw);
      if (!letter) return;
      write(row, col, { type: "prefilled", letter });
      return;
    }
    if (current.type === paint) return;
    write(row, col, { type: paint });
  }

  function write(row: number, col: number, cell: Cell) {
    const next = cells.map((line) => line.slice());
    next[row]![col] = cell;
    onChange(next);
  }

  const counts = cells.flat().reduce<Record<string, number>>((acc, c) => {
    acc[c.type] = (acc[c.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div class="stack">
      <fieldset
        style="border:1px solid var(--border);border-radius:var(--radius);padding:0.75rem"
        onPointerUp={() => {
          paintingRef.current = false;
        }}
      >
        <legend class="muted" style="padding:0 0.35rem">
          {t.tagger.legend}
        </legend>
        <div class="row">
          {PAINT_ORDER.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={paint === type}
              onClick={() => setPaint(type)}
              style={`border-color:${
                paint === type ? "var(--accent)" : "var(--border)"
              };border-width:${paint === type ? "2px" : "1px"};
                 font-weight:${paint === type ? "600" : "400"}`}
            >
              {t.tagger.types[type].label}
              <span class="muted" style="display:block;font-weight:400">
                {counts[type] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <p class="muted" style="margin:0.5rem 0 0">
          {t.tagger.types[paint].hint}
          {paint === "prefilled" && t.tagger.prefilledExtra}
        </p>
      </fieldset>

      <div
        style="position:relative;touch-action:none;user-select:none;width:100%"
        onPointerUp={() => {
          paintingRef.current = false;
        }}
        onPointerCancel={() => {
          paintingRef.current = false;
        }}
      >
        <img
          src={photoSrc}
          alt={t.tagger.photoAlt}
          style="display:block;width:100%;height:auto;border-radius:var(--radius)"
        />

        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style="position:absolute;inset:0;width:100%;height:100%"
        >
          {cells.map((line, row) =>
            line.map((cell, col) => {
              const q = cellQuad(alignment, rows, cols, row, col);
              const points = [
                q.topLeft,
                q.topRight,
                q.bottomRight,
                q.bottomLeft,
              ]
                .map((p) => `${p.x * 100},${p.y * 100}`)
                .join(" ");
              const label = t.tagger.cellLabel(
                row,
                col,
                t.tagger.types[cell.type].label,
              );
              return (
                <polygon
                  key={`${row},${col}`}
                  points={points}
                  fill={FILL[cell.type]}
                  stroke="var(--accent)"
                  stroke-width="0.2"
                  vector-effect="non-scaling-stroke"
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  style="cursor:pointer;outline-offset:2px"
                  onPointerDown={() => {
                    paintingRef.current = true;
                    apply(row, col);
                  }}
                  onPointerEnter={() => {
                    /* Dragging paints, except for given letters, which prompt. */
                    if (paintingRef.current && paint !== "prefilled") {
                      apply(row, col);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      apply(row, col);
                    }
                  }}
                />
              );
            }),
          )}
        </svg>

        {/* Given letters are drawn so the grid is checkable at a glance. */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"
        >
          {cells.map((line, row) =>
            line.map((cell, col) => {
              if (cell.type !== "prefilled" || !cell.letter) return null;
              const q = cellQuad(alignment, rows, cols, row, col);
              const cx = ((q.topLeft.x + q.bottomRight.x) / 2) * 100;
              const cy = ((q.topLeft.y + q.bottomRight.y) / 2) * 100;
              return (
                <text
                  key={`t${row},${col}`}
                  x={cx}
                  y={cy}
                  text-anchor="middle"
                  dominant-baseline="central"
                  fill="var(--foreground)"
                  style="font-size:3px;font-weight:700"
                >
                  {cell.letter}
                </text>
              );
            }),
          )}
        </svg>
      </div>
    </div>
  );
}
