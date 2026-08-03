/* A0.5 acceptance test: full session lifecycle, multi-client sync, identity,
   clone, delete, and the limits from spec section 7.

   Runs standalone: if nothing is listening on the port it starts
   `wrangler dev` itself and shuts it down afterwards. If a dev server is
   already running it uses that one and leaves it alone.

   Expiry is not tested here, because retention is a worker-wide setting and a
   short one would delete the sessions these checks rely on. It has its own
   run: test/expiry.mjs. */
import { spawn } from "node:child_process";

const PORT = 8787;
const BASE = `http://localhost:${PORT}`;
const ok = [];
const bad = [];
const check = (name, pass, detail = "") =>
  (pass ? ok : bad).push(`${name}${detail ? ` (${detail})` : ""}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* `wrangler dev` reloads its worker after the initial bundle: the parent process
   stays alive, so nothing exits, but the port refuses connections for a moment
   while it swaps. CI hit that twice, as an uncaught ECONNREFUSED from whichever
   request came next. Readiness checks cannot fix it, because the window can open
   after readiness. So every request tolerates a connection error and retries.

   Only connection errors are retried. An HTTP response, including a failing one,
   is returned untouched: this hides a flaky socket, never a flaky assertion. */
async function req(url, init) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      last = err;
      await sleep(400);
    }
  }
  throw new Error(
    `${url} refused ${8} connection attempts, last: ${last?.message}`,
  );
}

/* Rate limits are per caller, in a fixed one hour window, and `wrangler dev`
   keeps its Durable Object state in .wrangler between runs. A fixed caller id
   would therefore inherit a spent budget from the previous run and fail on the
   second one, so every id is scoped to this run. The limiter treats the value
   as an opaque string, so it does not have to look like an address. */
const RUN = `t${Date.now().toString(36)}`;

/* Under `wrangler dev` CF-Connecting-IP is loopback for every request, so the
   worker falls back to X-Forwarded-For; that is what lets these checks act as
   distinct callers and keep one bucket per concern. See spec section 7. */
const as = (ip, init = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Forwarded-For": ip },
});

/* Readiness must not create a session: POST /session is rate limited, and
   polling it would spend the whole per-IP budget before the worker is even up.
   A GET on a well-formed but absent id still round-trips through the Durable
   Object, so it proves the same liveness without a side effect. */
const ABSENT_ID = "0".repeat(32);
async function isUp() {
  try {
    const res = await fetch(`${BASE}/session/${ABSENT_ID}/photo`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.status !== 404) return false;
    return (await res.text()) === "no such session";
  } catch {
    return false;
  }
}

/* The WebSocket upgrade can lag behind the HTTP listener on a cold worker,
   and a failed connect rejects with a DOM Event, which prints as an
   unreadable object dump. Probe it, and fail with a sentence instead. */
async function wsReady(url) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const up = await new Promise((resolve) => {
      const ws = new WebSocket(url);
      const done = (v) => {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        resolve(v);
      };
      ws.addEventListener("open", () => done(true));
      ws.addEventListener("error", () => done(false));
      setTimeout(() => done(false), 1000);
    });
    if (up) return;
    await sleep(500);
  }
  throw new Error(`WebSocket endpoint never accepted a connection: ${url}`);
}

let worker = null;
let shuttingDown = false;
/* wrangler's own output, kept so that a crash produces a cause instead of an
   opaque ECONNREFUSED stack from whichever fetch happened to be next. CI hit
   exactly that: the worker answered one request, vanished, and the failure said
   nothing about why. */
const workerLog = [];

if (await isUp()) {
  console.log(`using the dev server already on :${PORT}\n`);
} else {
  console.log(`starting wrangler dev on :${PORT} ...`);
  worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const keep = (chunk) => {
    workerLog.push(chunk.toString());
    if (workerLog.length > 60) workerLog.shift();
  };
  worker.stdout.on("data", keep);
  worker.stderr.on("data", keep);
  worker.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `\nwrangler dev exited before the suite finished (code ${code}, signal ${signal}).`,
    );
    console.error(`Its last output:\n${workerLog.join("")}`);
    process.exit(1);
  });

  /* Two consecutive probes, not one. A single success has been observed from a
     worker that then died 140ms later, which read as "ready" and then failed on
     the next request with no explanation. */
  const deadline = Date.now() + 60_000;
  let streak = 0;
  while (streak < 2) {
    streak = (await isUp()) ? streak + 1 : 0;
    if (streak >= 2) break;
    if (Date.now() > deadline) {
      shuttingDown = true;
      worker.kill();
      console.error(`wrangler dev did not come up on :${PORT} within 60s`);
      console.error(`Its last output:\n${workerLog.join("")}`);
      process.exit(1);
    }
    await sleep(500);
  }
  console.log("worker ready\n");
}

const stopWorker = () => {
  shuttingDown = true;
  if (worker && !worker.killed) worker.kill("SIGTERM");
};
process.on("exit", stopWorker);
process.on("SIGINT", () => {
  stopWorker();
  process.exit(130);
});

const MAIN = `${RUN}-main`;

async function newSession(ip = MAIN) {
  const res = await req(`${BASE}/session`, as(ip, { method: "POST" }));
  if (!res.ok) throw new Error(`could not create session: ${res.status}`);
  return (await res.json()).id;
}

const id = await newSession();
check("create session", /^[0-9a-f]{32}$/.test(id), id);

const jpg = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xdb,
  ...new Array(200).fill(7),
  0xff,
  0xd9,
]);
const up = await req(
  `${BASE}/session/${id}/photo`,
  as(MAIN, {
    method: "PUT",
    body: jpg,
    headers: { "Content-Type": "image/jpeg" },
  }),
);
check("upload photo", up.ok);

const got = await req(`${BASE}/session/${id}/photo`);
check(
  "fetch photo",
  got.status === 200 && got.headers.get("content-type") === "image/jpeg",
);

const cells = [
  [{ type: "clue" }, { type: "answer" }],
  [{ type: "answer" }, { type: "prefilled", letter: "ب" }],
];
const puzzle = {
  title: "Test",
  rows: 2,
  cols: 2,
  alignment: {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 1, y: 0 },
    bottomRight: { x: 1, y: 1 },
    bottomLeft: { x: 0, y: 1 },
  },
  cells,
};
const saved = await req(
  `${BASE}/session/${id}/puzzle`,
  as(MAIN, {
    method: "PUT",
    body: JSON.stringify(puzzle),
    headers: { "Content-Type": "application/json" },
  }),
);
check("save puzzle", saved.ok);

const again = await req(
  `${BASE}/session/${id}/puzzle`,
  as(MAIN, {
    method: "PUT",
    body: JSON.stringify(puzzle),
    headers: { "Content-Type": "application/json" },
  }),
);
check("puzzle is write-once", again.status === 409, `got ${again.status}`);

/* The 409 above left an unread body. If that stalls the connection, this hangs. */
const t0 = Date.now();
const afterReject = await req(`${BASE}/session/${id}/photo`);
const elapsed = Date.now() - t0;
check(
  "no stall after rejected write",
  afterReject.ok && elapsed < 2000,
  `${elapsed}ms`,
);

const badId = await req(`${BASE}/session/not-a-real-id/photo`);
check("bad session id rejected", badId.status === 400, `got ${badId.status}`);

/* ---- A2: the puzzle body is validated, and cells are immutable once saved ---- */

/* A2 is the first milestone that produces cells from a UI, and none of this was
   checked before it: invariant 4 makes a saved puzzle permanent, so an unknown
   cell type or a sentence smuggled in as a prefilled letter would have been
   wrong forever and rendered to players. */
const rejects = [
  [
    "unknown cell type",
    [
      [{ type: "clue" }, { type: "answer" }],
      [{ type: "answer" }, { type: "banana" }],
    ],
  ],
  [
    "prefilled letter of two graphemes",
    [
      [{ type: "clue" }, { type: "answer" }],
      [{ type: "answer" }, { type: "prefilled", letter: "به" }],
    ],
  ],
  [
    "prefilled cell with no letter",
    [
      [{ type: "clue" }, { type: "answer" }],
      [{ type: "answer" }, { type: "prefilled" }],
    ],
  ],
  [
    "letter on a cell that is not prefilled",
    [
      [{ type: "clue" }, { type: "answer", letter: "x" }],
      [{ type: "answer" }, { type: "dead" }],
    ],
  ],
];

for (const [what, badCells] of rejects) {
  const target = await newSession();
  const res = await req(
    `${BASE}/session/${target}/puzzle`,
    as(MAIN, {
      method: "PUT",
      body: JSON.stringify({ ...puzzle, cells: badCells }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  check(`rejects ${what}`, res.status === 400, `got ${res.status}`);
}

const badAlignment = await req(
  `${BASE}/session/${await newSession()}/puzzle`,
  as(MAIN, {
    method: "PUT",
    body: JSON.stringify({
      ...puzzle,
      alignment: { ...puzzle.alignment, topLeft: { x: 4, y: 0 } },
    }),
    headers: { "Content-Type": "application/json" },
  }),
);
check(
  "rejects an alignment point outside 0..1",
  badAlignment.status === 400,
  `got ${badAlignment.status}`,
);

const longTitle = await req(
  `${BASE}/session/${await newSession()}/puzzle`,
  as(MAIN, {
    method: "PUT",
    body: JSON.stringify({ ...puzzle, title: "x".repeat(201) }),
    headers: { "Content-Type": "application/json" },
  }),
);
check(
  "rejects a title over 200 characters",
  longTitle.status === 400,
  `got ${longTitle.status}`,
);

/* ---- A0.5: the upload cap is enforced on the stream, not the header ---- */

/* The photo cap has its own run, test/photo-limit.mjs, because testing an 8 MB
   ceiling means moving more than 8 MB and `wrangler dev` does not survive that:
   it dies with an empty error and takes the suite with it. That run starts a
   worker with a 2 KB cap instead, which exercises the same code for a
   thousandth of the bytes. */

/* ---- A0.5: internal Durable Object paths are not publicly reachable ---- */

/* Without the allowlist this would create a session at a chosen id and skip
   the rate limit on POST /session entirely. */
const internal = await req(
  `${BASE}/session/${"a".repeat(32)}/init`,
  as(MAIN, { method: "POST" }),
);
check(
  "internal init path is not reachable",
  internal.status === 404,
  `got ${internal.status}`,
);

const internalDoc = await req(`${BASE}/session/${id}/doc`, as(MAIN));
check(
  "internal doc path is not reachable",
  internalDoc.status === 404,
  `got ${internalDoc.status}`,
);

/* ---- A0.5: clone ---- */

const cloneRes = await req(
  `${BASE}/session/${id}/clone`,
  as(MAIN, { method: "POST" }),
);
const cloneId = cloneRes.ok ? (await cloneRes.json()).id : null;
check("clone a saved puzzle", cloneRes.ok && /^[0-9a-f]{32}$/.test(cloneId));

const draftClone = await req(
  `${BASE}/session/${await newSession()}/clone`,
  as(MAIN, { method: "POST" }),
);
check(
  "clone of an unsaved puzzle refused",
  draftClone.status === 409,
  `got ${draftClone.status}`,
);

/* ---- A0.5: delete ---- */

/* Invariant 6, and the one whose failure loses data for everybody: deleting a
   clone must not delete the photo it borrowed. Without this, a visitor tidying
   up their own throwaway copy would take the shared demo photo down with it,
   and every other clone would render over a hole. The earlier delete check uses
   a session with no photo, so it only ever exercised the ownership test in the
   direction that says yes. */
const borrower = await req(
  `${BASE}/session/${id}/clone`,
  as(MAIN, { method: "POST" }),
);
const borrowerId = borrower.ok ? (await borrower.json()).id : null;
const borrowerDeleted = await req(
  `${BASE}/session/${borrowerId}`,
  as(MAIN, { method: "DELETE" }),
);
check("delete a clone", borrowerDeleted.ok, `got ${borrowerDeleted.status}`);
const sourcePhoto = await req(`${BASE}/session/${id}/photo`);
check(
  "deleting a clone leaves the borrowed photo intact",
  sourcePhoto.status === 200,
  `source photo got ${sourcePhoto.status}`,
);

const doomed = await newSession();
const del = await req(
  `${BASE}/session/${doomed}`,
  as(MAIN, { method: "DELETE" }),
);
check("delete a session", del.ok, `got ${del.status}`);
const afterDelete = await req(`${BASE}/session/${doomed}/photo`);
check(
  "deleted session is gone",
  afterDelete.status === 404,
  `got ${afterDelete.status}`,
);

/* ---- A0.5: per-IP rate limiting ---- */

/* Section 7 allows 10 session creations per IP per hour. The eleventh from a
   caller of its own must be refused, and other callers must be unaffected. */
let burst = null;
for (let i = 0; i < 11; i++) {
  const res = await req(
    `${BASE}/session`,
    as(`${RUN}-burst`, { method: "POST" }),
  );
  if (!res.ok) {
    burst = { attempt: i + 1, status: res.status };
    break;
  }
}
check(
  "session creation rate limited per IP",
  burst?.status === 429 && burst.attempt === 11,
  burst
    ? `refused attempt ${burst.attempt} with ${burst.status}`
    : "never refused",
);

const otherCaller = await req(
  `${BASE}/session`,
  as(`${RUN}-other`, { method: "POST" }),
);
check("rate limit is per IP, not global", otherCaller.ok);

/* ---- WebSocket: identity, sync, attribution ---- */

const wsUrl = `${BASE.replace("http", "ws")}/session/${id}/ws`;
await wsReady(wsUrl);
const connectOnce = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];
    ws.addEventListener("message", (e) => ws.messages.push(JSON.parse(e.data)));
    ws.addEventListener("open", () => resolve(ws));
    /* Reject with a sentence, not a DOM Event. */
    ws.addEventListener("error", () =>
      reject(new Error(`WebSocket failed to connect: ${url}`)),
    );
    setTimeout(
      () => reject(new Error(`WebSocket timed out connecting: ${url}`)),
      10_000,
    );
  });

/* A freshly started wrangler dev serves HTTP, and even runs the Durable
   Object, before the WebSocket upgrade path reliably accepts connections.
   The exact readiness signal is not documented, so retry rather than guess. */
async function open(url) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await connectOnce(url);
    } catch (err) {
      last = err;
      await sleep(600);
    }
  }
  throw last;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const playerA = "1".repeat(32);
const playerB = "2".repeat(32);
const hello = (ws, playerId, nickname) =>
  ws.send(JSON.stringify({ type: "hello", playerId, nickname }));

const a = await open(wsUrl);
await wait(200);
check(
  "client A receives state",
  a.messages.some((m) => m.type === "state"),
);
check(
  "state carries the saved puzzle",
  a.messages.find((m) => m.type === "state")?.doc?.rows === 2,
);

/* Identity is required before writing: a socket that never said hello would
   otherwise produce letters nobody can be credited with. */
a.messages.length = 0;
a.send(JSON.stringify({ type: "set", row: 0, col: 1, ch: "م" }));
await wait(250);
check(
  "write before hello refused",
  a.messages.some(
    (m) => m.type === "error" && m.message === "pick a nickname first",
  ),
);

a.messages.length = 0;
hello(a, playerA, "Hossein");
await wait(250);
check(
  "hello is acknowledged with a player list",
  a.messages.some(
    (m) =>
      m.type === "peers" &&
      m.players.length === 1 &&
      m.players[0].nickname === "Hossein",
  ),
);

/* Nicknames are rendered to other people, so they are capped and stripped. */
const longNick = "x".repeat(40);
const c2 = await open(wsUrl);
await wait(200);
hello(c2, "3".repeat(32), `${longNick}`);
await wait(250);
const capped = c2.messages
  .filter((m) => m.type === "peers")
  .at(-1)
  ?.players.find((p) => p.id === "3".repeat(32));
check(
  "nickname capped at 24 and control chars stripped",
  capped?.nickname === "x".repeat(24),
  `got ${JSON.stringify(capped?.nickname)}`,
);
c2.close();
await wait(200);

const b = await open(wsUrl);
await wait(200);
hello(b, playerB, "Partner");
await wait(300);
check(
  "peers carries every named player",
  a.messages
    .filter((m) => m.type === "peers")
    .at(-1)
    ?.players.some((p) => p.nickname === "Partner"),
);

a.messages.length = 0;
b.messages.length = 0;
b.send(JSON.stringify({ type: "set", row: 0, col: 1, ch: "م" }));
await wait(300);
const cellMsg = a.messages.find((m) => m.type === "cell");
check(
  "A sees B's letter",
  cellMsg?.ch === "م" && cellMsg?.row === 0 && cellMsg?.col === 1,
);
check("letter is attributed to its writer", cellMsg?.by === playerB);

b.send(JSON.stringify({ type: "set", row: 1, col: 1, ch: "x" }));
await wait(200);
check(
  "prefilled cell rejected",
  b.messages.some((m) => m.type === "error"),
);

b.messages.length = 0;
b.send(JSON.stringify({ type: "set", row: 0, col: 1, ch: "ab" }));
await wait(200);
check(
  "multi-character rejected",
  b.messages.some((m) => m.type === "error"),
);

/* One grapheme, not one code point: this is two code points and one letter. */
b.messages.length = 0;
b.send(JSON.stringify({ type: "set", row: 1, col: 0, ch: "سّ" }));
await wait(250);
check(
  "a multi-code-point grapheme is accepted",
  !b.messages.some((m) => m.type === "error"),
);

a.messages.length = 0;
b.send(JSON.stringify({ type: "clear", row: 0, col: 1 }));
await wait(300);
check(
  "clear propagates",
  a.messages.some((m) => m.type === "cell" && m.ch === null),
);

/* Reconnect: a fresh client must see the letters already set. */
b.send(JSON.stringify({ type: "set", row: 1, col: 0, ch: "ک" }));
await wait(300);
const c = await open(wsUrl);
await wait(300);
const state = c.messages.find((m) => m.type === "state");
check(
  "new client sees persisted letters",
  state?.doc?.letters?.["1,0"]?.ch === "ک",
);
check(
  "persisted letters keep their attribution",
  state?.doc?.letters?.["1,0"]?.by === playerB,
);

/* The clone borrowed the template's photo and started empty. */
const cloneState = await req(`${BASE}/session/${cloneId}/photo`);
check("clone serves the borrowed photo", cloneState.ok);
const cloneWs = await open(
  `${BASE.replace("http", "ws")}/session/${cloneId}/ws`,
);
await wait(300);
const cloneDoc = cloneWs.messages.find((m) => m.type === "state")?.doc;
check("clone has the same grid", cloneDoc?.rows === 2 && cloneDoc?.cols === 2);
check(
  "clone starts with no letters",
  cloneDoc && Object.keys(cloneDoc.letters).length === 0,
);
cloneWs.close();

a.close();
b.close();
c.close();
await wait(200);

/* A2's named check: a tagged puzzle survives a round trip through the API,
   prefilled letters included. */
const tagged = await newSession();
const taggedCells = [
  [{ type: "clue" }, { type: "answer" }, { type: "dead" }],
  [{ type: "answer" }, { type: "prefilled", letter: "ک" }, { type: "answer" }],
  [{ type: "dead" }, { type: "answer" }, { type: "clue" }],
];
await req(
  `${BASE}/session/${tagged}/puzzle`,
  as(MAIN, {
    method: "PUT",
    body: JSON.stringify({
      title: "Tagged",
      rows: 3,
      cols: 3,
      alignment: puzzle.alignment,
      cells: taggedCells,
    }),
    headers: { "Content-Type": "application/json" },
  }),
);
await wsReady(`${BASE.replace("http", "ws")}/session/${tagged}/ws`);
const taggedWs = await open(
  `${BASE.replace("http", "ws")}/session/${tagged}/ws`,
);
await wait(300);
const taggedDoc = taggedWs.messages.find((m) => m.type === "state")?.doc;
check(
  "a tagged puzzle reloads with its cells intact",
  JSON.stringify(taggedDoc?.cells) === JSON.stringify(taggedCells),
  `got ${JSON.stringify(taggedDoc?.cells)?.slice(0, 60)}`,
);
check("the title round-trips", taggedDoc?.title === "Tagged");
taggedWs.close();

console.log(`PASS ${ok.length}`);
for (const t of ok) console.log("  ok   " + t);
if (bad.length) {
  console.log(`\nFAIL ${bad.length}`);
  for (const t of bad) console.log("  FAIL " + t);
}
stopWorker();
process.exit(bad.length ? 1 : 0);
