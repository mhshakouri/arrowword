/* Mirrors docs/ARROWWORD.md section 4. Keep the two in sync. */

export type CellType = "dead" | "clue" | "answer" | "prefilled";

export interface Cell {
  type: CellType;
  /* Only when type === "prefilled". A single grapheme, locked in v1. */
  letter?: string;
}

/* Normalized to the photo, each axis 0..1. */
export interface Point {
  x: number;
  y: number;
}

export interface GridAlignment {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export interface SessionDoc {
  v: 1;
  title: string;
  photoKey: string | null;
  rows: number;
  cols: number;
  alignment: GridAlignment | null;
  /* Row-major. Empty until the puzzle is saved. */
  cells: Cell[][];
  /* Key is "row,col". Player input only; prefilled letters live in cells. */
  letters: Record<string, { ch: string; at: number }>;
  createdAt: number;
  /* The puzzle is written once, during setup. */
  puzzleSaved: boolean;
}

/* Client to server */
export type ClientMessage =
  | { type: "set"; row: number; col: number; ch: string }
  | { type: "clear"; row: number; col: number };

/* Server to client */
export type ServerMessage =
  | { type: "state"; doc: SessionDoc }
  | { type: "cell"; row: number; col: number; ch: string | null; at: number }
  | { type: "peers"; count: number }
  | { type: "error"; message: string };

export function emptyDoc(now: number): SessionDoc {
  return {
    v: 1,
    title: "Untitled",
    photoKey: null,
    rows: 0,
    cols: 0,
    alignment: null,
    cells: [],
    letters: {},
    createdAt: now,
    puzzleSaved: false,
  };
}
