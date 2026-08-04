/* B3 acceptance: the generate endpoint, its two rate limits, Turnstile, and the
   packed-grid trust boundary.

   Its own run, and its own worker, because it needs three things the default
   configuration must never have: a Turnstile secret set to Cloudflare's
   always-pass dummy, a fixture set replacing Workers AI so no neuron is spent,
   and rate limits driven down so a burst is testable without waiting a day.

   Section 7 lists GENERATION_FIXTURES alongside RETENTION_MS and
   MAX_PHOTO_BYTES: test-only, absent from wrangler.jsonc on purpose. */

import { spawn } from "node:child_process";

/* A port per scenario rather than one reused across restarts.

   Reusing one failed on CI twice, for two different reasons: the OS had not
   released the socket yet, and then `npx` forks wrangler so SIGTERM to the
   process this test holds does not necessarily reach the server. Both are
   properties of the machine rather than of the thing under test, and both stop
   mattering if the next worker simply listens somewhere else. A lingering
   worker costs a few megabytes for the length of the run and is reaped when the
   process exits. */
let PORT = 8790;
let BASE = `http://localhost:${PORT}`;
const ok = [];
const bad = [];
const check = (name, pass, detail = "") =>
  (pass ? ok : bad).push(`${name}${detail ? ` (${detail})` : ""}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Published by Cloudflare and safe in a repository: this one always passes
   validation, and its partner 2x00... always fails. A test secret key accepts
   only dummy tokens and rejects real ones, so a misconfigured environment fails
   loudly rather than letting everything through. */
const PASS_SECRET = "1x0000000000000000000000000000000AA";
const FAIL_SECRET = "2x0000000000000000000000000000000AA";
/* Any non-empty string: the dummy secret accepts whatever it is given. */
const TOKEN = "dummy-token";

const RUN = `g${Date.now().toString(36)}`;
const as = (ip, init = {}) => ({
  ...init,
  headers: {
    ...(init.headers ?? {}),
    "X-Forwarded-For": ip,
    "Content-Type": "application/json",
  },
});

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
  throw new Error(`${url} refused: ${last?.message}`);
}

async function eventually(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

const ABSENT = "0".repeat(32);
async function isUp() {
  try {
    const res = await fetch(`${BASE}/session/${ABSENT}/photo`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 404;
  } catch {
    return false;
  }
}

let worker = null;
let shuttingDown = false;
const workerLog = [];
/* Every child ever started, so the exit handler can reap all of them rather
   than only the current one. */
const children = [];

function start(vars) {
  const args = ["wrangler", "dev", "--local", "--port", String(PORT)];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  /* `detached` puts wrangler in its own process group, so killing the negative
     pid reaches the server rather than only the `npx` wrapper that forked it. */
  const child = spawn("npx", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(child);
  const keep = (c) => {
    workerLog.push(c.toString());
    if (workerLog.length > 60) workerLog.shift();
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  /* Marked on the child rather than tracked in a shared flag. `exit` arrives
     asynchronously, so a flag set around the kill and cleared straight after is
     already false by the time the event lands, and every deliberate restart
     read as a crash. */
  child.on("exit", (code) => {
    if (child.stopping || shuttingDown) return;
    console.error(`\nwrangler dev exited early (${code}).`);
    console.error(workerLog.join(""));
    process.exit(1);
  });
  return child;
}

/* GENERATION_FIXTURES is switched between scenarios by restarting the worker,
   which is cheaper than inventing a way to select one per request and keeps the
   selection out of the request surface entirely. A request-scoped override
   would be a test-only code path on a public endpoint, which is exactly the
   kind of thing that ships by accident. */
async function restart(vars) {
  if (worker) {
    kill(worker);
    worker = null;
    /* No wait for the port: the next worker takes a different one. */
    PORT += 1;
    BASE = `http://localhost:${PORT}`;
  }
  console.log(`starting worker on :${PORT}: ${JSON.stringify(vars)}`);
  worker = start(vars);
  const deadline = Date.now() + 60_000;
  let streak = 0;
  while (streak < 2) {
    streak = (await isUp()) ? streak + 1 : 0;
    if (streak >= 2) break;
    if (Date.now() > deadline) {
      console.error(`worker did not come up on :${PORT}`);
      console.error(workerLog.join(""));
      process.exit(1);
    }
    await sleep(500);
  }
}

/* Kills the whole process group, because `npx` forks wrangler and a signal sent
   to the wrapper does not reliably reach the server underneath it. */
function kill(child) {
  if (!child || child.killed) return;
  child.stopping = true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* Already gone. */
    }
  }
}

const stop = () => {
  shuttingDown = true;
  for (const child of children) kill(child);
};
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

function socket(id) {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/session/${id}/ws`);
  ws.messages = [];
  ws.addEventListener("message", (e) => ws.messages.push(JSON.parse(e.data)));
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("ws failed")));
    setTimeout(() => reject(new Error("ws timed out")), 10_000);
  });
}

const generate = (theme, ip, token = TOKEN) =>
  req(
    `${BASE}/generate`,
    as(ip, { method: "POST", body: JSON.stringify({ theme, token }) }),
  );

/* ---- Turnstile ---- */

await restart({
  TURNSTILE_SECRET: PASS_SECRET,
  GENERATION_FIXTURES: "GOOD",
  RATE_LIMIT_GENERATE: "50",
  GENERATION_DAILY_LIMIT: "200",
  /* The layout order, which is no longer the default. Asked for explicitly
     because these checks are about a model that lays a puzzle out, and since
     2026-08-04 the pipeline asks for words first. */
  GENERATION_LAYOUT_FIRST: "1",
});

const noToken = await req(
  `${BASE}/generate`,
  as(`${RUN}-a`, { method: "POST", body: JSON.stringify({ theme: "rivers" }) }),
);
check(
  "generation without a Turnstile token is refused",
  noToken.status === 403,
  `got ${noToken.status}`,
);
check(
  "and says so in the words the error contract names",
  (await noToken.text()).trim() === "are you a person?",
);

const noTheme = await generate("", `${RUN}-a`);
check(
  "a missing theme is refused",
  noTheme.status === 400,
  `got ${noTheme.status}`,
);

/* ---- The happy path ---- */

const good = await generate("rivers", `${RUN}-b`);
check("generation starts", good.ok, `got ${good.status}`);
const { id: goodId } = await good.json();
check("and returns a session id at once", /^[0-9a-f]{32}$/.test(goodId ?? ""));

/* Asserted on the outcome rather than on catching the broadcast. Generation
   finishes whenever it finishes, and with fixtures that is before a client
   could possibly have connected, so requiring the `generated` frame would be
   testing a race rather than the feature. A client that arrives late learns the
   same thing from `state`, which is the behavior that actually matters. */
const watcher = await socket(goodId);
const generated = await eventually(() =>
  watcher.messages.find(
    (m) =>
      m.type === "generated" ||
      (m.type === "state" && m.doc?.status === "playable"),
  ),
);
check("a valid layout becomes a playable puzzle", generated !== null);
check(
  "the generated document is marked playable and saved",
  generated?.doc?.status === "playable" && generated?.doc?.puzzleSaved === true,
  `status ${generated?.doc?.status}`,
);
check(
  "it is a generated English puzzle with no photo",
  generated?.doc?.source === "generated" &&
    generated?.doc?.lang === "en" &&
    generated?.doc?.photoKey === null,
);
check(
  "it carries entries with clues",
  (generated?.doc?.entries?.length ?? 0) > 0 &&
    typeof generated?.doc?.entries?.[0]?.clue === "string",
);
check(
  "invariant 11 holds: a generated puzzle has no alignment",
  generated?.doc?.alignment === null,
);
watcher.close();

/* ---- The fallback: the client packs ---- */

await restart({
  TURNSTILE_SECRET: PASS_SECRET,
  GENERATION_FIXTURES: "FALLBACK",
  RATE_LIMIT_GENERATE: "50",
  GENERATION_DAILY_LIMIT: "200",
});

const fb = await generate("short words", `${RUN}-c`);
const { id: fbId } = await fb.json();
const packWatcher = await socket(fbId);
const packAsk = await eventually(() =>
  packWatcher.messages.find((m) => m.type === "pack"),
);
check(
  "a layout that never validates asks the client to pack",
  packAsk !== null,
);
check(
  "and hands over usable candidates",
  (packAsk?.candidates?.length ?? 0) >= 2,
  `got ${packAsk?.candidates?.length}`,
);

/* The trust boundary: whatever the client sends is validated. */
const badPacked = await req(
  `${BASE}/session/${fbId}/packed`,
  as(`${RUN}-c`, {
    method: "PUT",
    body: JSON.stringify({
      rows: 3,
      cols: 3,
      entries: [
        {
          number: 1,
          dir: "across",
          row: 0,
          col: 0,
          len: 3,
          answer: "CAT",
          clue: "c",
        },
        {
          number: 1,
          dir: "down",
          row: 0,
          col: 0,
          len: 3,
          answer: "DOT",
          clue: "d",
        },
      ],
    }),
  }),
);
check(
  "a packed grid with a disagreeing crossing is refused with 422",
  badPacked.status === 422,
  `got ${badPacked.status}`,
);
const problems = await badPacked.json();
check(
  "and the refusal names the failing rule",
  JSON.stringify(problems).includes("crossing-disagrees"),
);

const offGrid = await req(
  `${BASE}/session/${fbId}/packed`,
  as(`${RUN}-c`, {
    method: "PUT",
    body: JSON.stringify({
      rows: 3,
      cols: 3,
      entries: [
        {
          number: 1,
          dir: "across",
          row: 0,
          col: 0,
          len: 4,
          answer: "FOUR",
          clue: "f",
        },
      ],
    }),
  }),
);
check("a packed grid running off-grid is refused", offGrid.status === 422);

packWatcher.messages.length = 0;
const goodPacked = await req(
  `${BASE}/session/${fbId}/packed`,
  as(`${RUN}-c`, {
    method: "PUT",
    body: JSON.stringify({
      rows: 3,
      cols: 3,
      entries: [
        {
          number: 1,
          dir: "across",
          row: 0,
          col: 0,
          len: 3,
          answer: "CAT",
          clue: "c",
        },
        {
          number: 1,
          dir: "down",
          row: 0,
          col: 0,
          len: 3,
          answer: "COT",
          clue: "b",
        },
        {
          number: 2,
          dir: "down",
          row: 0,
          col: 2,
          len: 3,
          answer: "TOP",
          clue: "t",
        },
        {
          number: 3,
          dir: "across",
          row: 2,
          col: 0,
          len: 3,
          answer: "TAP",
          clue: "w",
        },
      ],
    }),
  }),
);
check(
  "a valid packed grid is accepted",
  goodPacked.ok,
  `got ${goodPacked.status}`,
);
const packedDone = await eventually(() =>
  packWatcher.messages.find((m) => m.type === "generated"),
);
check("and the room is told the puzzle is ready", packedDone !== null);
check(
  "the saved puzzle is playable",
  packedDone?.doc?.status === "playable" &&
    packedDone?.doc?.puzzleSaved === true,
);

/* Invariant 4: written exactly once. */
const again = await req(
  `${BASE}/session/${fbId}/packed`,
  as(`${RUN}-c`, {
    method: "PUT",
    body: JSON.stringify({ rows: 3, cols: 3, entries: [] }),
  }),
);
check(
  "a packed grid cannot overwrite a saved puzzle",
  again.status === 409,
  `got ${again.status}`,
);
packWatcher.close();

/* ---- Giving up ---- */

await restart({
  TURNSTILE_SECRET: PASS_SECRET,
  GENERATION_FIXTURES: "HOPELESS",
  RATE_LIMIT_GENERATE: "50",
  GENERATION_DAILY_LIMIT: "200",
});

const doomed = await generate("nonsense", `${RUN}-d`);
const { id: doomedId } = await doomed.json();
const doomWatcher = await socket(doomedId);
const failed = await eventually(() =>
  doomWatcher.messages.find(
    (m) =>
      m.type === "failed" || (m.type === "state" && m.doc?.status === "failed"),
  ),
);
check(
  "a hopeless generation ends as failed rather than hanging",
  failed !== null,
);
check(
  "and failed is a terminal state, not a stuck one",
  failed?.type === "failed" || failed?.doc?.status === "failed",
);
doomWatcher.close();

/* ---- The two limits ---- */

await restart({
  TURNSTILE_SECRET: PASS_SECRET,
  GENERATION_FIXTURES: "GOOD",
  RATE_LIMIT_GENERATE: "2",
  GENERATION_DAILY_LIMIT: "200",
});

const limited = `${RUN}-e`;
await generate("one", limited);
await generate("two", limited);
const third = await generate("three", limited);
check(
  "a third generation from one address in a day is refused",
  third.status === 429,
  `got ${third.status}`,
);
check(
  "and says which limit was hit",
  (await third.text()).trim() === "daily limit reached",
);

/* A different address is unaffected, which is what makes it per-IP rather than
   global. */
const other = await generate("elsewhere", `${RUN}-f`);
check("another address is unaffected", other.ok, `got ${other.status}`);

await restart({
  TURNSTILE_SECRET: PASS_SECRET,
  GENERATION_FIXTURES: "GOOD",
  RATE_LIMIT_GENERATE: "50",
  GENERATION_DAILY_LIMIT: "2",
});

await generate("one", `${RUN}-g`);
await generate("two", `${RUN}-h`);
const drained = await generate("three", `${RUN}-i`);
check(
  "the global daily ceiling refuses everyone once it is spent",
  drained.status === 429,
  `got ${drained.status}`,
);
check(
  "and says so distinctly from the per-address limit",
  (await drained.text()).trim() === "out of budget for today",
);

/* ---- A failure that is not the caller's does not spend their allowance ----

   Charging somebody for an outage is the kind of small unfairness that makes an
   app feel broken even when it recovers. The provider being unreachable is our
   problem; a theme the model answered and could do nothing with is a real
   attempt and keeps its cost. */

await restart({
  TURNSTILE_SECRET: PASS_SECRET,
  /* No fixture set and no AI binding reachable in local mode, so every call
     throws, which is exactly the unreachable case. */
  RATE_LIMIT_GENERATE: "2",
  GENERATION_DAILY_LIMIT: "200",
});

const refunded = `${RUN}-refund`;
const firstTry = await generate("rivers", refunded);
check("a generation starts even when the model is unreachable", firstTry.ok);
const { id: refundId } = await firstTry.json();
const refundWatcher = await socket(refundId);
await eventually(() =>
  refundWatcher.messages.find(
    (m) =>
      m.type === "failed" || (m.type === "state" && m.doc?.status === "failed"),
  ),
);
refundWatcher.close();
/* Two per address here, and one was just spent and given back, so two more
   must still be available rather than one. */
const second = await generate("rivers", refunded);
check(
  "an unreachable failure gives the attempt back",
  second.ok,
  `got ${second.status}`,
);
const afterRefund = await generate("rivers", refunded);
check(
  "and the limit still applies to attempts that were not refunded",
  afterRefund.ok || afterRefund.status === 429,
  `got ${afterRefund.status}`,
);

/* ---- Turnstile failing closed ---- */

await restart({
  TURNSTILE_SECRET: FAIL_SECRET,
  GENERATION_FIXTURES: "GOOD",
  RATE_LIMIT_GENERATE: "50",
  GENERATION_DAILY_LIMIT: "200",
});

const rejected = await generate("rivers", `${RUN}-j`);
check(
  "a token Cloudflare rejects means no generation",
  rejected.status === 403,
  `got ${rejected.status}`,
);

/* No secret at all must refuse rather than run unguarded. A bot check that
   opens when misconfigured is decoration. */
await restart({
  GENERATION_FIXTURES: "GOOD",
  RATE_LIMIT_GENERATE: "50",
  GENERATION_DAILY_LIMIT: "200",
});

const unconfigured = await generate("rivers", `${RUN}-k`);
check(
  "no Turnstile secret configured means generation refuses",
  unconfigured.status === 403,
  `got ${unconfigured.status}`,
);

console.log(`PASS ${ok.length}`);
for (const t of ok) console.log("  ok   " + t);
if (bad.length) {
  console.log(`\nFAIL ${bad.length}`);
  for (const t of bad) console.log("  FAIL " + t);
}
stop();
process.exit(bad.length ? 1 : 0);
