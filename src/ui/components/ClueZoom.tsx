/* A zoomed view of one clue cell, taken from the photo. Spec section 8.

   The whole photo is scaled and translated inside a fixed viewport clipped by
   overflow hidden, which is what section 8 asks for: no canvas, no cropping, and
   nothing cached. Section 18 says to start with transform and revisit only if
   zoom feels slow on a phone. */

import { useEffect, useRef } from "preact/hooks";
import type { GridAlignment } from "../../types";
import { cellQuad } from "../lib/alignment.ts";
import { useT } from "../i18n/index.ts";

export interface ClueZoomProps {
  photoSrc: string;
  alignment: GridAlignment;
  rows: number;
  cols: number;
  row: number;
  col: number;
  /* Room around the cell, as a fraction of its size. A clue is printed inside
     its cell and often runs close to the edges, so a little context is the
     difference between readable and cropped. */
  padding?: number;
  onClose: () => void;
}

export function ClueZoom({
  photoSrc,
  alignment,
  rows,
  cols,
  row,
  col,
  padding = 0.35,
  onClose,
}: ClueZoomProps) {
  const t = useT();
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  /* Section 16: the overlay traps focus and closes on Escape. */
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      /* One focusable control, so Tab has nowhere else to go. */
      e.preventDefault();
      closeRef.current?.focus();
    };
    /* On `document` rather than `window`: both receive a real keydown, and a
       listener here also catches events dispatched at the document, which is
       what a test or an assistive tool is likely to do. */
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* Positioning waits for the image's natural size, because the transform is
     computed in photo pixels and normalized coordinates cannot supply them. */
  function place() {
    const frame = frameRef.current;
    const img = imgRef.current;
    if (!frame || !img || !img.naturalWidth) return;

    const quad = cellQuad(alignment, rows, cols, row, col);
    const xs = [
      quad.topLeft.x,
      quad.topRight.x,
      quad.bottomRight.x,
      quad.bottomLeft.x,
    ];
    const ys = [
      quad.topLeft.y,
      quad.topRight.y,
      quad.bottomRight.y,
      quad.bottomLeft.y,
    ];
    /* The cell's bounding box in photo pixels. A tilted photo makes the cell a
       quad rather than a rectangle, so the box is what has to fit. */
    const left = Math.min(...xs) * img.naturalWidth;
    const right = Math.max(...xs) * img.naturalWidth;
    const top = Math.min(...ys) * img.naturalHeight;
    const bottom = Math.max(...ys) * img.naturalHeight;

    const padX = (right - left) * padding;
    const padY = (bottom - top) * padding;
    const boxW = right - left + padX * 2;
    const boxH = bottom - top + padY * 2;

    const { width: frameW, height: frameH } = frame.getBoundingClientRect();
    /* Fit rather than fill, so nothing of the cell is cut off. */
    const scale = Math.min(frameW / boxW, frameH / boxH);

    const offsetX = (frameW - boxW * scale) / 2;
    const offsetY = (frameH - boxH * scale) / 2;
    img.style.transform = `translate(${offsetX - (left - padX) * scale}px, ${
      offsetY - (top - padY) * scale
    }px) scale(${scale})`;
  }

  useEffect(() => {
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  });

  return (
    <div
      class="zoom-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t.clueZoom.dialogLabel(row, col)}
      /* Tapping outside closes, which is what a phone user reaches for first. */
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="stack" style="align-items:center">
        <div class="zoom-frame" ref={frameRef}>
          <img
            ref={imgRef}
            src={photoSrc}
            alt={t.clueZoom.photoAlt(row, col)}
            onLoad={place}
          />
        </div>
        <button ref={closeRef} class="primary" onClick={onClose}>
          {t.common.close}
        </button>
      </div>
    </div>
  );
}
