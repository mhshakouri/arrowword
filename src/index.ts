/// <reference types="@cloudflare/workers-types" />

import {
  emptyDoc,
  migrate,
  type Cell,
  type ClientMessage,
  type GridAlignment,
  type LetterValue,
  type PeerInfo,
  type ServerMessage,
  type SessionDoc,
} from "./types";

export interface Env {
  ARROWWORD_SESSION: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  PHOTOS: R2Bucket;
  /* The Vite build, served from this same worker. Only reached for paths that
     `run_worker_first` sends here and the worker declines, which today is
     nothing: everything else is answered by the asset worker before this code
     runs. Declared so a future handler can serve the shell deliberately. */
  ASSETS: Fetcher;
  /* Comma-separated. Empty in dev means allow any origin. */
  ALLOWED_ORIGINS?: string;
  /* Milliseconds of inactivity before a session deletes itself. Overridable
     only so the expiry test can run in seconds instead of thirty days; unset
     everywhere else, which is what production runs on. */
  RETENTION_MS?: string;
  /* The photo ceiling, overridable for the same reason: testing an 8 MB cap
     means moving more than 8 MB, and `wrangler dev` does not survive that. Unset
     in production. */
  MAX_PHOTO_BYTES?: string;
}

const SESSION_ID = /^[0-9a-f]{32}$/;
const DEFAULT_MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_NICKNAME_GRAPHEMES = 24;
const MAX_PLAYERS = 50;
const MAX_SOCKETS = 10;
const PALETTE_SIZE = 10;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function maxPhotoBytes(env: Env): number {
  const override = Number(env.MAX_PHOTO_BYTES);
  return Number.isInteger(override) && override > 0
    ? override
    : DEFAULT_MAX_PHOTO_BYTES;
}

function retentionMs(env: Env): number {
  const override = Number(env.RETENTION_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : DEFAULT_RETENTION_MS;
}

/* Section 7 limits. Per IP, fixed window. */
const RATE_LIMITS = {
  session: { limit: 10, windowMs: 3_600_000 },
  photo: { limit: 5, windowMs: 3_600_000 },
  clone: { limit: 30, windowMs: 3_600_000 },
} as const;

/* Paths a client may reach on a session object. Anything else is internal and
   must not be forwarded, because the worker routes /session/:id/<rest> straight
   through: without this allowlist, `POST /session/:id/init` would let a caller
   create a session at an id of their choosing and skip the rate limit on
   POST /session entirely. */
const PUBLIC_SESSION_PATHS = new Set(["photo", "puzzle", "ws", "clone"]);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map((s) => s.segment);
}

/* Controls and bidi overrides are stripped. ZWNJ (U+200C) and ZWJ (U+200D) are
   deliberately kept: both are format characters, and ZWNJ is load-bearing in
   Persian, so a blanket \p{Cf} strip would mangle real names. */
const NICKNAME_STRIP = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

function sanitizeNickname(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(NICKNAME_STRIP, "").trim();
  return graphemes(cleaned).slice(0, MAX_NICKNAME_GRAPHEMES).join("");
}

/* Loopback means nothing is in front of us. `wrangler dev` sets
   CF-Connecting-IP to a loopback address for every request, which would put
   every local caller in one bucket and make per-IP limits untestable. */
function isLoopback(ip: string): boolean {
  return ip === "::1" || ip === "localhost" || ip.startsWith("127.");
}

/* Cloudflare sets CF-Connecting-IP at the edge to the real client address and a
   client cannot forge it, so in production that is the only branch taken.
   X-Forwarded-For is consulted only when there is no edge address or the edge
   address is loopback, which happens under `wrangler dev` and nowhere else:
   Cloudflare never reports a public client as 127.0.0.1. That narrowness is the
   point. Trusting a client-supplied forwarding header in front of a rate limiter
   in production would make the limit opt-in for anyone who reads this file. */
function clientIp(request: Request): string {
  const edge = request.headers.get("CF-Connecting-IP");
  if (edge && !isLoopback(edge)) return edge;
  const forwarded = request.headers.get("X-Forwarded-For");
  return forwarded?.split(",")[0]?.trim() || edge || "local";
}

const CELL_TYPES = new Set(["dead", "clue", "answer", "prefilled"]);
const MAX_TITLE = 200;

/* Cells are stored once and never change (invariant 4), so anything wrong here
   is wrong forever. Until A2 nothing produced cells except a test, and none of
   this was checked: an unknown type, or a whole sentence as a prefilled letter,
   would have been accepted and then rendered to players. */
type CellCheck = { ok: true; cells: Cell[][] } | { ok: false; problem: string };

function checkCells(cells: unknown, rows: number, cols: number): CellCheck {
  if (!Array.isArray(cells) || cells.length !== rows) {
    return { ok: false, problem: "cells must be rows x cols" };
  }
  for (let row = 0; row < rows; row++) {
    const line = cells[row];
    if (!Array.isArray(line) || line.length !== cols) {
      return { ok: false, problem: "cells must be rows x cols" };
    }
    for (let col = 0; col < cols; col++) {
      const cell = line[col] as { type?: unknown; letter?: unknown };
      if (!cell || typeof cell !== "object") {
        return { ok: false, problem: `cell ${row},${col} is not an object` };
      }
      if (typeof cell.type !== "string" || !CELL_TYPES.has(cell.type)) {
        return {
          ok: false,
          problem: `cell ${row},${col} has an unknown type`,
        };
      }
      if (cell.type === "prefilled") {
        /* One grapheme, not one code point: section 9. Same rule the WebSocket
           write path applies to player letters. */
        if (
          typeof cell.letter !== "string" ||
          graphemes(cell.letter).length !== 1
        ) {
          return {
            ok: false,
            problem: `cell ${row},${col} must have exactly one letter`,
          };
        }
      } else if (cell.letter !== undefined) {
        /* Invariant 1 in spirit: a letter on a non-prefilled cell is either a
           mistake or an attempt to smuggle content into a cell nobody can edit. */
        return {
          ok: false,
          problem: `cell ${row},${col} must not carry a letter`,
        };
      }
    }
  }
  /* Sound because every element was just checked, field by field. The cast is
     the narrowing TypeScript cannot derive from a loop. */
  return { ok: true, cells: cells as Cell[][] };
}

function invalidAlignment(alignment: unknown): string | null {
  if (!alignment || typeof alignment !== "object") return "alignment required";
  const corners = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
  const a = alignment as Record<string, { x?: unknown; y?: unknown }>;
  for (const corner of corners) {
    const p = a[corner];
    if (!p || typeof p !== "object") return `alignment.${corner} is missing`;
    for (const axis of ["x", "y"] as const) {
      const v = p[axis];
      /* Normalized to the image, so anything outside 0..1 is meaningless and
         would place cells off the photo. */
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        return `alignment.${corner}.${axis} must be a number from 0 to 1`;
      }
    }
  }
  return null;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const allow =
    allowed.length === 0 || allowed.includes(origin) ? origin || "*" : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/* Returning a response while an unread request body is still open makes the
   runtime throw "Can't read from request stream after response has been sent",
   which stalls the next request on the connection. Any early return from a
   request that carries a body must drop it first. */
/* Returning a response while an unread request body is still open makes the
   runtime throw "Can't read from request stream after response has been sent",
   which stalls the next request on the connection. Any early return from a
   request that carries a body must deal with that body first.

   Read it and throw it away. Do not cancel it. Cancelling a body the client is
   still uploading tears the stream down mid-flight, and that is not merely
   noisy: it can take the whole process down. An oversized upload killed
   `wrangler dev` within two attempts, and shrinking the body did not help, which
   is what showed the size was never the point. Draining always worked.

   The cost accepted is that declining a request means reading what the client
   chose to send. Ingress is not billed, the declared length is already rejected
   before any of this when it exceeds the cap, and the per-IP upload limit bounds
   how often anyone can make us do it. Weighed against a way to stop the worker
   with one request, reading the bytes is clearly the cheaper side. */
async function discardBody(request: Request): Promise<void> {
  const body = request.body;
  if (!body) return;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } catch {
    /* Already consumed, already closed, or cancelled somewhere else. */
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionStub(env: Env, id: string): DurableObjectStub {
  return env.ARROWWORD_SESSION.get(env.ARROWWORD_SESSION.idFromName(id));
}

/* Returns false when the caller is over the limit for this action. */
async function allow(
  env: Env,
  request: Request,
  action: keyof typeof RATE_LIMITS,
): Promise<boolean> {
  const { limit, windowMs } = RATE_LIMITS[action];
  const ip = clientIp(request);
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`ip:${ip}`));
  const url = `https://do/take?bucket=${encodeURIComponent(action)}&limit=${limit}&window=${windowMs}`;
  const res = await stub.fetch(url, { method: "POST" });
  return res.ok;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (
      request.method === "POST" &&
      parts.length === 1 &&
      parts[0] === "session"
    ) {
      if (!(await allow(env, request, "session"))) {
        return new Response("slow down", { status: 429, headers: cors });
      }
      const id = newSessionId();
      const res = await sessionStub(env, id).fetch("https://do/init", {
        method: "POST",
      });
      if (!res.ok)
        return new Response("init failed", { status: 500, headers: cors });
      return json({ id }, { headers: cors });
    }

    /* DELETE /session/:id has only two segments, so it needs its own branch. */
    if (
      request.method === "DELETE" &&
      parts.length === 2 &&
      parts[0] === "session"
    ) {
      const id = parts[1] ?? "";
      if (!SESSION_ID.test(id)) {
        return new Response("bad session id", { status: 400, headers: cors });
      }
      const res = await sessionStub(env, id).fetch("https://do/delete", {
        method: "POST",
      });
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }

    /* Cloning reads one session and writes another, so the worker orchestrates
       it rather than having one Durable Object reach into a second. */
    if (
      request.method === "POST" &&
      parts.length === 3 &&
      parts[0] === "session" &&
      parts[2] === "clone"
    ) {
      const sourceId = parts[1] ?? "";
      if (!SESSION_ID.test(sourceId)) {
        return new Response("bad session id", { status: 400, headers: cors });
      }
      if (!(await allow(env, request, "clone"))) {
        return new Response("slow down", { status: 429, headers: cors });
      }
      const read = await sessionStub(env, sourceId).fetch("https://do/doc");
      if (!read.ok) {
        return new Response("no such session", { status: 404, headers: cors });
      }
      const source = (await read.json()) as SessionDoc;
      if (!source.puzzleSaved) {
        return new Response("puzzle not saved", { status: 409, headers: cors });
      }
      const id = newSessionId();
      const target = sessionStub(env, id);
      await target.fetch("https://do/init", { method: "POST" });
      const adopt = await target.fetch("https://do/adopt", {
        method: "POST",
        body: JSON.stringify({
          title: source.title,
          rows: source.rows,
          cols: source.cols,
          alignment: source.alignment,
          cells: source.cells,
          /* Borrowed, not copied: a clone never owns this object. */
          photoKey: source.photoKey,
          clonedFrom: source.template ? sourceId : source.clonedFrom,
        }),
      });
      if (!adopt.ok) {
        return new Response("clone failed", { status: 500, headers: cors });
      }
      return json({ id }, { headers: cors });
    }

    /* /session/:id/<rest> is handled inside the Durable Object for that id. */
    if (parts[0] === "session" && parts.length >= 3) {
      const id = parts[1] ?? "";
      if (!SESSION_ID.test(id)) {
        await discardBody(request);
        return new Response("bad session id", { status: 400, headers: cors });
      }
      const rest = parts.slice(2).join("/");
      if (!PUBLIC_SESSION_PATHS.has(rest)) {
        await discardBody(request);
        return new Response("not found", { status: 404, headers: cors });
      }
      if (rest === "photo" && request.method === "PUT") {
        if (!(await allow(env, request, "photo"))) {
          await discardBody(request);
          return new Response("slow down", { status: 429, headers: cors });
        }
      }
      const res = await sessionStub(env, id).fetch(
        new Request(`https://do/${rest}${url.search}`, request),
      );
      /* A 101 response carries the WebSocket and its headers are immutable. */
      if (res.status === 101) return res;
      /* The object may have answered without draining the body, which every
         early return in it does on purpose. Cancelling in there cancels the
         object's copy; this incoming request is a separate handle onto the same
         upload, and returning while it is unread throws "Can't read from
         request stream after response has been sent" out here instead. Harmless
         when the body was already consumed. */
      await discardBody(request);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }

    return new Response("not found", { status: 404, headers: cors });
  },
} satisfies ExportedHandler<Env>;

/* One fixed-window counter set per caller IP. Chosen over the native rate
   limiting binding so the acceptance suite can drive it locally: see ADR-9. */
export class RateLimiter implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const bucket = url.searchParams.get("bucket") ?? "";
    const limit = Number(url.searchParams.get("limit"));
    const windowMs = Number(url.searchParams.get("window"));
    if (!bucket || !Number.isFinite(limit) || !Number.isFinite(windowMs)) {
      return new Response("bad limiter request", { status: 400 });
    }

    const now = Date.now();
    const record = await this.ctx.storage.get<{
      count: number;
      windowStart: number;
    }>(bucket);

    /* Counters are worthless once their window has passed, so the object drops
       its own storage rather than accumulating one row per IP forever. */
    await this.ctx.storage.setAlarm(now + windowMs * 2);

    if (!record || now - record.windowStart >= windowMs) {
      await this.ctx.storage.put(bucket, { count: 1, windowStart: now });
      return json({ ok: true });
    }
    if (record.count >= limit) {
      return new Response("slow down", { status: 429 });
    }
    await this.ctx.storage.put(bucket, {
      count: record.count + 1,
      windowStart: record.windowStart,
    });
    return json({ ok: true });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export class ArrowwordSession implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private async doc(): Promise<SessionDoc | null> {
    const stored = await this.ctx.storage.get<SessionDoc>("doc");
    /* Section 16: never assume a stored document matches the current type. */
    return stored ? migrate(stored) : null;
  }

  /* Persist, slide the expiry window, and keep lastActiveAt honest. Templates
     get no alarm at all, which is invariant 7. */
  private async save(doc: SessionDoc, active = true): Promise<SessionDoc> {
    const next = active ? { ...doc, lastActiveAt: Date.now() } : doc;
    await this.ctx.storage.put("doc", next);
    if (!next.template) {
      await this.ctx.storage.setAlarm(Date.now() + retentionMs(this.env));
    }
    return next;
  }

  /* Invariant 6: a session owns exactly the object keyed by its own id, so a
     clone that borrowed a template's photo can never delete it. */
  private ownedPhotoKey(doc: SessionDoc): string | null {
    const own = `photos/${this.ctx.id.toString()}.jpg`;
    return doc.photoKey === own ? own : null;
  }

  private peers(doc: SessionDoc, except?: WebSocket): PeerInfo[] {
    const out: PeerInfo[] = [];
    const seen = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const attachment = ws.deserializeAttachment() as {
        playerId?: string;
      } | null;
      const playerId = attachment?.playerId;
      if (!playerId || seen.has(playerId)) continue;
      const player = doc.players[playerId];
      if (!player) continue;
      seen.add(playerId);
      out.push({
        id: playerId,
        nickname: player.nickname,
        color: player.color,
      });
    }
    return out;
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(payload);
      } catch {
        /* A socket that is already gone will be cleaned up by webSocketClose. */
      }
    }
  }

  private fail(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ type: "error", message } satisfies ServerMessage));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    if (path === "init" && request.method === "POST") {
      if (!(await this.doc())) {
        await this.save(emptyDoc(Date.now()), false);
      }
      return json({ ok: true });
    }

    const doc = await this.doc();
    if (!doc) {
      await discardBody(request);
      return new Response("no such session", { status: 404 });
    }

    /* Internal: the worker reads a source document to clone it. Not reachable
       from outside, because "doc" is not in PUBLIC_SESSION_PATHS. */
    if (path === "doc") return json(doc);

    /* Internal: receives a cloned grid. Write-once still applies. */
    if (path === "adopt" && request.method === "POST") {
      if (doc.puzzleSaved) {
        await discardBody(request);
        return new Response("puzzle already saved", { status: 409 });
      }
      const body = (await request.json()) as Partial<SessionDoc>;
      await this.save({
        ...doc,
        title: typeof body.title === "string" ? body.title : doc.title,
        rows: Number(body.rows),
        cols: Number(body.cols),
        alignment: (body.alignment ?? null) as GridAlignment | null,
        cells: (body.cells ?? []) as Cell[][],
        photoKey: body.photoKey ?? null,
        clonedFrom: body.clonedFrom ?? null,
        /* A clone starts empty: that is the whole point of cloning. */
        letters: {},
        players: {},
        puzzleSaved: true,
      });
      return json({ ok: true });
    }

    if (path === "delete" && request.method === "POST") {
      if (doc.template) {
        return new Response("template is protected", { status: 403 });
      }
      const owned = this.ownedPhotoKey(doc);
      if (owned) await this.env.PHOTOS.delete(owned);
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "session deleted");
        } catch {
          /* Already closed. */
        }
      }
      await this.ctx.storage.deleteAll();
      return json({ ok: true });
    }

    if (path === "puzzle" && request.method === "PUT") {
      if (doc.puzzleSaved) {
        await discardBody(request);
        return new Response("puzzle already saved", { status: 409 });
      }
      let body: Partial<SessionDoc>;
      try {
        body = (await request.json()) as Partial<SessionDoc>;
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      const rows = Number(body.rows);
      const cols = Number(body.cols);
      const cells = body.cells as Cell[][] | undefined;
      if (
        !Number.isInteger(rows) ||
        !Number.isInteger(cols) ||
        rows < 1 ||
        cols < 1
      ) {
        return new Response("rows and cols must be positive integers", {
          status: 400,
        });
      }
      if (rows > 30 || cols > 30) {
        return new Response("rows and cols must be 30 or fewer", {
          status: 400,
        });
      }
      const checked = checkCells(cells, rows, cols);
      if (!checked.ok) return new Response(checked.problem, { status: 400 });

      const alignmentProblem = invalidAlignment(body.alignment);
      if (alignmentProblem)
        return new Response(alignmentProblem, { status: 400 });

      if (typeof body.title === "string" && body.title.length > MAX_TITLE) {
        return new Response(`title must be ${MAX_TITLE} characters or fewer`, {
          status: 400,
        });
      }

      const next = await this.save({
        ...doc,
        title: typeof body.title === "string" ? body.title : doc.title,
        rows,
        cols,
        alignment: body.alignment as GridAlignment,
        cells: checked.cells,
        puzzleSaved: true,
      });
      this.broadcast({ type: "state", doc: next });
      return json({ ok: true });
    }

    if (path === "photo" && request.method === "PUT") {
      if (!request.body) {
        return new Response("photo body required", { status: 400 });
      }

      /* Content-Length is required, and it is a declaration rather than a claim
         we trust: FixedLengthStream below enforces it byte for byte, so a client
         that lies gets an errored stream instead of a stored photo. Requiring it
         is acceptable because every browser sets it for a Blob or a typed array,
         which is what the wizard sends. */
      const declared = Number(request.headers.get("Content-Length"));
      if (!Number.isInteger(declared) || declared <= 0) {
        await discardBody(request);
        return new Response("photo needs a Content-Length", { status: 411 });
      }
      if (declared > maxPhotoBytes(this.env)) {
        await discardBody(request);
        return new Response("photo too large", { status: 413 });
      }

      /* Streamed straight to R2 through a FixedLengthStream, which gives `put`
         the known length it demands while capping how much is ever read.

         This replaces buffering the whole body in memory and cancelling past the
         cap, which was a way to kill the worker: a single 9 MB upload against an
         8 MB ceiling took `wrangler dev` down within two attempts, reproducibly,
         with an empty error. On a public endpoint that is a denial of service
         rather than a flaky test. Nothing is accumulated now, and a liar is cut
         off at the length it declared rather than at the cap. */
      const fixed = new FixedLengthStream(declared);
      /* Not awaited: R2 consumes the readable half while this fills the writable
         half, and awaiting here would deadlock. A rejection is expected whenever
         the body and the declared length disagree, and surfaces below as a
         failed `put`. */
      void request.body.pipeTo(fixed.writable).catch(() => {});

      const key = `photos/${this.ctx.id.toString()}.jpg`;
      try {
        await this.env.PHOTOS.put(key, fixed.readable, {
          httpMetadata: { contentType: "image/jpeg" },
        });
      } catch {
        /* R2 writes are atomic, so a stream that errored stored nothing. */
        return new Response("photo did not match its declared length", {
          status: 400,
        });
      }
      await this.save({ ...doc, photoKey: key });
      return json({ ok: true, photoKey: key });
    }

    if (path === "photo" && request.method === "GET") {
      if (!doc.photoKey) return new Response("no photo yet", { status: 404 });
      const object = await this.env.PHOTOS.get(doc.photoKey);
      if (!object) return new Response("photo missing", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": "image/jpeg",
          /* The photo never changes once set. */
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (path === "ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
        return new Response("session full", { status: 503 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      /* Hibernation: idle sockets cost nothing while the DO sleeps. */
      this.ctx.acceptWebSocket(server);
      server.send(
        JSON.stringify({ type: "state", doc } satisfies ServerMessage),
      );
      /* No peers broadcast yet: this socket has no identity until it says
         hello, and an unnamed socket has nothing to announce. */
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(
    ws: WebSocket,
    raw: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.fail(ws, "invalid json");
      return;
    }

    const doc = await this.doc();
    if (!doc) return;

    if (msg.type === "hello") {
      const playerId = typeof msg.playerId === "string" ? msg.playerId : "";
      const nickname = sanitizeNickname(msg.nickname);
      if (!SESSION_ID.test(playerId) || !nickname) {
        this.fail(ws, "hello needs a player id and a nickname");
        return;
      }
      const players = { ...doc.players };
      const existing = players[playerId];
      if (!existing && Object.keys(players).length >= MAX_PLAYERS) {
        this.fail(ws, "too many players in this puzzle");
        return;
      }
      players[playerId] = {
        nickname,
        color: existing?.color ?? Object.keys(players).length % PALETTE_SIZE,
        firstSeenAt: existing?.firstSeenAt ?? Date.now(),
      };
      ws.serializeAttachment({ playerId });
      /* Joining is not solving, so it does not slide the expiry window. */
      const next = await this.save({ ...doc, players }, false);
      this.broadcast({ type: "peers", players: this.peers(next) });
      return;
    }

    const attachment = ws.deserializeAttachment() as {
      playerId?: string;
    } | null;
    const by = attachment?.playerId;
    if (!by) {
      this.fail(ws, "pick a nickname first");
      return;
    }
    if (doc.template) {
      this.fail(ws, "this puzzle is read only");
      return;
    }

    const { row, col } = msg as { row: number; col: number };
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    if (row < 0 || col < 0 || row >= doc.rows || col >= doc.cols) return;

    /* Only answer cells are mutable. Prefilled letters live in the puzzle. */
    const cell = doc.cells[row]?.[col];
    if (!cell || cell.type !== "answer") {
      this.fail(ws, "cell is not writable");
      return;
    }

    const key = `${row},${col}`;
    const at = Date.now();
    const letters: Record<string, LetterValue> = { ...doc.letters };

    if (msg.type === "set") {
      /* Invariant 5 is one grapheme, not one code point: a Persian letter with
         a combining mark is several code points and one grapheme. */
      if (typeof msg.ch !== "string" || graphemes(msg.ch).length !== 1) {
        this.fail(ws, "one character per cell");
        return;
      }
      letters[key] = { ch: msg.ch, at, by };
    } else if (msg.type === "clear") {
      delete letters[key];
    } else {
      return;
    }

    await this.save({ ...doc, letters });
    /* The DO is single threaded, so writes serialize and last write wins. */
    this.broadcast({
      type: "cell",
      row,
      col,
      ch: msg.type === "set" ? msg.ch : null,
      at,
      by,
    });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const doc = await this.doc();
    if (!doc) return;
    this.broadcast({ type: "peers", players: this.peers(doc, ws) }, ws);
  }

  /* Expiry. At-least-once delivery with retries means this can run twice for
     one session, so every step has to tolerate having already happened:
     deleting an absent R2 object succeeds, and deleteAll on empty storage
     succeeds. No deleteAlarm call: at this worker's compatibility date,
     deleteAll clears the alarm too. */
  async alarm(): Promise<void> {
    const doc = await this.doc();
    if (!doc) return;
    if (doc.template) return;
    const owned = this.ownedPhotoKey(doc);
    if (owned) await this.env.PHOTOS.delete(owned);
    await this.ctx.storage.deleteAll();
  }
}
