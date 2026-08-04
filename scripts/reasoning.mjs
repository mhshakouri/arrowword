/* Do the reasoning models actually answer, and what do they say?
   `npm run probe:reasoning`.

   Written because "returns nothing" was not a credible finding. Cloudflare
   would not serve four models that answer with an empty string, and when a
   result implies the vendor is broken, the harness is the likelier suspect.
   It was: `max_tokens` was 2048, these models spend that much thinking, and
   the reply was cut off mid-thought before the answer was ever written.
   `finish_reason` said `length` the whole time.

   So this asks three questions per model, in order:

   1. Given room (16k), does it answer at all, and how long does it take?
   2. Can the thinking be turned off, and does the answer survive?
   3. What does the whole thing actually cost once thinking is billed?

   Everything is printed, including the reasoning, because the point is to
   read what the model said rather than to score it. */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8799);
const THEME = process.env.PROBE_THEMES ?? "پرندگان";
const ROOMY = Number(process.env.PROBE_MAXTOK ?? 16000);
const SHOW = Number(process.env.PROBE_SHOW ?? 600);

const RATES = {
  "@cf/google/gemma-4-26b-a4b-it": { in: 9091, out: 27273 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { in: 4625, out: 30475 },
  "@cf/openai/gpt-oss-20b": { in: 18182, out: 27273 },
  "@cf/openai/gpt-oss-120b": { in: 31818, out: 68182 },
  "@cf/nvidia/nemotron-3-120b-a12b": { in: 45455, out: 136364 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 26668, out: 204805 },
};

/* Taken from each model's documented parameter list on
   developers.cloudflare.com, not from what the family supports elsewhere.
   That distinction cost a wrong conclusion: `enable_thinking: false` was sent
   to Qwen3 at the top level, silently ignored, and read as "the switch does
   not work" when the truth is that Workers AI does not expose a switch for
   that model at all.

   Checked 2026-08-05:

   - `gemma-4-26b-a4b-it` documents **`reasoning_effort`** and
     `chat_template_kwargs`, so it is the only candidate here with a
     documented way to think less.
   - `qwen3-30b-a3b-fp8` documents neither. Its parameters are the ordinary
     sampling set: max_tokens, temperature, top_p, top_k, seed, the penalties,
     response_format, lora, stream.
   - `gpt-oss-20b` documents neither either.

   An empty list below therefore means "no documented control", which is a
   finding about the platform rather than a gap in this script. */
const NO_THINK = {
  "@cf/google/gemma-4-26b-a4b-it": [
    { label: 'reasoning_effort "low"', extra: { reasoning_effort: "low" } },
    {
      label: 'reasoning_effort "minimal"',
      extra: { reasoning_effort: "minimal" },
    },
    {
      label: "chat_template_kwargs {thinking:false}",
      extra: { chat_template_kwargs: { thinking: false } },
    },
  ],
};

/* `PROBE_PROMPT` swaps in a trivial ask. A model that cannot finish the real
   prompt but answers a simple one instantly is telling us the task provokes
   the deliberation, not that the model is broken, and those are different
   findings with different consequences. */
const PROMPT =
  process.env.PROBE_PROMPT ??
  [
    `Give 8 common Persian (Farsi) words for a small crossword on the theme "${THEME}".`,
    `Every answer must itself be an example of "${THEME}", not merely related to it.`,
    `Rules for each answer: written in Persian script, exactly one word, 3 to 7 Persian letters,`,
    `use ک and ی never the Arabic ك or ي, an everyday word, no proper nouns, no repeats.`,
    `Each clue is one short Persian sentence under 120 characters that describes its own answer.`,
    `Include "en" for each: the English meaning of your Persian answer, one word.`,
    `Reply with JSON only, no prose, using this shape.`,
    `The words below are placeholders showing the format; do not use them:`,
    `{"candidates":[{"answer":"AAAA","en":"BBBB","clue":"CCCC"}]}`,
  ].join("\n");

async function ask(model, { max_tokens, extra }) {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: PROMPT, max_tokens, extra }),
  });
  const out = await res.json();
  out.wall = Date.now() - started;
  return out;
}

function neurons(model, usage) {
  const rate = RATES[model];
  if (!rate || !usage) return null;
  return (
    ((usage.prompt_tokens ?? 0) * rate.in +
      (usage.completion_tokens ?? 0) * rate.out) /
    1e6
  );
}

function report(label, model, out) {
  const n = neurons(model, out.usage);
  const inTok = out.usage?.prompt_tokens ?? 0;
  const outTok = out.usage?.completion_tokens ?? 0;
  console.log(
    `\n--- ${label}` +
      `\n    finish=${out.finish ?? "?"}  wall=${(out.wall / 1000).toFixed(1)}s` +
      `  tokens=${inTok}in/${outTok}out` +
      (n !== null ? `  neurons=${n.toFixed(1)}` : ""),
  );
  if (out.error) {
    console.log(`    ERROR ${out.error}`);
    return;
  }
  const reasoning = out.reasoning ?? "";
  if (reasoning) {
    console.log(`    reasoning (${reasoning.length} chars), first ${SHOW}:`);
    console.log(
      "    | " + reasoning.slice(0, SHOW).replace(/\n+/g, "\n    | "),
    );
  }
  const reply = out.reply ?? "";
  console.log(`    answer (${reply.length} chars):`);
  console.log(
    reply
      ? "    > " + reply.slice(0, SHOW).replace(/\n+/g, "\n    > ")
      : "    > (empty)",
  );
}

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

const MODELS = process.env.PROBE_MODEL
  ? [process.env.PROBE_MODEL]
  : [
      "@cf/qwen/qwen3-30b-a3b-fp8",
      "@cf/google/gemma-4-26b-a4b-it",
      "@cf/openai/gpt-oss-20b",
      "@cf/openai/gpt-oss-120b",
    ];

async function main() {
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
    console.log(`probe up on :${PORT}, theme «${THEME}», max_tokens ${ROOMY}`);

    for (const model of MODELS) {
      console.log(`\n${"=".repeat(70)}\n${model}`);
      report(
        `given room (${ROOMY} tokens)`,
        model,
        await ask(model, { max_tokens: ROOMY }),
      );
      for (const attempt of NO_THINK[model] ?? []) {
        report(
          attempt.label,
          model,
          await ask(model, { max_tokens: 2048, extra: attempt.extra }),
        );
      }
      if (!NO_THINK[model]) {
        console.log(
          `\n--- no documented way to reduce reasoning for this model on Workers AI`,
        );
      }
    }
  } finally {
    proc.kill("SIGTERM");
  }
}

await main();
