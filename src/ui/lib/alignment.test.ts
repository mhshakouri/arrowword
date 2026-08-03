/* A1's named automated check: the alignment math, per docs/SPEC.md section 12.

   Runs on Node's built-in test runner with native TypeScript, so this needs no
   test framework and no bundler. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GridAlignment, Point } from "../../types";
import {
  cellQuad,
  defaultAlignment,
  gridLines,
  quadPoint,
} from "./alignment.ts";

/* The unit square, so expected values are readable by inspection. */
const unit: GridAlignment = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomRight: { x: 1, y: 1 },
  bottomLeft: { x: 0, y: 1 },
};

/* A quad that is tilted and not a parallelogram, so any test passing on the
   unit square for the wrong reason fails here. */
const skewed: GridAlignment = {
  topLeft: { x: 0.1, y: 0.2 },
  topRight: { x: 0.9, y: 0.05 },
  bottomRight: { x: 0.95, y: 0.9 },
  bottomLeft: { x: 0.05, y: 0.8 },
};

const near = (actual: Point, expected: Point, what: string) => {
  assert.ok(
    Math.abs(actual.x - expected.x) < 1e-9 &&
      Math.abs(actual.y - expected.y) < 1e-9,
    `${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
};

test("the four corners map exactly to the four alignment points", () => {
  for (const a of [unit, skewed]) {
    near(quadPoint(a, 0, 0), a.topLeft, "topLeft");
    near(quadPoint(a, 1, 0), a.topRight, "topRight");
    near(quadPoint(a, 0, 1), a.bottomLeft, "bottomLeft");
    near(quadPoint(a, 1, 1), a.bottomRight, "bottomRight");
  }
});

test("edge midpoints are the midpoints of the corresponding edges", () => {
  const mid = (p: Point, q: Point): Point => ({
    x: (p.x + q.x) / 2,
    y: (p.y + q.y) / 2,
  });
  near(quadPoint(skewed, 0.5, 0), mid(skewed.topLeft, skewed.topRight), "top");
  near(
    quadPoint(skewed, 0.5, 1),
    mid(skewed.bottomLeft, skewed.bottomRight),
    "bottom",
  );
  near(
    quadPoint(skewed, 0, 0.5),
    mid(skewed.topLeft, skewed.bottomLeft),
    "left",
  );
  near(
    quadPoint(skewed, 1, 0.5),
    mid(skewed.topRight, skewed.bottomRight),
    "right",
  );
});

test("the center is the average of all four corners", () => {
  const c = quadPoint(skewed, 0.5, 0.5);
  const avg = {
    x:
      (skewed.topLeft.x +
        skewed.topRight.x +
        skewed.bottomRight.x +
        skewed.bottomLeft.x) /
      4,
    y:
      (skewed.topLeft.y +
        skewed.topRight.y +
        skewed.bottomRight.y +
        skewed.bottomLeft.y) /
      4,
  };
  near(c, avg, "center");
});

test("a degenerate quad collapses every point onto itself", () => {
  const p = { x: 0.42, y: 0.42 };
  const collapsed: GridAlignment = {
    topLeft: p,
    topRight: p,
    bottomRight: p,
    bottomLeft: p,
  };
  for (const [u, v] of [
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [0.3, 0.7],
  ] as const) {
    near(quadPoint(collapsed, u, v), p, `u=${u} v=${v}`);
  }
});

test("cellQuad tiles the unit square without gaps or overlap", () => {
  /* A 2x2 grid: the top-left cell is exactly the top-left quarter, and
     neighbours share their edges rather than approximating them. */
  const tl = cellQuad(unit, 2, 2, 0, 0);
  near(tl.topLeft, { x: 0, y: 0 }, "cell 0,0 topLeft");
  near(tl.bottomRight, { x: 0.5, y: 0.5 }, "cell 0,0 bottomRight");

  const tr = cellQuad(unit, 2, 2, 0, 1);
  near(tr.topLeft, tl.topRight, "0,1 shares an edge with 0,0");

  const bl = cellQuad(unit, 2, 2, 1, 0);
  near(bl.topLeft, tl.bottomLeft, "1,0 shares an edge with 0,0");

  const br = cellQuad(unit, 2, 2, 1, 1);
  near(br.bottomRight, { x: 1, y: 1 }, "last cell reaches the far corner");
});

test("cellQuad on a skewed quad still shares edges between neighbours", () => {
  const a = cellQuad(skewed, 3, 4, 1, 1);
  const right = cellQuad(skewed, 3, 4, 1, 2);
  const below = cellQuad(skewed, 3, 4, 2, 1);
  near(a.topRight, right.topLeft, "horizontal neighbour");
  near(a.bottomRight, right.bottomLeft, "horizontal neighbour, lower corner");
  near(a.bottomLeft, below.topLeft, "vertical neighbour");
  near(a.bottomRight, below.topRight, "vertical neighbour, right corner");
});

test("gridLines returns every boundary for the grid, including the border", () => {
  const rows = 3;
  const cols = 4;
  const lines = gridLines(unit, rows, cols, 4);
  /* cols+1 vertical plus rows+1 horizontal. */
  assert.equal(lines.length, cols + 1 + (rows + 1));
  for (const line of lines) assert.equal(line.length, 5, "samples + 1 points");

  /* The first vertical line is the left border, top to bottom. */
  const left = lines[0]!;
  near(left[0]!, { x: 0, y: 0 }, "left border start");
  near(left[4]!, { x: 0, y: 1 }, "left border end");
});

test("defaultAlignment is inset, ordered, and inside the image", () => {
  const a = defaultAlignment();
  for (const p of [a.topLeft, a.topRight, a.bottomRight, a.bottomLeft]) {
    assert.ok(p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1, "inside the image");
  }
  assert.ok(a.topLeft.x < a.topRight.x, "left is left of right");
  assert.ok(a.topLeft.y < a.bottomLeft.y, "top is above bottom");
});
