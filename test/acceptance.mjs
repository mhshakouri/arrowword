/* A0 acceptance test: full session lifecycle plus two-client sync.

   Runs standalone: if nothing is listening on the port it starts
   `wrangler dev` itself and shuts it down afterwards. If a dev server is
   already running it uses that one and leaves it alone. */
import { spawn } from "node:child_process";

const PORT = 8787;
const BASE = `http://localhost:${PORT}`;
const ok = [];
const bad = [];
const check = (name, pass, detail = "") =>
  (pass ? ok : bad).push(`${name}${detail ? ` (${detail})` : ""}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp() {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

let worker = null;
if (await isUp()) {
  console.log(`using the dev server already on :${PORT}\n`);
} else {
  console.log(`starting wrangler dev on :${PORT} ...`);
  worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    stdio: "ignore",
    detached: false,
  });
  const deadline = Date.now() + 60_000;
  while (!(await isUp())) {
    if (Date.now() > deadline) {
      worker.kill();
      console.error(`wrangler dev did not come up on :${PORT} within 60s`);
      process.exit(1);
    }
    await sleep(500);
  }
  console.log("worker ready\n");
}

const stopWorker = () => {
  if (worker && !worker.killed) worker.kill("SIGTERM");
};
process.on("exit", stopWorker);
process.on("SIGINT", () => {
  stopWorker();
  process.exit(130);
});

const create = await (
  await fetch(`${BASE}/session`, { method: "POST" })
).json();
const id = create.id;
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
const up = await fetch(`${BASE}/session/${id}/photo`, {
  method: "PUT",
  body: jpg,
  headers: { "Content-Type": "image/jpeg" },
});
check("upload photo", up.ok);

const got = await fetch(`${BASE}/session/${id}/photo`);
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
const saved = await fetch(`${BASE}/session/${id}/puzzle`, {
  method: "PUT",
  body: JSON.stringify(puzzle),
  headers: { "Content-Type": "application/json" },
});
check("save puzzle", saved.ok);

const again = await fetch(`${BASE}/session/${id}/puzzle`, {
  method: "PUT",
  body: JSON.stringify(puzzle),
  headers: { "Content-Type": "application/json" },
});
check("puzzle is write-once", again.status === 409, `got ${again.status}`);

/* The 409 above left an unread body. If that stalls the connection, this hangs. */
const t0 = Date.now();
const afterReject = await fetch(`${BASE}/session/${id}/photo`);
const elapsed = Date.now() - t0;
check(
  "no stall after rejected write",
  afterReject.ok && elapsed < 2000,
  `${elapsed}ms`,
);

const badId = await fetch(`${BASE}/session/not-a-real-id/photo`);
check("bad session id rejected", badId.status === 400, `got ${badId.status}`);

/* Two clients on the same session. */
const wsUrl = `${BASE.replace("http", "ws")}/session/${id}/ws`;
const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];
    ws.addEventListener("message", (e) => ws.messages.push(JSON.parse(e.data)));
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", reject);
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

const b = await open(wsUrl);
await wait(300);
check(
  "peers broadcast on join",
  a.messages.some((m) => m.type === "peers" && m.count === 2),
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

a.close();
b.close();
c.close();
await wait(200);

console.log(`PASS ${ok.length}`);
for (const t of ok) console.log("  ok   " + t);
if (bad.length) {
  console.log(`\nFAIL ${bad.length}`);
  for (const t of bad) console.log("  FAIL " + t);
}
stopWorker();
process.exit(bad.length ? 1 : 0);
