/* One real generation, through the real provider and the real loop.
   `npm run probe:live`. Local only: it needs a credential and spends neurons.

   **This exists because `npm run probe` was not enough and said so twice.**
   The probe sends its own prompts and does its own parsing, so it can pass on
   a payload the app dies on, and on 2026-08-05 it did exactly that: Workers AI
   returns `response` as a parsed object under JSON Mode and as a string
   without it, the probe coerced both and the app called `.trim()` on an
   object, so every call threw in production while the probe was green.

   The difference here is that nothing is reimplemented. It imports
   `workersAiProvider` and `generate` from `src/`, and the only shim is the AI
   binding itself, which forwards to a throwaway worker because a Node process
   has no bindings. If this passes, the code that ran is the code that ships. */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { workersAiProvider } from "../src/generate/provider.ts";
import { generate } from "../src/generate/loop.ts";

const PORT = Number(process.env.PROBE_PORT ?? 8799);
const THEME = process.env.PROBE_THEMES ?? "rivers";
const LANG = process.env.PROBE_LANG === "fa" ? "fa" : "en";

/* The whole shim: `env.AI` as the worker runtime would hand it over. It must
   pass the reply through untouched, including its type, or this harness would
   be papering over the very bug it exists to catch. */
const ai = {
  async run(model, input) {
    const res = await fetch(`http://127.0.0.1:${PORT}/raw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body.result;
  },
};

async function waitForReady(proc, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error("wrangler exited early");
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: "GET" });
      if (res.status === 405 || res.ok) return;
    } catch {
      /* Not up yet. */
    }
    await sleep(500);
  }
  throw new Error("wrangler did not become ready");
}

const proc = spawn(
  "npx",
  ["wrangler", "dev", "-c", "wrangler.probe.jsonc", "--port", String(PORT)],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
proc.stdout.on("data", (d) => (log += d));
proc.stderr.on("data", (d) => (log += d));

try {
  await waitForReady(proc).catch((err) => {
    console.error(log);
    throw err;
  });
  console.log(`live check: theme «${THEME}», lang ${LANG}\n`);

  const provider = workersAiProvider(ai, false, undefined, LANG);
  const outcome = await generate(provider, THEME, {
    onTrace: (step) =>
      console.log(
        `  [${step.step}] ${step.detail ?? ""}${step.ms ? ` (${(step.ms / 1000).toFixed(1)}s)` : ""}`,
      ),
  });

  console.log(`\nstatus: ${outcome.status}`);
  if (outcome.status === "pack") {
    for (const c of outcome.candidates)
      console.log(`  ${c.answer} — ${c.clue}`);
  } else if (outcome.status === "playable") {
    for (const e of outcome.entries) {
      console.log(
        `  ${e.number} ${e.dir} (${e.row},${e.col}) ${e.answer} — ${e.clue}`,
      );
    }
  } else {
    console.log(`  reason: ${outcome.reason}`);
    process.exitCode = 1;
  }
} finally {
  proc.kill("SIGTERM");
}
