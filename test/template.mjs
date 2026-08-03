/* Demo template enforcement.

   This is the check A0.5 could not write: it implemented template behavior while
   nothing could create a template, so the state existed and was unreachable.

   Templates are configuration rather than data (ADR-12), which means one cannot
   be made in a single pass: a session is created first with a random id, and is
   named in configuration afterwards. So this run has two phases with a worker
   restart between them, and that is not a workaround. It is the real flow, where
   a puzzle is tagged, its id is copied into config, and the worker is deployed.
   Durable Object state persists in .wrangler between the two, which is what lets
   the session outlive a restart exactly as it outlives a deploy. */
import { spawn } from "node:child_process";

const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const RETENTION_MS = 3000;
const ok = [];
const bad = [];
const check = (name, pass, detail = "") =>
  (pass ? ok : bad).push(`${name}${detail ? ` (${detail})` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN = `tp${Date.now().toString(36)}`;
const as = (ip, init = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Forwarded-For": ip },
});

const ABSENT_ID = "0".repeat(32);
async function isUp() {
  try {
    const res = await fetch(`${BASE}/session/${ABSENT_ID}/photo`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 404 && (await res.text()) === "no such session";
  } catch {
    return false;
  }
}

let worker = null;
let shuttingDown = false;
const workerLog = [];

async function startWorker(vars) {
  shuttingDown = false;
  workerLog.length = 0;
  const args = ["wrangler", "dev", "--port", String(PORT)];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  worker = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"] });
  const keep = (c) => {
    workerLog.push(c.toString());
    if (workerLog.length > 60) workerLog.shift();
  };
  worker.stdout.on("data", keep);
  worker.stderr.on("data", keep);
  worker.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `\nwrangler dev exited before the template checks finished (code ${code}, signal ${signal}).`,
    );
    console.error(`Its last output:\n${workerLog.join("")}`);
    process.exit(1);
  });

  const deadline = Date.now() + 60_000;
  let streak = 0;
  while (streak < 2) {
    streak = (await isUp()) ? streak + 1 : 0;
    if (streak >= 2) break;
    if (Date.now() > deadline) {
      console.error(`wrangler dev did not come up on :${PORT} within 60s`);
      console.error(`Its last output:\n${workerLog.join("")}`);
      stopWorker();
      process.exit(1);
    }
    await sleep(500);
  }
}

function stopWorker() {
  shuttingDown = true;
  if (worker && !worker.killed) worker.kill("SIGTERM");
}

async function restartWorker(vars) {
  stopWorker();
  /* The port has to be free before the next worker binds it. */
  const gone = Date.now() + 15_000;
  while ((await isUp()) && Date.now() < gone) await sleep(250);
  await sleep(500);
  await startWorker(vars);
}

process.on("exit", stopWorker);
process.on("SIGINT", () => {
  stopWorker();
  process.exit(130);
});

const alignment = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomRight: { x: 1, y: 1 },
  bottomLeft: { x: 0, y: 1 },
};
const cells = [
  [{ type: "clue" }, { type: "answer" }],
  [{ type: "answer" }, { type: "prefilled", letter: "ک" }],
];
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function socket(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/session/${id}/ws`);
    ws.messages = [];
    ws.addEventListener("message", (e) => ws.messages.push(JSON.parse(e.data)));
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("socket failed")));
    setTimeout(() => reject(new Error("socket timed out")), 10_000);
  });
}

async function eventually(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

async function hello(ws, playerId, nickname) {
  ws.send(JSON.stringify({ type: "hello", playerId, nickname }));
  await sleep(250);
  ws.messages.length = 0;
}

/* ---- Phase one: an ordinary puzzle, made the way anyone would ---- */

console.log(`starting wrangler dev on :${PORT}, no templates configured ...`);
await startWorker({ RETENTION_MS });
console.log("worker ready\n");

const author = `${RUN}-author`;
const id = (
  await (await fetch(`${BASE}/session`, as(author, { method: "POST" }))).json()
).id;
await fetch(
  `${BASE}/session/${id}/photo`,
  as(author, {
    method: "PUT",
    body: jpg,
    headers: { "Content-Type": "image/jpeg" },
  }),
);
await fetch(
  `${BASE}/session/${id}/puzzle`,
  as(author, {
    method: "PUT",
    body: JSON.stringify({ title: "Demo", rows: 2, cols: 2, alignment, cells }),
    headers: { "Content-Type": "application/json" },
  }),
);

/* Writable while ordinary, which is what makes the same check after the restart
   mean something rather than being vacuously true. */
const beforeWs = await socket(id);
await hello(beforeWs, "1".repeat(32), "Author");
beforeWs.send(JSON.stringify({ type: "set", row: 0, col: 1, ch: "م" }));
const wroteBefore = await eventually(() =>
  beforeWs.messages.find((m) => m.type === "cell"),
);
check("an ordinary saved puzzle accepts a letter", wroteBefore?.ch === "م");
beforeWs.close();

/* ---- Phase two: name it in configuration, restart, and it is a template ---- */

console.log(`\nrestarting with TEMPLATE_SESSIONS set to that puzzle ...`);
await restartWorker({ RETENTION_MS, TEMPLATE_SESSIONS: id });
console.log("worker ready\n");

check(
  "the puzzle survived the restart",
  (await fetch(`${BASE}/session/${id}/photo`)).status === 200,
);

const templateWs = await socket(id);
const templateState = await eventually(() =>
  templateWs.messages.find((m) => m.type === "state"),
);
check(
  "configuration alone made it a template",
  templateState?.doc?.template === true,
);

await hello(templateWs, "2".repeat(32), "Visitor");
templateWs.send(JSON.stringify({ type: "set", row: 0, col: 1, ch: "ب" }));
const refused = await eventually(() =>
  templateWs.messages.find(
    (m) => m.type === "error" && m.message === "this puzzle is read only",
  ),
);
check("a write to a template is refused", refused !== null);
templateWs.close();

const deleteTemplate = await fetch(
  `${BASE}/session/${id}`,
  as(author, { method: "DELETE" }),
);
check(
  "deleting a template is refused",
  deleteTemplate.status === 403,
  `got ${deleteTemplate.status}`,
);

/* ---- Cloning gives an ordinary, playable session ---- */

const cloneRes = await fetch(
  `${BASE}/session/${id}/clone`,
  as(`${RUN}-visitor`, { method: "POST" }),
);
const cloneId = cloneRes.ok ? (await cloneRes.json()).id : null;
check(
  "a template can be cloned",
  cloneRes.ok && /^[0-9a-f]{32}$/.test(cloneId),
);

const cloneWs = await socket(cloneId);
const cloneDoc = await eventually(
  () => cloneWs.messages.find((m) => m.type === "state")?.doc,
);
check("the clone is not itself a template", cloneDoc?.template === false);
check(
  "the clone has the same grid",
  cloneDoc?.rows === 2 && cloneDoc?.cols === 2,
);
check(
  "the clone starts with no letters",
  cloneDoc && Object.keys(cloneDoc.letters).length === 0,
);
check(
  "the clone records what it came from",
  cloneDoc?.clonedFrom === id,
  `got ${cloneDoc?.clonedFrom}`,
);
check(
  "the clone borrows the template's photo rather than copying it",
  Boolean(cloneDoc?.photoKey) &&
    cloneDoc?.photoKey === templateState?.doc?.photoKey,
);

await hello(cloneWs, "3".repeat(32), "Visitor");
cloneWs.send(JSON.stringify({ type: "set", row: 0, col: 1, ch: "ب" }));
const wroteClone = await eventually(() =>
  cloneWs.messages.find((m) => m.type === "cell"),
);
check("the clone is writable, unlike its template", wroteClone?.ch === "ب");
cloneWs.close();

/* Invariant 6, and the failure that would take the demo down for everyone. */
const deleteClone = await fetch(
  `${BASE}/session/${cloneId}`,
  as(`${RUN}-visitor`, { method: "DELETE" }),
);
check("the clone is deletable", deleteClone.ok, `got ${deleteClone.status}`);
check(
  "deleting the clone leaves the template's photo intact",
  (await fetch(`${BASE}/session/${id}/photo`)).status === 200,
);

/* ---- A template never expires ---- */

await sleep(RETENTION_MS + 4000);
check(
  "the template outlives the retention window",
  (await fetch(`${BASE}/session/${id}/photo`)).status === 200,
);

console.log(`PASS ${ok.length}`);
for (const t of ok) console.log("  ok   " + t);
if (bad.length) {
  console.log(`\nFAIL ${bad.length}`);
  for (const t of bad) console.log("  FAIL " + t);
}
stopWorker();
process.exit(bad.length ? 1 : 0);
