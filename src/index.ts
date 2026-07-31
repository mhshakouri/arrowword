/// <reference types="@cloudflare/workers-types" />

import {
  emptyDoc,
  type Cell,
  type ClientMessage,
  type GridAlignment,
  type ServerMessage,
  type SessionDoc,
} from "./types";

export interface Env {
  ARROWWORD_SESSION: DurableObjectNamespace;
  PHOTOS: R2Bucket;
  /* Comma-separated. Empty in dev means allow any origin. */
  ALLOWED_ORIGINS?: string;
}

const SESSION_ID = /^[0-9a-f]{32}$/;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

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
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/* Returning a response while an unread request body is still open makes the
   runtime throw "Can't read from request stream after response has been sent",
   which stalls the next request on the connection. Any early return from a
   request that carries a body must drop it first. */
async function discardBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    /* Already consumed or closed. */
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
      const id = newSessionId();
      const stub = env.ARROWWORD_SESSION.get(
        env.ARROWWORD_SESSION.idFromName(id),
      );
      const res = await stub.fetch("https://do/init", { method: "POST" });
      if (!res.ok)
        return new Response("init failed", { status: 500, headers: cors });
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
      const stub = env.ARROWWORD_SESSION.get(
        env.ARROWWORD_SESSION.idFromName(id),
      );
      const res = await stub.fetch(
        new Request(`https://do/${rest}${url.search}`, request),
      );
      /* A 101 response carries the WebSocket and its headers are immutable. */
      if (res.status === 101) return res;
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }

    return new Response("not found", { status: 404, headers: cors });
  },
} satisfies ExportedHandler<Env>;

export class ArrowwordSession implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private async doc(): Promise<SessionDoc | null> {
    return (await this.ctx.storage.get<SessionDoc>("doc")) ?? null;
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    if (path === "init" && request.method === "POST") {
      if (!(await this.doc())) {
        await this.ctx.storage.put("doc", emptyDoc(Date.now()));
      }
      return json({ ok: true });
    }

    const doc = await this.doc();
    if (!doc) {
      await discardBody(request);
      return new Response("no such session", { status: 404 });
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
      if (
        !Array.isArray(cells) ||
        cells.length !== rows ||
        cells.some((r) => r.length !== cols)
      ) {
        return new Response("cells must be rows x cols", { status: 400 });
      }
      if (!body.alignment)
        return new Response("alignment required", { status: 400 });

      const next: SessionDoc = {
        ...doc,
        title: typeof body.title === "string" ? body.title : doc.title,
        rows,
        cols,
        alignment: body.alignment as GridAlignment,
        cells,
        puzzleSaved: true,
      };
      await this.ctx.storage.put("doc", next);
      this.broadcast({ type: "state", doc: next });
      return json({ ok: true });
    }

    if (path === "photo" && request.method === "PUT") {
      const length = Number(request.headers.get("Content-Length") ?? "0");
      if (length > MAX_PHOTO_BYTES) {
        await discardBody(request);
        return new Response("photo too large", { status: 413 });
      }
      const key = `photos/${this.ctx.id.toString()}.jpg`;
      await this.env.PHOTOS.put(key, request.body, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      await this.ctx.storage.put("doc", { ...doc, photoKey: key });
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
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      /* Hibernation: idle sockets cost nothing while the DO sleeps. */
      this.ctx.acceptWebSocket(server);
      server.send(
        JSON.stringify({ type: "state", doc } satisfies ServerMessage),
      );
      const count = this.ctx.getWebSockets().length;
      this.broadcast({ type: "peers", count });
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
      ws.send(
        JSON.stringify({
          type: "error",
          message: "invalid json",
        } satisfies ServerMessage),
      );
      return;
    }

    const doc = await this.doc();
    if (!doc) return;

    const { row, col } = msg as { row: number; col: number };
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    if (row < 0 || col < 0 || row >= doc.rows || col >= doc.cols) return;

    /* Only answer cells are mutable. Prefilled letters live in the puzzle. */
    const cell = doc.cells[row]?.[col];
    if (!cell || cell.type !== "answer") {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "cell is not writable",
        } satisfies ServerMessage),
      );
      return;
    }

    const key = `${row},${col}`;
    const at = Date.now();
    const letters = { ...doc.letters };

    if (msg.type === "set") {
      const ch = typeof msg.ch === "string" ? [...msg.ch] : [];
      if (ch.length !== 1) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "one character per cell",
          } satisfies ServerMessage),
        );
        return;
      }
      letters[key] = { ch: msg.ch, at };
    } else if (msg.type === "clear") {
      delete letters[key];
    } else {
      return;
    }

    await this.ctx.storage.put("doc", { ...doc, letters });
    /* The DO is single threaded, so writes serialize and last write wins. */
    this.broadcast({
      type: "cell",
      row,
      col,
      ch: msg.type === "set" ? msg.ch : null,
      at,
    });
  }

  async webSocketClose(): Promise<void> {
    this.broadcast({
      type: "peers",
      count: this.ctx.getWebSockets().length - 1,
    });
  }
}
