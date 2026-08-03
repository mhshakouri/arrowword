/* Grid to image mapping. See docs/SPEC.md section 8.

   Photo puzzles only: a generated puzzle has no image and lays its cells out as
   a plain CSS grid, so nothing here applies to it. */

import type { GridAlignment, Point } from "../../types";

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/* Bilinear interpolation across the quad. `u` runs left to right, `v` top to
   bottom, both 0..1, and the four corners map exactly to the four alignment
   points. Flat-photo assumption per section 8: a perspective transform would
   need the same signature, so callers do not have to change to gain one. */
export function quadPoint(a: GridAlignment, u: number, v: number): Point {
  const top = lerp(a.topLeft, a.topRight, u);
  const bottom = lerp(a.bottomLeft, a.bottomRight, u);
  return lerp(top, bottom, v);
}

export interface CellQuad {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

/* The four corners of one cell, in image space. This is what the overlay draws
   and what the play grid positions against, so it returns a quad rather than a
   rectangle: on a tilted photo a cell is not axis-aligned. */
export function cellQuad(
  a: GridAlignment,
  rows: number,
  cols: number,
  row: number,
  col: number,
): CellQuad {
  const u0 = col / cols;
  const u1 = (col + 1) / cols;
  const v0 = row / rows;
  const v1 = (row + 1) / rows;
  return {
    topLeft: quadPoint(a, u0, v0),
    topRight: quadPoint(a, u1, v0),
    bottomRight: quadPoint(a, u1, v1),
    bottomLeft: quadPoint(a, u0, v1),
  };
}

/* The lines an alignment overlay draws: every interior grid line plus the
   border, as pairs of points. Interior lines are sampled along their length
   rather than drawn corner to corner, because on a non-parallelogram quad a
   grid line is not straight in image space. */
export function gridLines(
  a: GridAlignment,
  rows: number,
  cols: number,
  samples = 8,
): Array<Point[]> {
  const lines: Array<Point[]> = [];
  const step = 1 / samples;

  for (let col = 0; col <= cols; col++) {
    const u = col / cols;
    const line: Point[] = [];
    for (let s = 0; s <= samples; s++) line.push(quadPoint(a, u, s * step));
    lines.push(line);
  }
  for (let row = 0; row <= rows; row++) {
    const v = row / rows;
    const line: Point[] = [];
    for (let s = 0; s <= samples; s++) line.push(quadPoint(a, s * step, v));
    lines.push(line);
  }
  return lines;
}

/* A sane starting alignment: the full image, inset slightly so all four
   handles are visible and grabbable rather than pinned in the corners. */
export function defaultAlignment(inset = 0.06): GridAlignment {
  const lo = inset;
  const hi = 1 - inset;
  return {
    topLeft: { x: lo, y: lo },
    topRight: { x: hi, y: lo },
    bottomRight: { x: hi, y: hi },
    bottomLeft: { x: lo, y: hi },
  };
}
