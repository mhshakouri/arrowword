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

/* One run of answer cells in one direction, with the clue that belongs to it.
   Clues live here rather than in `cells` because a generated puzzle has no clue
   cells at all (section 3), and `answer` is deliberately not a secret (ADR-13). */
export interface Entry {
  /* Shared by an across and a down that start at the same cell, which is what
     makes a clue list read as "3. Across" and "3. Down". */
  number: number;
  dir: "across" | "down";
  row: number;
  col: number;
  len: number;
  /* Model output, sanitized on write like any displayed string (invariant 8). */
  clue: string;
  answer: string;
}

/* A session is addressable before it has a grid, which is why generation needs
   two states beyond the two a photo puzzle uses. See section 4. */
export type SessionStatus = "draft" | "generating" | "failed" | "playable";

export interface SessionDoc {
  v: 3;
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
  /* v3, for generated puzzles. Invariant 11 keeps the two kinds apart: a photo
     puzzle carries no entries and no theme, a generated one carries no photo
     and no alignment. */
  source: "photo" | "generated";
  /* Generated puzzles are English only in B3. */
  lang: "fa" | "en";
  /* Empty for photo puzzles. */
  entries: Entry[];
  status: SessionStatus;
  /* User input, sanitized. Null for photo puzzles. */
  theme: string | null;
}

/* Client to server */
export type ClientMessage =
  | { type: "hello"; playerId: string; nickname: string }
  | { type: "set"; row: number; col: number; ch: string }
  | { type: "clear"; row: number; col: number }
  | { type: "voice-join" }
  | { type: "voice-leave" }
  /* `audio` is base64 WAV. `seq` is the sender's own counter, echoed back so a
     client can tell its own clip from someone else's without comparing bytes. */
  | { type: "clip"; seq: number; audio: string };

/* The shape sent in "peers". Deliberately not the whole Player record. */
export interface PeerInfo {
  id: string;
  nickname: string;
  color: number;
}

/* One exchange with the model, kept so it can be shown rather than tailed.

   `prompt` and `reply` are the real strings, truncated. They are model output
   and user input respectively, so both are rendered as text and never as HTML,
   which is invariant 8 applying to the thing that explains invariant 8. */
export interface TraceStep {
  at: number;
  /* Which call this was: the first layout, a repair, or the word list. */
  step: "layout" | "repair" | "words" | "validate" | "pack" | "done";
  detail?: string;
  prompt?: string;
  reply?: string;
  /* Whether the reply parsed, and what the validator said about it. */
  parsed?: boolean;
  problems?: string[];
  ms?: number;
}

/* Who is in the voice room, which is a subset of who is in the session. `mode`
   is "ptt" for every C1 client and exists so C2 can add "live" without changing
   the message shape. */
export interface VoicePeer {
  id: string;
  mode: "ptt" | "live";
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
  | { type: "voice-peers"; players: VoicePeer[] }
  /* Generation, B3. A session is addressable before it has a grid, so these
     arrive on the socket the client already opened rather than on a channel
     invented for them. */
  | { type: "progress"; step: string; attempt: number }
  /* The full record of what was asked and what came back, shown on the page.

     Added 2026-08-04 because every diagnosis of a failed generation until then
     had to go through `wrangler tail` and the author's laptop, which is not a
     thing a visitor can do and was slow even for the person who wrote it. A
     generated puzzle is the one place in this app where a machine makes a
     decision nobody can see, so the decision is shown. */
  | { type: "trace"; steps: TraceStep[] }
  /* The model could not lay out a puzzle. The client packs these and sends the
     result to PUT /session/:id/packed, because Workers Free allows 10 ms of CPU
     per request and search does not fit in that. */
  | {
      type: "pack";
      candidates: Array<{ answer: string; clue: string }>;
      rows: number;
      cols: number;
    }
  /* Success. A `state` message by another name, kept distinct so a client can
     tell "the puzzle you asked for is ready" from "here is the document again". */
  | { type: "generated"; doc: SessionDoc }
  | { type: "failed"; reason: string }
  /* Relayed audio. `from` is stamped by the server from the sending socket's
     own identity and a client-supplied `from` is discarded (invariant 16). The
     server never stores this and never inspects `audio` beyond its size. */
  | { type: "clip"; seq: number; audio: string; from: string; at: number }
  /* `row` and `col` are present whenever the refusal is about a particular cell.
     Without them a client that echoes a write optimistically has to guess which
     pending write was refused, and guessing wrong reverts the wrong cell. */
  | { type: "error"; message: string; row?: number; col?: number };

export function emptyDoc(now: number): SessionDoc {
  return {
    v: 3,
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
    /* A new session is always a photo draft. B3 creates generated sessions by a
       different path rather than by mutating one of these. */
    source: "photo",
    lang: "fa",
    entries: [],
    status: "draft",
    theme: null,
  };
}

/* Every stored document passes through here on read, because section 16 says
   never assume a stored document matches the current type.

   Changed in B1: this is the first bump that runs against live data. When v2
   landed, nothing had ever been deployed, so the v1 path was unreachable and
   its correctness was a claim rather than a fact. It is not any more: real
   sessions exist and a template that never expires exists, and the next read of
   each of them comes through here.

   Written as a chain rather than a switch on purpose. Each step knows only how
   to advance one version, so a v1 document reaches v3 by the same v2 code every
   v2 document uses, and the paths cannot drift apart. The alternative, a direct
   v1-to-v3 branch, is a second implementation of the same upgrade that nothing
   would keep honest. */

type V1Doc = Omit<SessionDoc, "v" | "letters" | V3Field> & {
  v: 1;
  letters: Record<string, { ch: string; at: number; by?: string }>;
};

type V3Field = "source" | "lang" | "entries" | "status" | "theme";

type V2Doc = Omit<SessionDoc, "v" | V3Field> & { v: 2 };

type StoredDoc = SessionDoc | V2Doc | V1Doc;

function v1ToV2(stored: V1Doc): V2Doc {
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
    /* Not `Date.now()`. Expiry slides against this field, and stamping a read
       with the current time would keep resetting the window on every read,
       making an abandoned session immortal for as long as anyone opened it. */
    lastActiveAt: stored.createdAt,
    template: false,
    clonedFrom: null,
  };
}

function v2ToV3(stored: V2Doc): SessionDoc {
  return {
    ...stored,
    v: 3,
    /* Everything that exists today is a Persian photo puzzle, because that is
       the only kind the app could make before B3. */
    source: "photo",
    lang: "fa",
    /* Invariant 11: a photo puzzle carries no entries and no theme. B1 detects
       runs on demand rather than storing them here, so this stays empty for a
       photo puzzle even after run detection exists. */
    entries: [],
    theme: null,
    /* `status` is derived rather than defaulted. A saved puzzle is playable and
       an unsaved one is a draft, which is exactly what `puzzleSaved` already
       encoded; the two must agree or the play screen and the expiry logic would
       disagree about the same session. */
    status: stored.puzzleSaved ? "playable" : "draft",
  };
}

export function migrate(stored: StoredDoc): SessionDoc {
  if (stored.v === 3) return stored;
  if (stored.v === 1) return v2ToV3(v1ToV2(stored));
  return v2ToV3(stored);
}
