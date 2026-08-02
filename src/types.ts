/* Mirrors docs/SPEC.md section 4. Keep the two in sync. */

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

export interface Player {
  /* Sanitized on write: see sanitizeNickname and invariant 8. */
  nickname: string;
  /* Index into the UI palette, assigned by join order. */
  color: number;
  firstSeenAt: number;
}

export interface LetterValue {
  ch: string;
  at: number;
  /* The playerId that wrote it. Attribution, not authorization. */
  by: string;
}

export interface SessionDoc {
  v: 2;
  title: string;
  photoKey: string | null;
  rows: number;
  cols: number;
  alignment: GridAlignment | null;
  /* Row-major. Empty until the puzzle is saved. */
  cells: Cell[][];
  /* Key is "row,col". Player input only; prefilled letters live in cells. */
  letters: Record<string, LetterValue>;
  /* Key is the client-generated playerId. Capped by MAX_PLAYERS. */
  players: Record<string, Player>;
  createdAt: number;
  /* Every accepted write bumps this. It is what expiry slides against. */
  lastActiveAt: number;
  /* The puzzle is written once, during setup. */
  puzzleSaved: boolean;
  /* A demo source: never expires, never accepts a letter write. */
  template: boolean;
  /* Template session id when this is a clone. Never a non-template id. */
  clonedFrom: string | null;
}

/* Client to server */
export type ClientMessage =
  | { type: "hello"; playerId: string; nickname: string }
  | { type: "set"; row: number; col: number; ch: string }
  | { type: "clear"; row: number; col: number };

/* The shape sent in "peers". Deliberately not the whole Player record. */
export interface PeerInfo {
  id: string;
  nickname: string;
  color: number;
}

/* Server to client */
export type ServerMessage =
  | { type: "state"; doc: SessionDoc }
  | {
      type: "cell";
      row: number;
      col: number;
      ch: string | null;
      at: number;
      by: string;
    }
  | { type: "peers"; players: PeerInfo[] }
  | { type: "error"; message: string };

export function emptyDoc(now: number): SessionDoc {
  return {
    v: 2,
    title: "Untitled",
    photoKey: null,
    rows: 0,
    cols: 0,
    alignment: null,
    cells: [],
    letters: {},
    players: {},
    createdAt: now,
    lastActiveAt: now,
    puzzleSaved: false,
    template: false,
    clonedFrom: null,
  };
}

/* Every stored document passes through here on read, because section 16 says
   never assume a stored document matches the current type. No v1 document
   exists in production (nothing was ever deployed), so this path is currently
   unreachable in practice. It stays because the next bump will not be. */
type StoredDoc =
  | SessionDoc
  | (Omit<SessionDoc, "v" | "letters"> & {
      v: 1;
      letters: Record<string, { ch: string; at: number; by?: string }>;
    });

export function migrate(stored: StoredDoc): SessionDoc {
  if (stored.v === 2) return stored;

  /* v1 had no attribution. Letters written before identity existed are
     credited to a reserved id rather than dropped or credited to a real
     player, so "who filled what" never lies. */
  const letters: Record<string, LetterValue> = {};
  for (const [key, value] of Object.entries(stored.letters)) {
    letters[key] = { ch: value.ch, at: value.at, by: value.by ?? "anonymous" };
  }

  return {
    ...stored,
    v: 2,
    letters,
    players: {},
    lastActiveAt: stored.createdAt,
    template: false,
    clonedFrom: null,
  };
}
