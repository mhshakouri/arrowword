/// <reference types="@cloudflare/workers-types" />

import { generate } from "./generate/loop";
import {
  recordedProvider,
  workersAiProvider,
  type Provider,
} from "./generate/provider";
import * as fixtures from "./generate/fixtures";
import { cellsFrom, validate } from "./generate/validate";
import {
  emptyDoc,
  migrate,
  type Cell,
  type ClientMessage,
  type Entry,
  type GridAlignment,
  type LetterValue,
  type PeerInfo,
  type ServerMessage,
  type SessionDoc,
  type VoicePeer,
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
  /* Comma-separated session ids that are demo templates: never expire, never
     writable, meant to be cloned. Configuration rather than data on purpose, so
     that no request can mint an object exempt from expiry. See ADR-12. */
  TEMPLATE_SESSIONS?: string;
  /* Per-IP hourly ceilings, overridable so they can be tuned without a code
     change and driven down in tests without waiting an hour. Section 7 has the
     defaults and the reasoning. */
  RATE_LIMIT_SESSION?: string;
  RATE_LIMIT_PHOTO?: string;
  RATE_LIMIT_CLONE?: string;
  /* Turnstile, B3. The site key is public and lives in `vars`; this is its
     partner and is set with `wrangler secret put`. Absent means generation
     refuses rather than runs unguarded: failing closed is the only safe
     direction for a check whose whole job is to stop scripts. */
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  /* Workers AI. Absent in tests, which use recorded fixtures instead. */
  AI?: import("./generate/provider").AiBinding;
  /* Generations per day across all callers. Section 7 calls this a measurement
     rather than a decision and leaves it deliberately provisional until one
     puzzle has been generated and its neuron cost read. */
  GENERATION_DAILY_LIMIT?: string;
  RATE_LIMIT_GENERATE?: string;
  /* Test only, and absent from wrangler.jsonc on purpose, exactly like
     RETENTION_MS and MAX_PHOTO_BYTES. Names a recorded fixture set so the
     acceptance suite can drive generation without an API key and without
     spending a neuron. */
  GENERATION_FIXTURES?: string;
  /* "1" logs the model's raw output, truncated. Diagnosis only: section 16
     forbids logging puzzle content, and this is the one thing that would. */
  GENERATION_DEBUG?: string;
}

const SESSION_ID = /^[0-9a-f]{32}$/;
const DEFAULT_MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_NICKNAME_GRAPHEMES = 24;
const MAX_PLAYERS = 50;
const MAX_SOCKETS = 10;
const PALETTE_SIZE = 10;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/* Section 7 voice limits. The room is deliberately smaller than the session:
   ten people can watch a puzzle without anyone minding, and four is where
   talking over each other stops being solvable by taking turns. */
const MAX_VOICE_PLAYERS = 4;
/* 16 kHz mono 16-bit PCM for 8 seconds is 256 KB, and base64 inflates by a
   third. The cap is on the encoded string because that is what arrives. */
const MAX_CLIP_BASE64 = 350 * 1024;
const CLIP_RATE_LIMIT = 6;
const CLIP_RATE_WINDOW_MS = 60_000;
/* The per-socket message ceiling from section 7. It has been in the limits
   table since v6 and had no implementation until C1 needed the same mechanism
   for clips: see "Learned while building C1". */
const MAX_MESSAGES_PER_SECOND = 20;

/* What a socket remembers about itself across hibernation. The DO's memory does
   not survive eviction and these sockets outlive it, so anything per-socket has
   to live here rather than in a field. Attachments are capped at 2 KB, which is
   why the rate windows hold timestamps rather than every message. */
interface SocketState {
  playerId?: string;
  voice?: boolean;
  /* Recent clip send times, newest last, trimmed to the rate window. */
  clips?: number[];
  /* Message times within the current second, for MAX_MESSAGES_PER_SECOND. */
  msgs?: number[];
}

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

/* Section 7 limits. Per IP, one hour fixed window anchored to first use.

   Raised 2026-08-03 from 10, 5 and 30 after the first real measurement: making
   the demo template meant retaking photos, and each attempt spends one session
   and one upload, so five uploads an hour is five attempts an hour for anyone
   framing a photo properly. Section 7 always said these were a starting point
   rather than a measurement, and this is the measurement. */
const RATE_LIMIT_DEFAULTS = {
  session: 30,
  photo: 20,
  clone: 60,
} as const;

const RATE_WINDOW_MS = 3_600_000;
const DAY_MS = 86_400_000;

/* Section 7. Per IP per day, plus Turnstile, because IP alone is a weak key:
   shared NAT punishes the innocent and rotation defeats it. It is not trying to
   stop a determined attacker, it stops accidents and casual repetition.

   Raised 2026-08-04 from 2, by the first real use. Two was chosen when the
   global pool was believed to be 30 a day, and it was wrong twice over: the
   pool is roughly twenty times larger than that, and the first person it
   actually blocked was the author testing his own app on the day it shipped,
   who then routed around it with a VPN. A limit whose first effect is to stop
   the one person who needs to iterate is set too low. Ten still means twelve
   callers cannot drain the day between them. */
const GENERATE_PER_IP_PER_DAY = 10;

/* **Measured 2026-08-04, replacing the invented 30.** Section 7 said the real
   ceiling comes from reading a generation's neuron cost against the 10,000 a
   day Workers AI allows, and guessed it might be five a day or five hundred.

   Observed: about 15 to 20 neurons for a generation whose first layout
   validated, which is one model call. The derivation from there is deliberately
   pessimistic rather than dividing by the happy path:

   - Worst case in this code is four calls: one proposal, two repairs, and the
     word list for the fallback. Call it 80 neurons.
   - 10,000 / 80 is 125 generations even if every one of them takes the longest
     road available.
   - 120, so the app's own ceiling is reached before Cloudflare's. That matters:
     past our limit a caller gets "out of budget for today", and past
     Cloudflare's they get whatever an exhausted allocation produces, which the
     loop can only report as unreachable. The clearer message should come first.

   Four times the old number and still four times below the optimistic estimate,
   which is the right side to be wrong on for a limit whose whole job is that
   the failure is graceful. Raise it with real traffic, not in advance.

   Attempts count rather than successes, since a failed generation spends the
   same neurons as a successful one. */
const GENERATE_PER_DAY = 120;

/* Theme is user input travelling into a prompt, so it is length-capped and
   treated as data. Prompt injection here buys a strange puzzle rather than
   access to anything, which is why a cap is proportionate and nothing heavier
   is needed. Sanitized on the way back out like any displayed string. */
const MAX_THEME = 60;

function rateLimit(env: Env, action: keyof typeof RATE_LIMIT_DEFAULTS): number {
  const override = Number(
    action === "session"
      ? env.RATE_LIMIT_SESSION
      : action === "photo"
        ? env.RATE_LIMIT_PHOTO
        : env.RATE_LIMIT_CLONE,
  );
  return Number.isInteger(override) && override > 0
    ? override
    : RATE_LIMIT_DEFAULTS[action];
}

/* Turnstile, server side. The token the widget produced is exchanged with
   Cloudflare for a yes or no; the token is single use, so a replayed one is
   refused by Cloudflare rather than by us.

   Fails closed in every direction that is not an explicit success: no secret
   configured, no token supplied, a network error, a malformed answer. A bot
   check that opens on failure is decoration. */
async function passedTurnstile(
  env: Env,
  token: unknown,
  ip: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return false;
  if (typeof token !== "string" || !token) return false;
  try {
    const body = new FormData();
    body.append("secret", env.TURNSTILE_SECRET);
    body.append("response", token);
    /* Cloudflare uses this to spot a token minted for one visitor and replayed
       by another. Loopback under `wrangler dev` is not a real address, so it is
       omitted rather than sent as 127.0.0.1. */
    if (ip && !isLoopback(ip)) body.append("remoteip", ip);
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body },
    );
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}

/* Paths a client may reach on a session object. Anything else is internal and
   must not be forwarded, because the worker routes /session/:id/<rest> straight
   through: without this allowlist, `POST /session/:id/init` would let a caller
   create a session at an id of their choosing and skip the rate limit on
   POST /session entirely. */
const PUBLIC_SESSION_PATHS = new Set([
  "photo",
  "puzzle",
  "ws",
  "clone",
  /* B3. The client packs and the server validates, so this carries untrusted
     input exactly like a photo does. */
  "packed",
]);

/* The cell a client message is about, when it is about one and says so
   plausibly. Used for refusals that happen before the coordinates have been
   validated, so that a client can still revert the right optimistic write. */
function cellAt(msg: unknown): { row: number; col: number } | undefined {
  const m = msg as { row?: unknown; col?: unknown };
  return Number.isInteger(m.row) && Number.isInteger(m.col)
    ? { row: m.row as number, col: m.col as number }
    : undefined;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map((s) => s.segment);
}

/* A grapheme that draws nothing is not a letter. A zero-width non-joiner and a
   space are both single graphemes, and a cell holding one looks empty while
   being full, so it reads as untouched and cannot be told apart from a cell
   nobody has answered. Rejected here as well as on the client, because the
   client is not the authority (invariant 14). */
const INVISIBLE_GRAPHEME = /^[\s\p{Cf}\p{Cc}\p{Zs}]+$/u;

function isVisibleGrapheme(value: string): boolean {
  return value.length > 0 && !INVISIBLE_GRAPHEME.test(value);
}

/* Controls and bidi overrides are stripped. ZWNJ (U+200C) and ZWJ (U+200D) are
   deliberately kept: both are format characters, and ZWNJ is load-bearing in
   Persian, so a blanket \p{Cf} strip would mangle real names. */
const NICKNAME_STRIP = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/* Theme and clue are the second and third untrusted strings this app renders to
   people, after nicknames, and one of them is model output rather than human
   input. Invariant 8 is deliberately broad about text for exactly this reason:
   anything displayed is sanitized on write and rendered as text. */
function sanitizeTheme(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return graphemes(raw.replace(NICKNAME_STRIP, "").trim())
    .slice(0, MAX_THEME)
    .join("");
}

/* A generated puzzle's title. Capitalized because it is a heading and a theme
   arrives lowercase more often than not, and falling back to whatever the
   document already had rather than to a constant, so this can never make a
   title worse than it found it. */
function titleFor(theme: string, existing: string): string {
  const cleaned = sanitizeTheme(theme);
  if (!cleaned) return existing;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function sanitizeClue(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return graphemes(raw.replace(NICKNAME_STRIP, "").replace(/\s+/g, " ").trim())
    .slice(0, 120)
    .join("");
}

/* Which model the object talks to. A fixture set named in the environment wins,
   which is how the acceptance suite drives generation with no API key and no
   neurons; section 7 lists this alongside RETENTION_MS and MAX_PHOTO_BYTES as
   test-only and absent from wrangler.jsonc on purpose. */
function providerFor(env: Env): Provider {
  const named = env.GENERATION_FIXTURES;
  if (named) {
    const set = (fixtures as Record<string, unknown>)[named];
    const layouts = (fixtures as Record<string, unknown>)[`${named}_LAYOUTS`];
    return recordedProvider(
      (Array.isArray(set) ? set : [set]) as never,
      (Array.isArray(layouts) ? layouts : layouts ? [layouts] : []) as never,
    );
  }
  if (!env.AI) throw new Error("no generation provider configured");
  return workersAiProvider(env.AI, env.GENERATION_DEBUG === "1");
}

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
          graphemes(cell.letter).length !== 1 ||
          !isVisibleGrapheme(cell.letter)
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
  action: keyof typeof RATE_LIMIT_DEFAULTS,
): Promise<boolean> {
  const limit = rateLimit(env, action);
  const windowMs = RATE_WINDOW_MS;
  const ip = clientIp(request);
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`ip:${ip}`));
  const url = `https://do/take?bucket=${encodeURIComponent(action)}&limit=${limit}&window=${windowMs}`;
  const res = await stub.fetch(url, { method: "POST" });
  return res.ok;
}

function take(
  env: Env,
  key: string,
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<Response> {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
  return stub.fetch(
    `https://do/take?bucket=${encodeURIComponent(bucket)}&limit=${limit}&window=${windowMs}`,
    { method: "POST" },
  );
}

/* Two generations per address per day. A day rather than an hour because the
   thing being rationed refills daily, so an hourly window would let one address
   take twenty-four times its share of a pool that does not refill that fast. */
async function allowGenerate(env: Env, request: Request): Promise<boolean> {
  const override = Number(env.RATE_LIMIT_GENERATE);
  const limit =
    Number.isInteger(override) && override > 0
      ? override
      : GENERATE_PER_IP_PER_DAY;
  const res = await take(
    env,
    `ip:${clientIp(request)}`,
    "generate",
    limit,
    DAY_MS,
  );
  return res.ok;
}

/* Hand back one attempt. Called when generation failed in a way that was not
   the caller's doing, because charging somebody for an outage is the kind of
   small unfairness that makes an app feel broken even when it recovers.

   The global pool is deliberately **not** refunded: those neurons were spent
   whether or not a puzzle came out, which is exactly what section 7 means by
   counting attempts rather than successes. Per IP is a fairness limit and can
   forgive; the global one is an accounting of something already gone. */
async function refundGenerate(env: Env, key: string): Promise<void> {
  if (!key) return;
  const override = Number(env.RATE_LIMIT_GENERATE);
  const limit =
    Number.isInteger(override) && override > 0
      ? override
      : GENERATE_PER_IP_PER_DAY;
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
  await stub.fetch(
    `https://do/take?bucket=generate&limit=${limit}&window=${DAY_MS}&refund=1`,
    { method: "POST" },
  );
}

/* The global pool. One shared counter, keyed by nothing, because the resource
   it protects is shared by everyone: 10,000 neurons a day is a single
   allocation and the failure it prevents is one caller draining the day for
   every visitor after them. Section 7 calls that a denial of service against
   the showcase and worse than a bill, because it cannot be refunded. */
async function allowGlobal(env: Env): Promise<boolean> {
  const override = Number(env.GENERATION_DAILY_LIMIT);
  const limit =
    Number.isInteger(override) && override > 0 ? override : GENERATE_PER_DAY;
  const res = await take(env, "global", "generate-all", limit, DAY_MS);
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

    /* `/generate` is in `run_worker_first`, so every method reaches here,
       including the browser asking for the page. The asset handler never sees
       it, so this hands back the shell deliberately, which is what the ASSETS
       binding was declared for. */
    if (
      request.method === "GET" &&
      parts.length === 1 &&
      parts[0] === "generate"
    ) {
      return env.ASSETS.fetch(
        new Request(new URL("/", request.url), { headers: request.headers }),
      );
    }

    /* Generation. Returns at once with a session id; the work happens inside
       the object and reports over the socket that session already has. Section
       7: a request held open for the 10 to 30 seconds two or three model calls
       take is fragile on a phone and gives the client nothing to render. */
    if (
      request.method === "POST" &&
      parts.length === 1 &&
      parts[0] === "generate"
    ) {
      const body = (await request.json().catch(() => ({}))) as {
        theme?: unknown;
        token?: unknown;
      };

      /* Turnstile before the rate limit, deliberately. The limit is the scarce
         resource here: letting a script spend one of an address's two daily
         attempts just by failing a challenge would turn the bot check into a
         way to lock people out. */
      const ip = clientIp(request);
      if (!(await passedTurnstile(env, body.token, ip))) {
        return new Response("are you a person?", {
          status: 403,
          headers: cors,
        });
      }
      if (!(await allowGenerate(env, request))) {
        return new Response("daily limit reached", {
          status: 429,
          headers: cors,
        });
      }
      /* The global pool, which is the one that fails closed. Attempts count
         rather than successes: a failed generation spends the same neurons. */
      if (!(await allowGlobal(env))) {
        return new Response("out of budget for today", {
          status: 429,
          headers: cors,
        });
      }

      const theme = String(body.theme ?? "")
        .replace(NICKNAME_STRIP, "")
        .trim()
        .slice(0, MAX_THEME);
      if (!theme) {
        return new Response("a theme is required", {
          status: 400,
          headers: cors,
        });
      }

      const id = newSessionId();
      const stub = sessionStub(env, id);
      const started = await stub.fetch("https://do/init", { method: "POST" });
      if (!started.ok) {
        return new Response("init failed", { status: 500, headers: cors });
      }
      /* The object answers as soon as it has marked itself generating, and
         keeps working after. The id is what the client needs to open a socket
         and start watching. */
      const go = await stub.fetch("https://do/generate", {
        method: "POST",
        /* The limiter key travels as an opaque string so the object can hand an
           attempt back without ever learning what it identifies. */
        body: JSON.stringify({ theme, limiterKey: `ip:${clientIp(request)}` }),
        headers: { "Content-Type": "application/json" },
      });
      if (!go.ok) {
        return new Response("could not start", { status: 500, headers: cors });
      }
      return json({ id, theme }, { headers: cors });
    }

    /* What the UI needs to know that only the deploy knows. Kept to exactly
       that: it is public, cached briefly, and must never grow into a place where
       anything sensitive is convenient to put. */
    if (
      request.method === "GET" &&
      parts.length === 1 &&
      parts[0] === "config"
    ) {
      const demo = (env.TEMPLATE_SESSIONS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => SESSION_ID.test(id))[0];
      return json(
        {
          demoSessionId: demo ?? null,
          /* Public by design: the widget cannot render without it. Its partner
             is a secret and never leaves the worker. */
          turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
        },
        {
          headers: {
            ...cors,
            /* Short, so naming a template takes effect without a purge, and
               non-zero, so the landing page does not ask on every view. */
            "Cache-Control": "public, max-age=60",
          },
        },
      );
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

    /* Give one back. Used when a generation failed for a reason that was not
       the caller's: an outage should not spend somebody's daily allowance.

       Only ever decrements an existing window and never below zero, so a
       refund cannot mint attempts, extend a window, or resurrect an expired
       one. The worst a forged refund could do is undo a charge that a real
       request made, and the caller could simply not have made that request. */
    if (url.searchParams.get("refund") === "1") {
      if (record && now - record.windowStart < windowMs) {
        await this.ctx.storage.put(bucket, {
          count: Math.max(0, record.count - 1),
          windowStart: record.windowStart,
        });
      }
      return json({ ok: true });
    }

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
    if (!stored) return null;
    /* `template` is always taken from configuration, never from storage. The
       stored field exists because it is part of the document shape, and its
       value is ignored so that nothing can write itself into being a template. */
    return { ...migrate(stored), template: this.isTemplate() };
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

  /* Whether this object is a configured demo template.

     Derived rather than stored, and derived from the object's *own* identity
     rather than from anything a request carries. `idFromName` is deterministic,
     so comparing each configured session id's derived object id against this
     one answers the question with nothing to forge: no header, no query
     parameter, and no stored flag a write could flip. That is what makes
     "templates are created by hand" true rather than aspirational, since there
     is no code path that turns an ordinary session into one. */
  private isTemplate(): boolean {
    const configured = (this.env.TEMPLATE_SESSIONS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => SESSION_ID.test(id));
    if (configured.length === 0) return false;
    const own = this.ctx.id.toString();
    return configured.some(
      (id) => this.env.ARROWWORD_SESSION.idFromName(id).toString() === own,
    );
  }

  /* Invariant 6: a session owns exactly the object keyed by its own id, so a
     clone that borrowed a template's photo can never delete it. */
  private ownedPhotoKey(doc: SessionDoc): string | null {
    const own = `photos/${this.ctx.id.toString()}.jpg`;
    return doc.photoKey === own ? own : null;
  }

  /* Every read of per-socket state goes through here, so the shape is asserted
     in exactly one place rather than at each call site. */
  private state(ws: WebSocket): SocketState {
    return (ws.deserializeAttachment() as SocketState | null) ?? {};
  }

  private setState(ws: WebSocket, patch: Partial<SocketState>): SocketState {
    const next = { ...this.state(ws), ...patch };
    ws.serializeAttachment(next);
    return next;
  }

  /* One entry per player in voice, not one per socket: the same person with two
     tabs open is one voice participant, which is also what makes the room cap
     count people rather than connections. */
  private voicePeers(except?: WebSocket): VoicePeer[] {
    const out: VoicePeer[] = [];
    const seen = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const { playerId, voice } = this.state(ws);
      if (!playerId || !voice || seen.has(playerId)) continue;
      seen.add(playerId);
      out.push({ id: playerId, mode: "ptt" });
    }
    return out;
  }

  /* Invariant 17: a payload reaches only sockets that opted into voice. A
     spectator, and a player who never joined, receive nothing. */
  private broadcastVoice(message: ServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const { playerId, voice } = this.state(ws);
      if (!playerId || !voice) continue;
      try {
        ws.send(payload);
      } catch {
        /* Gone already; webSocketClose will tidy up. */
      }
    }
  }

  private peers(doc: SessionDoc, except?: WebSocket): PeerInfo[] {
    const out: PeerInfo[] = [];
    const seen = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const playerId = this.state(ws).playerId;
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

  /* `at` names the cell when the refusal is about one, so a client can revert
     exactly the optimistic write that was refused rather than the most recent. */
  private fail(
    ws: WebSocket,
    message: string,
    at?: { row: number; col: number },
  ): void {
    ws.send(
      JSON.stringify({
        type: "error",
        message,
        ...(at ?? {}),
      } satisfies ServerMessage),
    );
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
        /* v3. These two describe one session from two angles and must never
           disagree: the play screen reads `status`, expiry and invariant 4 read
           `puzzleSaved`. Set together, always. */
        status: "playable",
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
        /* Set with `puzzleSaved`, never apart from it. See the clone path. */
        status: "playable",
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

    /* Generation. Marks the session and answers immediately, then keeps
       working: `waitUntil` is what stops the object being collected between the
       response and the model coming back. */
    if (path === "generate" && request.method === "POST") {
      if (doc.puzzleSaved) {
        return new Response("puzzle already saved", { status: 409 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        theme?: unknown;
        limiterKey?: unknown;
      };
      const theme = sanitizeTheme(body.theme);
      if (!theme) return new Response("a theme is required", { status: 400 });
      const limiterKey =
        typeof body.limiterKey === "string" ? body.limiterKey : "";

      await this.save(
        {
          ...doc,
          source: "generated",
          lang: "en",
          status: "generating",
          theme,
          /* Named now, not on success. A session is addressable the moment it
             exists, so a title assigned only when generation finishes leaves
             every generating and every failed puzzle called "Untitled",
             including in the visitor's own list of what they have opened. The
             theme is known here and is the only name this puzzle will get. */
          title: titleFor(theme, doc.title),
        },
        false,
      );
      this.ctx.waitUntil(this.runGeneration(theme, limiterKey));
      return json({ ok: true });
    }

    /* The client packed a grid. Untrusted input exactly like a photo: the whole
       point of moving the search outward was to move the CPU, not the trust. */
    if (path === "packed" && request.method === "PUT") {
      if (doc.puzzleSaved) {
        return new Response("puzzle already saved", { status: 409 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        rows?: unknown;
        cols?: unknown;
        entries?: unknown;
      };
      const rows = Number(body.rows);
      const cols = Number(body.cols);
      const entries = Array.isArray(body.entries)
        ? (body.entries as Entry[])
        : [];
      if (!Number.isInteger(rows) || !Number.isInteger(cols)) {
        return new Response("rows and cols are required", { status: 400 });
      }

      const cells = cellsFrom(entries, rows, cols);
      const checked = validate(cells, entries);
      if (!checked.ok) {
        /* 422 naming the failing rule, per the error contract. The validator's
           own detail strings, because they name cells and letters and a client
           that gets "invalid" learns nothing it can act on. */
        return json(
          { error: "grid did not validate", problems: checked.rejections },
          { status: 422 },
        );
      }

      const next = await this.save({
        ...doc,
        /* Same reasoning as the layout path: the theme is the only name a
           generated puzzle ever gets. */
        title: titleFor(doc.theme ?? "", doc.title),
        rows,
        cols,
        cells,
        entries: entries.map((e) => ({ ...e, clue: sanitizeClue(e.clue) })),
        puzzleSaved: true,
        status: "playable",
      });
      /* The request is answered, so it must not be replayed to the next socket
         that connects. */
      await this.ctx.storage.delete("pendingPack");
      this.broadcast({ type: "generated", doc: next });
      return json({ ok: true });
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
        /* Accepted and then refused, rather than declining the upgrade with a
           503. A refused upgrade reaches the browser as an "error" event with no
           status and no body, so the client cannot tell a full session from
           being offline, and section 13 rule 4 wants a state that says which.
           An error frame carries the reason.

           Deliberately `server.accept()` rather than `ctx.acceptWebSocket`: this
           socket is never tracked, so refusing does not itself consume a slot. */
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].send(
          JSON.stringify({
            type: "error",
            message: "session full",
          } satisfies ServerMessage),
        );
        pair[1].close(1013, "session full");
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      /* Hibernation: idle sockets cost nothing while the DO sleeps. */
      this.ctx.acceptWebSocket(server);
      server.send(
        JSON.stringify({ type: "state", doc } satisfies ServerMessage),
      );
      /* A generation that finished before anyone was listening left its request
         in storage rather than only on the wire. Replayed here so a client that
         arrives late is asked to pack exactly as one that was already
         connected would have been. */
      if (doc.status === "generating") {
        const pending = await this.ctx.storage.get<{
          candidates: Array<{ answer: string; clue: string }>;
          rows: number;
          cols: number;
        }>("pendingPack");
        if (pending) {
          server.send(
            JSON.stringify({
              type: "pack",
              ...pending,
            } satisfies ServerMessage),
          );
        }
      }
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

    /* Before parsing, because parsing a flood is most of the cost of a flood.
       Section 7 has capped this since v6 and nothing enforced it until C1. */
    const now = Date.now();
    const msgs = [...(this.state(ws).msgs ?? []), now].filter(
      (t) => now - t < 1000,
    );
    this.setState(ws, { msgs });
    if (msgs.length > MAX_MESSAGES_PER_SECOND) {
      this.fail(ws, "slow down");
      return;
    }

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
      this.setState(ws, { playerId });
      /* Joining is not solving, so it does not slide the expiry window. */
      const next = await this.save({ ...doc, players }, false);
      this.broadcast({ type: "peers", players: this.peers(next) });
      return;
    }

    const by = this.state(ws).playerId;
    if (!by) {
      this.fail(ws, "pick a nickname first", cellAt(msg));
      return;
    }

    /* Voice. Deliberately above the template check: a read-only demo puzzle
       still lets the people looking at it talk, because talking is not a write
       to the puzzle and invariant 7 is about letters. */
    if (msg.type === "voice-join") {
      const room = this.voicePeers();
      if (!room.some((p) => p.id === by) && room.length >= MAX_VOICE_PLAYERS) {
        this.fail(ws, "voice is full");
        return;
      }
      this.setState(ws, { voice: true });
      this.broadcastVoice({ type: "voice-peers", players: this.voicePeers() });
      return;
    }

    if (msg.type === "voice-leave") {
      /* Told before the flag drops, so the leaver's own client learns the room
         it just left and can render an empty state rather than a stale one. */
      this.setState(ws, { voice: false, clips: [] });
      this.broadcastVoice({ type: "voice-peers", players: this.voicePeers() });
      ws.send(
        JSON.stringify({
          type: "voice-peers",
          players: [],
        } satisfies ServerMessage),
      );
      return;
    }

    if (msg.type === "clip") {
      if (!this.state(ws).voice) {
        this.fail(ws, "join voice before talking");
        return;
      }
      if (typeof msg.audio !== "string" || !msg.audio) {
        this.fail(ws, "clip has no audio");
        return;
      }
      if (msg.audio.length > MAX_CLIP_BASE64) {
        this.fail(ws, "clip is too long");
        return;
      }
      const recent = (this.state(ws).clips ?? []).filter(
        (t) => now - t < CLIP_RATE_WINDOW_MS,
      );
      if (recent.length >= CLIP_RATE_LIMIT) {
        this.fail(ws, "too many clips, wait a moment");
        return;
      }
      this.setState(ws, { clips: [...recent, now] });
      /* Invariant 15: relayed and dropped. Nothing is written, here or
         anywhere, and `save` is deliberately not called: a clip is not activity
         on the puzzle and must not slide the expiry window either.

         Invariant 16: `from` is this socket's own identity. Whatever the client
         put in the message was discarded when it was parsed as a `clip`, which
         carries no `from` field at all. */
      this.broadcastVoice(
        {
          type: "clip",
          seq: Number.isInteger(msg.seq) ? msg.seq : 0,
          audio: msg.audio,
          from: by,
          at: now,
        },
        ws,
      );
      return;
    }
    if (doc.template) {
      this.fail(ws, "this puzzle is read only", cellAt(msg));
      return;
    }

    const { row, col } = msg as { row: number; col: number };
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    if (row < 0 || col < 0 || row >= doc.rows || col >= doc.cols) return;

    /* Only answer cells are mutable. Prefilled letters live in the puzzle. */
    const cell = doc.cells[row]?.[col];
    if (!cell || cell.type !== "answer") {
      this.fail(ws, "cell is not writable", { row, col });
      return;
    }

    const key = `${row},${col}`;
    const at = Date.now();
    const letters: Record<string, LetterValue> = { ...doc.letters };

    if (msg.type === "set") {
      /* Invariant 5 is one grapheme, not one code point: a Persian letter with
         a combining mark is several code points and one grapheme. */
      if (typeof msg.ch !== "string" || graphemes(msg.ch).length !== 1) {
        this.fail(ws, "one character per cell", { row, col });
        return;
      }
      if (!isVisibleGrapheme(msg.ch)) {
        this.fail(ws, "that character would not show", { row, col });
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

  /* The generation run, detached from the request that started it. Everything
     it reports goes over the session's existing socket, so a client that
     connects late still gets the terminal state from the document.

     Never throws. A generation that fails is a session in `failed`, which is a
     user-facing state offering a fresh attempt, not an unhandled rejection in a
     detached promise where nobody would ever see it. */
  private async runGeneration(theme: string, limiterKey = ""): Promise<void> {
    try {
      const provider = providerFor(this.env);
      const outcome = await generate(provider, theme, {
        onProgress: (p) =>
          this.broadcast({
            type: "progress",
            step: p.step,
            attempt: p.attempt,
          }),
      });

      const doc = await this.doc();
      if (!doc) return;

      /* Section 16: log enough to answer "why did this session fail" without
         logging puzzle content. The outcome and the reason are exactly that,
         and B3 shipped without them, which is why the first real failure was
         invisible. No session id: it is the credential (section 16). */
      console.log(
        JSON.stringify({
          at: "generate",
          outcome: outcome.status,
          themeChars: theme.length,
          ...(outcome.status === "failed" ? { reason: outcome.reason } : {}),
          ...(outcome.status === "pack"
            ? { candidates: outcome.candidates.length }
            : {}),
          ...(outcome.status === "playable"
            ? { entries: outcome.entries.length }
            : {}),
        }),
      );

      if (outcome.status === "playable") {
        const cells = cellsFrom(outcome.entries, outcome.rows, outcome.cols);
        const next = await this.save({
          ...doc,
          /* Named for its theme. A generated puzzle has no photo to recognize
             it by and no person to type a title, so "Untitled" would be every
             one of them in the visitor's own list. */
          title: titleFor(theme, doc.title),
          rows: outcome.rows,
          cols: outcome.cols,
          cells,
          entries: outcome.entries.map((e) => ({
            ...e,
            clue: sanitizeClue(e.clue),
          })),
          puzzleSaved: true,
          status: "playable",
        });
        this.broadcast({ type: "generated", doc: next });
        return;
      }

      if (outcome.status === "pack") {
        /* Handed outward rather than done here: Workers Free allows 10 ms of
           CPU per request and search does not fit.

           Stored before it is broadcast, and that ordering is the whole point.
           Generation finishes whenever it finishes, and the client that asked
           for it is still navigating to the session when it does. A broadcast
           alone reaches whoever happens to be connected, which on a fast
           generation is nobody, and the session would then sit in `generating`
           holding a word list no one was ever told about until it expired.
           Storing it means any socket that connects afterwards is handed the
           same request. */
        const pending = {
          candidates: outcome.candidates,
          rows: outcome.rows,
          cols: outcome.cols,
        };
        await this.ctx.storage.put("pendingPack", pending);
        this.broadcast({ type: "pack", ...pending });
        return;
      }

      /* Charging somebody for an outage is the kind of small unfairness that
         makes an app feel broken even when it recovers. Only for a reachability
         failure: a theme the model answered and could do nothing with is a real
         attempt and keeps its cost. */
      if (outcome.reason.startsWith("unreachable")) {
        await refundGenerate(this.env, limiterKey);
      }
      await this.save({ ...doc, status: "failed" }, false);
      this.broadcast({ type: "failed", reason: outcome.reason });
    } catch (error) {
      console.log(
        JSON.stringify({
          at: "generate",
          outcome: "threw",
          message: String((error as Error)?.message ?? error).slice(0, 200),
        }),
      );
      /* An exception escaping the loop is never the caller's doing. */
      await refundGenerate(this.env, limiterKey);
      const doc = await this.doc();
      if (doc) await this.save({ ...doc, status: "failed" }, false);
      this.broadcast({
        type: "failed",
        reason: "generation stopped unexpectedly",
      });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const doc = await this.doc();
    if (!doc) return;
    this.broadcast({ type: "peers", players: this.peers(doc, ws) }, ws);
    /* Only when it was in voice, so a spectator leaving does not tell the room
       anything about itself. */
    if (this.state(ws).voice) {
      this.broadcastVoice(
        { type: "voice-peers", players: this.voicePeers(ws) },
        ws,
      );
    }
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
