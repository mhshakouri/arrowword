/* Four draggable corners over the photo, with a live overlay of the computed
   cell lines. Spec section 8.

   Pointer events rather than mouse or touch events, because the human check for
   A1 is done on a phone and pointer events cover both with one code path. */

import { useCallback, useRef, useState } from "preact/hooks";
import type { GridAlignment, Point } from "../../types";
import { gridLines } from "../lib/alignment.ts";
import { useT } from "../i18n/index.ts";

type Corner = keyof GridAlignment;

const CORNERS: Corner[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"];

/* Keyboard nudge, in normalized units. Section 16 requires grid controls to be
   keyboard reachable, and a drag handle that only responds to a pointer is not. */
const NUDGE = 0.005;

export interface AlignmentEditorProps {
  photoSrc: string;
  rows: number;
  cols: number;
  alignment: GridAlignment;
  onChange: (next: GridAlignment) => void;
}

export function AlignmentEditor({
  photoSrc,
  rows,
  cols,
  alignment,
  onChange,
}: AlignmentEditorProps) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  /* A ref, not state. State is flushed asynchronously, so the first
     `pointermove` after a `pointerdown` can arrive while the component still
     thinks nothing is being dragged, and that move is silently dropped. A ref
     is set synchronously. `active` exists only to drive the visual grabbed
     state, and is allowed to lag by a frame. */
  const draggingRef = useRef<Corner | null>(null);
  const [active, setActive] = useState<Corner | null>(null);

  const stop = () => {
    draggingRef.current = null;
    setActive(null);
  };

  const clamp = (n: number) => Math.min(1, Math.max(0, n));

  const pointToNormalized = useCallback(
    (clientX: number, clientY: number): Point => {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
      return {
        x: clamp((clientX - box.left) / box.width),
        y: clamp((clientY - box.top) / box.height),
      };
    },
    [],
  );

  const move = (corner: Corner, p: Point) =>
    onChange({ ...alignment, [corner]: p });

  const lines = gridLines(alignment, rows, cols);
  const polylines = lines.map((line) =>
    line.map((p) => `${p.x * 100},${p.y * 100}`).join(" "),
  );

  return (
    <div
      ref={boxRef}
      style="position:relative;touch-action:none;user-select:none;width:100%"
      onPointerMove={(e) => {
        const corner = draggingRef.current;
        if (!corner) return;
        e.preventDefault();
        move(corner, pointToNormalized(e.clientX, e.clientY));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    >
      <img
        src={photoSrc}
        alt={t.aligner.photoAlt}
        style="display:block;width:100%;height:auto;border-radius:var(--radius)"
      />

      {/* The overlay is presentational: the draggable handles below are the
          controls, and they carry the labels and the keyboard behaviour. */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"
      >
        {polylines.map((points, i) => (
          <polyline
            key={i}
            points={points}
            fill="none"
            stroke="var(--accent)"
            stroke-width="0.35"
            vector-effect="non-scaling-stroke"
            opacity={i === 0 ? 1 : 0.75}
          />
        ))}
      </svg>

      {CORNERS.map((corner) => {
        const p = alignment[corner];
        return (
          <button
            key={corner}
            type="button"
            aria-label={t.aligner.moveCorner(t.aligner.corners[corner])}
            onPointerDown={(e) => {
              draggingRef.current = corner;
              setActive(corner);
              try {
                /* Capture keeps the drag alive when the pointer leaves the
                   handle, which it immediately does. It can throw on a pointer
                   the browser no longer knows about, and a failed capture must
                   not also cancel the drag. */
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                /* Fall back to plain bubbling, which still reaches the
                   container's onPointerMove. */
              }
            }}
            onKeyDown={(e) => {
              const by: Record<string, [number, number]> = {
                ArrowLeft: [-NUDGE, 0],
                ArrowRight: [NUDGE, 0],
                ArrowUp: [0, -NUDGE],
                ArrowDown: [0, NUDGE],
              };
              const delta = by[e.key];
              if (!delta) return;
              e.preventDefault();
              move(corner, {
                x: clamp(p.x + delta[0]),
                y: clamp(p.y + delta[1]),
              });
            }}
            style={`position:absolute;left:${p.x * 100}%;top:${p.y * 100}%;
                    transform:translate(-50%,-50%);
                    width:2.75rem;height:2.75rem;border-radius:999px;
                    border:2px solid var(--accent);
                    background:color-mix(in srgb, var(--accent) ${
                      active === corner ? 45 : 25
                    }%, transparent);
                    cursor:${active === corner ? "grabbing" : "grab"};padding:0`}
          />
        );
      })}
    </div>
  );
}
