/* The photo upload ceiling, on its own worker with a tiny cap.

   Separate because the real cap is 8 MB and `wrangler dev` does not survive a
   request body that size: it exits with an empty error and no JS exception, and
   takes whatever suite it is running with it. Six megabytes is fine, so it is
   the emulator's limit rather than the worker's, and production was verified by
   hand. Rather than move megabytes to test arithmetic, this run sets the cap to
   2 KB and moves kilobytes. */
import { spawn } from "node:child_process";

const PORT = 8789;
const BASE = `http://localhost:${PORT}`;
const CAP = 2048;
const ok = [];
const bad = [];
const check = (name, pass, detail = "") =>
  (pass ? ok : bad).push(`${name}${detail ? ` (${detail})` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

console.log(
  `starting wrangler dev on :${PORT} with MAX_PHOTO_BYTES=${CAP} ...`,
);
const worker = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--port",
    String(PORT),
    "--var",
    `MAX_PHOTO_BYTES:${CAP}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"], detached: false },
);
let shuttingDown = false;
const workerLog = [];
const keep = (chunk) => {
  workerLog.push(chunk.toString());
  if (workerLog.length > 60) workerLog.shift();
};
worker.stdout.on("data", keep);
worker.stderr.on("data", keep);
worker.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(
    `\nwrangler dev exited before the photo checks finished (code ${code}, signal ${signal}).`,
  );
  console.error(`Its last output:\n${workerLog.join("")}`);
  process.exit(1);
});
const stopWorker = () => {
  shuttingDown = true;
  if (worker && !worker.killed) worker.kill("SIGTERM");
};
process.on("exit", stopWorker);
process.on("SIGINT", () => {
  stopWorker();
  process.exit(130);
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
console.log("worker ready\n");

const RUN = `p${Date.now().toString(36)}`;
const as = (ip, init = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Forwarded-For": ip },
});

async function newSession(ip) {
  const res = await fetch(`${BASE}/session`, as(ip, { method: "POST" }));
  if (!res.ok) throw new Error(`could not create session: ${res.status}`);
  return (await res.json()).id;
}

async function upload(ip, id, bytes, headers = {}) {
  try {
    const res = await fetch(
      `${BASE}/session/${id}/photo`,
      as(ip, {
        method: "PUT",
        body: new Uint8Array(bytes),
        headers: { "Content-Type": "image/jpeg", ...headers },
      }),
    );
    return res.status;
  } catch (err) {
    /* A body refused part way through may surface as a dropped connection
       rather than a status, which is the runtime's choice and not ours. */
    return `refused the connection: ${err.message}`;
  }
}

const stored = async (id) =>
  (await fetch(`${BASE}/session/${id}/photo`)).status;

/* At the ceiling exactly: accepted, so the cap is a cap and not one byte less. */
const atCap = `${RUN}-at`;
const atCapId = await newSession(atCap);
check(
  "a photo exactly at the cap is accepted",
  (await upload(atCap, atCapId, CAP)) === 200,
);
check("and it is stored", (await stored(atCapId)) === 200);

/* One byte over: refused on the declared length, before the body matters. */
const over = `${RUN}-over`;
const overId = await newSession(over);
const overStatus = await upload(over, overId, CAP + 1);
check(
  "a photo one byte over the cap is refused",
  overStatus === 413,
  `got ${overStatus}`,
);
check("and nothing is stored", (await stored(overId)) === 404);

/* Declares less than it sends. Content-Length is enforced by a
   FixedLengthStream rather than trusted, so the liar is cut off at the length it
   named and nothing lands. */
const liar = `${RUN}-liar`;
const liarId = await newSession(liar);
const liarStatus = await upload(liar, liarId, CAP, { "Content-Length": "100" });
check(
  "a body larger than its declared length does not succeed",
  liarStatus !== 200,
  `got ${liarStatus}`,
);
check("and stores nothing", (await stored(liarId)) === 404);

/* Repeated refusals must not take the worker down. This is the shape that did:
   before uploads streamed, an oversized body killed it within two attempts. */
let survived = true;
for (let i = 0; i < 4; i++) {
  const ip = `${RUN}-flood-${i}`;
  const id = await newSession(ip).catch(() => null);
  if (!id) {
    survived = false;
    break;
  }
  await upload(ip, id, CAP * 4);
}
check(
  "the worker survives repeated oversize uploads",
  survived && (await isUp()),
);

console.log(`PASS ${ok.length}`);
for (const t of ok) console.log("  ok   " + t);
if (bad.length) {
  console.log(`\nFAIL ${bad.length}`);
  for (const t of bad) console.log("  FAIL " + t);
}
stopWorker();
process.exit(bad.length ? 1 : 0);
