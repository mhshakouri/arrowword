/* A0.5 expiry check. Separate from the main acceptance run because retention
   is a worker-wide setting: a window short enough to observe would delete the
   sessions the other checks depend on. This run starts its own worker on its
   own port with a three second window, so a thirty day rule is verified in
   about ten seconds.

   What it proves: that the alarm fires at all, that it deletes the session,
   that it deletes a photo the session owns, and that activity slides the
   window instead of letting it arrive. */
import { spawn } from "node:child_process";

const PORT = 8788;
const BASE = `http://localhost:${PORT}`;
const RETENTION_MS = 3000;
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
  `starting wrangler dev on :${PORT} with RETENTION_MS=${RETENTION_MS} ...`,
);
const worker = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--local",
    "--port",
    String(PORT),
    "--var",
    `RETENTION_MS:${RETENTION_MS}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"], detached: false },
);
let shuttingDown = false;
/* Same reasoning as the acceptance suite: without this, a worker that dies
   mid-run produces an ECONNREFUSED stack and no cause. */
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
    `\nwrangler dev exited before the expiry checks finished (code ${code}, signal ${signal}).`,
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

/* Two consecutive probes, for the reason documented in the acceptance suite. */
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

/* Scoped per run for the same reason as the acceptance suite: local Durable
   Object state persists between runs and a fixed caller would inherit a spent
   rate-limit window. */
const RUN = `e${Date.now().toString(36)}`;

const as = (ip, init = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Forwarded-For": ip },
});

async function newSession(ip) {
  const res = await req(`${BASE}/session`, as(ip, { method: "POST" }));
  if (!res.ok) throw new Error(`could not create session: ${res.status}`);
  return (await res.json()).id;
}

const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/* A session that is left alone must delete itself, and take its photo with
   it. Waiting well past the window rather than exactly on it, because the
   alarm is scheduled, not instantaneous. */
const abandoned = await newSession(`${RUN}-abandoned`);
await req(
  `${BASE}/session/${abandoned}/photo`,
  as(`${RUN}-abandoned`, {
    method: "PUT",
    body: jpg,
    headers: { "Content-Type": "image/jpeg" },
  }),
);
const beforeExpiry = await req(`${BASE}/session/${abandoned}/photo`);
check("session is alive before the window passes", beforeExpiry.ok);

await sleep(RETENTION_MS + 4000);
const afterExpiry = await req(`${BASE}/session/${abandoned}/photo`);
check(
  "abandoned session expired",
  afterExpiry.status === 404,
  `got ${afterExpiry.status}`,
);

/* Activity has to push the deadline out, or a puzzle solved over several
   evenings would be destroyed mid-solve. Kept busy across more than one
   window, it must survive. */
const busy = await newSession(`${RUN}-busy`);
for (let i = 0; i < 4; i++) {
  await sleep(RETENTION_MS / 2);
  await req(
    `${BASE}/session/${busy}/photo`,
    as(`${RUN}-busy`, {
      method: "PUT",
      body: jpg,
      headers: { "Content-Type": "image/jpeg" },
    }),
  );
}
const stillAlive = await req(`${BASE}/session/${busy}/photo`);
check(
  "activity slides the window",
  stillAlive.ok,
  `survived ${(RETENTION_MS * 2) / 1000}s of use, got ${stillAlive.status}`,
);

console.log(`PASS ${ok.length}`);
for (const t of ok) console.log("  ok   " + t);
if (bad.length) {
  console.log(`\nFAIL ${bad.length}`);
  for (const t of bad) console.log("  FAIL " + t);
}
stopWorker();
process.exit(bad.length ? 1 : 0);
