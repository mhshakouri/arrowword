/* Put prompts in front of the real model and report what came back.
   `npm run probe`. Never runs in CI: it needs a credential and spends neurons,
   and section 7 says both stay out of the suite.

   This is the "script run by hand against the real model" ADR-12 already asks
   for as a deliverable, pointed at Persian. It reports per-candidate verdicts
   rather than a pass or fail, because the question is not "did it work" but
   "which of these prompts works, and how does it fail when it does not".

   Everything it judges with is the real module: `normalizePersian` and friends
   from `src/generate/persian.ts`. If the probe says a word is usable, the
   generator will agree. */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  isPersianAnswer,
  normalizePersian,
  persianGivesItAway,
  persianLength,
} from "../src/generate/persian.ts";

const PORT = Number(process.env.PROBE_PORT ?? 8799);
const MODEL = process.env.PROBE_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fp8";
const THEMES = process.env.PROBE_THEMES?.split(",") ?? ["آشپزخانه", "پرندگان"];
const MIN = 3;
const MAX = 7; /* Shorter than English: Persian words pack denser and a 7 letter
                  run already spans most of an 11 wide grid. */

const LETTERS = "ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی";

/* Published neurons per million tokens, copied from Cloudflare's Workers AI
   pricing page on 2026-08-05 rather than remembered. The one vendor fact this
   project ever took from memory was a model id, every call threw, and section
   12 has three lessons about it.

   Output dominates: the 70B charges 7.8 times the 8B per output token and only
   1.9 times per input token, so a prompt can grow much more cheaply than a
   reply can. */
const RATES = {
  "@cf/meta/llama-3.1-8b-instruct-fp8": { in: 13778, out: 26128 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 26668, out: 204805 },
};
/* Only models whose rate has actually been read off the pricing page appear
   above, and a model that is missing prints tokens without neurons rather than
   a number nobody checked. Qwen3 was dropped from this table on purpose: its
   row was adjacent to deepseek's on the scraped page and the two were easy to
   confuse, and it answered with an empty reply on both themes anyway. */

/* ---- The prompts under test. This is the real deliverable of this script:
   whichever wins here becomes the shipped prompt. ---- */

/* A. Instructions in English, output required in Persian. Small models follow
   English instructions better than Persian ones, because that is what
   instruction tuning is mostly made of; whether that beats the priming effect
   of asking in Persian is exactly what this probe is for. */
const englishInstructions = (theme, count) =>
  [
    `Give ${count} common Persian (Farsi) words for a small crossword on the theme "${theme}".`,
    `Every answer must be written in Persian script.`,
    `Rules for each answer:`,
    `- exactly one word: no spaces, no hyphens, no zero-width non-joiner (ZWNJ)`,
    `- ${MIN} to ${MAX} Persian letters`,
    `- use Persian letters only: ${LETTERS}`,
    `- use ک (U+06A9) and ی (U+06CC), never the Arabic ك (U+0643) or ي (U+064A)`,
    `- no diacritics (zabar, zir, pish, tashdid)`,
    `- everyday words a school child would know, no proper nouns`,
    `Each clue is one short Persian sentence, under 120 characters, and must not contain its answer.`,
    `Reply with JSON only, no prose: {"candidates":[{"answer":"کتاب","clue":"چیزی که می‌خوانیم"}]}`,
  ].join("\n");

/* B. Everything in Persian. The priming argument: a prompt in Persian may pull
   the model into a Persian region of its distribution and produce more
   idiomatic words and clues. */
const persianInstructions = (theme, count) =>
  [
    `${count} واژهٔ فارسی برای یک جدول کلمات متقاطع کوچک با موضوع «${theme}» بنویس.`,
    `قواعد هر واژه:`,
    `- فقط یک کلمه، بدون فاصله، بدون نیم‌فاصله`,
    `- بین ${MIN} تا ${MAX} حرف`,
    `- فقط با این حروف: ${LETTERS}`,
    `- حرف «ک» و «ی» فارسی، نه «ك» و «ي» عربی`,
    `- بدون اعراب و تشدید`,
    `- واژه‌های روزمره و ساده، بدون اسم خاص`,
    `هر سرنخ یک جملهٔ کوتاه فارسی زیر ۱۲۰ نویسه است و نباید خودِ جواب در آن بیاید.`,
    `فقط JSON بده، بدون هیچ توضیحی: {"candidates":[{"answer":"کتاب","clue":"چیزی که می‌خوانیم"}]}`,
  ].join("\n");

/* C. English instructions plus worked examples of the two failure modes the
   rules describe. The English layout prompt gained the most reliability from a
   worked example, and a rule a small model cannot picture is a rule it drops. */
const withExamples = (theme, count) =>
  [
    englishInstructions(theme, count),
    ``,
    `Examples of what to do and not do:`,
    `GOOD: {"answer":"دریا","clue":"آب شور و بزرگ"}  (4 letters, one word)`,
    `BAD:  {"answer":"كتاب","clue":"..."}  (uses Arabic ك, must be ک)`,
    `BAD:  {"answer":"می‌رود","clue":"..."}  (contains a ZWNJ, not one plain word)`,
    `BAD:  {"answer":"کتاب خانه","clue":"..."}  (two words)`,
  ].join("\n");

/* D. What the first run said was actually wrong. Every candidate in run one was
   mechanically perfect Persian and the normalizer never fired once, so the
   script rules were not the problem and are trimmed back here. The problems
   were semantic, and each line below answers one of them:

   - «پرندگان» returned شغال, پلنگ, قوچ and مگس: jackal, leopard, ram and fly.
     The model answers the *category* loosely, so "must be an example of" is
     stated and then restated as a self-check.
   - Variant C copied the worked example «کتاب» into a puzzle about birds, so
     the shape example now carries placeholder answers that cannot be mistaken
     for content, and says not to reuse them.
   - Clues were decorative rather than definitional («پنجه» clued as "hot
     weather"), so the clue rule says what a clue is *for*. */
const themeTight = (theme, count) =>
  [
    `Give ${count} common Persian (Farsi) words for a small crossword on the theme "${theme}".`,
    `Every answer must itself be an example of "${theme}", not merely related to it.`,
    `Rules for each answer:`,
    `- written in Persian script, exactly one word: no spaces, no hyphens, no ZWNJ`,
    `- ${MIN} to ${MAX} Persian letters`,
    `- use ک and ی, never the Arabic ك or ي`,
    `- an everyday word, no proper nouns, no repeats`,
    `Each clue is one short Persian sentence under 120 characters that describes`,
    `its own answer well enough to guess it, and must not contain the answer.`,
    `Before replying, check each answer twice: is it really an example of "${theme}",`,
    `and does its clue describe that answer rather than something else?`,
    `Reply with JSON only, no prose, using this shape.`,
    `The words below are placeholders showing the format; do not use them:`,
    `{"candidates":[{"answer":"AAAA","clue":"BBBB"},{"answer":"CCCC","clue":"DDDD"}]}`,
  ].join("\n");

/* E. D plus an English gloss per word. The gloss is never shown to anybody and
   is thrown away; it exists to make the model commit to what the word means in
   the same breath as choosing it, which is the cheapest known way to stop a
   small model drifting off a category. Costs output tokens, which is what we
   pay for, so it earns its place only if theme adherence actually improves. */
const withGloss = (theme, count) =>
  [
    themeTight(theme, count).replace(
      `{"candidates":[{"answer":"AAAA","clue":"BBBB"},{"answer":"CCCC","clue":"DDDD"}]}`,
      `Include "en" for each: the English meaning of your Persian answer, one word.`,
    ),
    `Reply with JSON only, no prose, using this shape.`,
    `The words below are placeholders showing the format; do not use them:`,
    `{"candidates":[{"answer":"AAAA","en":"BBBB","clue":"CCCC"}]}`,
  ].join("\n");

/* EN. The shipped English word prompt, copied from `provider.ts`. Not a Persian
   variant at all: it is here so that changing `GENERATION_MODEL` for Persian
   can be checked against the path that already works and already has users.
   B3's own lesson is that the first real call is the first real test, and a
   model swap that quietly degraded English would be exactly that mistake in a
   new costume. Judged by English rules, so `PROBE_LANG=en` with this one. */
const shippedEnglish = (theme, count) =>
  [
    `Give ${count} English words for a small crossword on the theme "${theme}".`,
    `Rules: each answer is a single word, 3 to 11 letters, letters A-Z only.`,
    `Proper nouns are fine. No abbreviations, and no plurals of the theme word itself.`,
    `Each clue is one short sentence under 120 characters and must not contain its answer.`,
    `Reply with JSON only, no prose: {"candidates":[{"answer":"...","clue":"..."}]}`,
  ].join(" ");

const ALL_VARIANTS = [
  { name: "A english-instructions", build: englishInstructions },
  { name: "B all-persian", build: persianInstructions },
  { name: "C english+examples", build: withExamples },
  { name: "D theme-tight", build: themeTight },
  { name: "E theme-tight+gloss", build: withGloss },
  { name: "EN shipped-english", build: shippedEnglish },
];

/* `PROBE_VARIANTS=D,E` to iterate on two without paying for five. */
const PICK = process.env.PROBE_VARIANTS?.split(",").map((s) => s.trim());
const VARIANTS = PICK
  ? ALL_VARIANTS.filter((v) => PICK.some((p) => v.name.startsWith(p)))
  : ALL_VARIANTS;

const SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          answer: { type: "string" },
          clue: { type: "string" },
        },
        required: ["answer", "clue"],
      },
    },
  },
  required: ["candidates"],
};

/* ---- Running one prompt ---- */

/* Schema off by default, and that is a finding rather than a preference:
   `llama-3.1-8b-instruct-fp8` answers `5025: This model doesn't support JSON
   Schema`. The real provider already tries a schema and falls back to a plain
   call within the same attempt, so plain is the path production actually takes
   on this model, and it is the one worth measuring. `PROBE_SCHEMA=1` to try
   the other branch after a model change. */
async function ask(prompt, { schema = process.env.PROBE_SCHEMA === "1" } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      schema: schema ? SCHEMA : undefined,
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });
  return res.json();
}

/* Read a reply the way the provider does, and **in the same order**, which is
   the part this got wrong first time round.

   The provider parses the whole document and only salvages loose objects when
   that fails. The probe salvaged first and never parsed, so a complete
   `{"candidates":[...]}` was consumed by its own outer brace, matched no
   `answer` key at the top level, and scored zero, while a *truncated* reply
   whose outer brace never closed salvaged fine and scored well. The probe was
   rewarding the model for producing broken JSON, and two prompt variants were
   nearly written off on the strength of it.

   The lesson is not about braces. A harness that judges a model has to run the
   real code path or it measures itself. */
/* The provider's narrow repair, and the probe has to run it or it slanders the
   incumbent. `llama-3.1-8b-instruct-fp8` writes `{"answer":"OVEN","clue:"...}`
   from the second candidate onwards: the colon migrates inside the key's
   closing quote and the document is invalid from there. Production repairs it
   and keeps eleven candidates; the probe did not, scored the 8B at one
   candidate out of eight on English, and that number was about to be evidence
   in a model decision. */
function repairJson(text) {
  return text.replace(/"([A-Za-z_][A-Za-z0-9_]*):"/g, '"$1":"');
}

/* The provider's `extractJson`: models wrap JSON in prose and markdown fences
   however they were feeling, so take the first balanced bracketed region
   rather than trying to parse the whole reply. Looking for `[` as well as `{`
   matters, because a bare top-level array is a shape the model uses.

   Mirroring this is the third time the probe has been wrong by diverging from
   the provider. It measured the 8B at zero usable English candidates on a
   reply that in fact held eight good ones behind the words "Here are 8
   crossword clues" and a ``` fence. The rule has earned being stated plainly:
   **the harness runs the provider's parse, or it reports on the harness.** */
function extractJson(text) {
  const curly = text.indexOf("{");
  const square = text.indexOf("[");
  const start =
    curly < 0 ? square : square < 0 ? curly : Math.min(curly, square);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (!depth) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function readCandidates(input) {
  const text = repairJson(input);
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : parsed?.candidates;
  if (Array.isArray(list) && list.length) return list;
  return salvageCandidates(text);
}

function salvageCandidates(text) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j += 1) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(text.slice(i, j + 1));
            if (
              value &&
              typeof value.answer === "string" &&
              !seen.has(value.answer)
            ) {
              seen.add(value.answer);
              out.push(value);
            }
          } catch {
            /* Broken; its neighbours may not be. */
          }
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/* `PROBE_LANG=en` judges by the shipped English rules instead, which is what
   makes the EN variant meaningful rather than a wall of "not-persian-letters". */
const LANG = process.env.PROBE_LANG === "en" ? "en" : "fa";

function judgeEnglish(candidate) {
  const raw = String(candidate.answer ?? "")
    .trim()
    .toUpperCase();
  const clue = String(candidate.clue ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const problems = [];
  if (!/^[A-Z]+$/.test(raw)) problems.push("not-a-z");
  if (raw.length < 3 || raw.length > 11) problems.push(`length-${raw.length}`);
  if (!clue) problems.push("no-clue");
  else if (clue.length > 120) problems.push("clue-too-long");
  else if (new RegExp(`\\b${raw}\\b`, "i").test(clue))
    problems.push("clue-gives-it-away");
  return {
    raw,
    norm: raw,
    len: raw.length,
    clue,
    problems,
    needednorm: null,
    en: null,
  };
}

function judge(candidate) {
  if (LANG === "en") return judgeEnglish(candidate);
  const raw = String(candidate.answer ?? "");
  const clue = String(candidate.clue ?? "");
  const norm = normalizePersian(raw);
  const len = persianLength(norm);
  const problems = [];

  if (!norm) problems.push("empty");
  else if (!isPersianAnswer(norm)) problems.push("not-persian-letters");
  if (norm && (len < MIN || len > MAX)) problems.push(`length-${len}`);
  if (!clue) problems.push("no-clue");
  else if (clue.length > 120) problems.push("clue-too-long");
  else if (persianGivesItAway(clue, raw)) problems.push("clue-gives-it-away");
  /* Caught by reading the output, not by any rule that existed: llama-3.3-70b
     returned the clue «پرنده城市», with the Chinese for "city" inside otherwise
     correct Persian. A clue is displayed text rather than a grid answer, so it
     may hold spaces, digits and Persian punctuation, but a script that is
     neither Persian nor Latin in a Persian clue is a defect the app would
     have shipped straight to a solver. */
  else if (/[　-鿿֐-׿Ѐ-ӿ]/.test(clue)) problems.push("clue-foreign-script");
  /* Not a rejection, but the thing worth counting: how often the model needs
     the normalizer at all tells us whether it can be prompted out of it. */
  const needednorm = norm !== raw.trim() ? "normalized" : null;

  return {
    raw,
    norm,
    len,
    clue,
    problems,
    needednorm,
    en: typeof candidate.en === "string" ? candidate.en : null,
  };
}

/* ---- Harness ---- */

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

async function main() {
  /* No `--local`: that is the whole point. Local mode has no Workers AI
     emulation, so the binding must reach the real edge, authenticated by the
     `wrangler login` this machine already has. */
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
    console.log(`probe up on :${PORT}, model ${MODEL}\n`);

    const table = [];
    for (const theme of THEMES) {
      for (const variant of VARIANTS) {
        const prompt = variant.build(theme, 8);
        const answer = await ask(prompt);
        if (!answer.ok) {
          console.log(
            `\n### ${variant.name} · «${theme}» · ERROR ${answer.error}`,
          );
          table.push({
            theme,
            variant: variant.name,
            usable: 0,
            total: 0,
            ms: answer.ms,
          });
          continue;
        }
        /* `PROBE_DUMP=<dir>` writes every raw reply to disk. Reading the
           actual bytes is the only way to tell a model failure from a parser
           failure, and guessing between the two already cost one round. */
        if (process.env.PROBE_DUMP) {
          const name = `${variant.name.split(" ")[0]}-${theme}.txt`.replace(
            /\s+/g,
            "_",
          );
          await writeFile(`${process.env.PROBE_DUMP}/${name}`, answer.reply);
        }
        const candidates = readCandidates(answer.reply);
        const judged = candidates.map(judge);
        const usable = judged.filter((j) => j.problems.length === 0);

        console.log(`\n### ${variant.name} · «${theme}» · ${answer.ms}ms`);
        if (!candidates.length) {
          console.log("  no parsable candidates. raw reply:");
          console.log("  " + answer.reply.slice(0, 400).replace(/\n/g, "\n  "));
        }
        for (const j of judged) {
          const flag = j.problems.length ? `✗ ${j.problems.join(",")}` : "✓";
          const note = j.needednorm ? ` [${j.raw} -> ${j.norm}]` : "";
          /* The gloss, where a variant asked for one, is the fastest way for a
             reader who does not speak Persian to see a theme miss. It is
             probe-only and never reaches the app. */
          const gloss = j.en ? ` {${j.en}}` : "";
          console.log(
            `  ${flag} ${j.norm} (${j.len})${gloss}${note}  — ${j.clue}`,
          );
        }
        /* Neurons, from the tokens the model reported and the published rate
           for the model under test. Section 7 wants the ceiling derived rather
           than guessed, and this is the derivation. */
        const rate = RATES[MODEL];
        const inTok = answer.usage?.prompt_tokens ?? 0;
        const outTok = answer.usage?.completion_tokens ?? 0;
        const neurons = rate
          ? (inTok * rate.in + outTok * rate.out) / 1e6
          : null;
        console.log(
          `  usable ${usable.length}/${judged.length}` +
            (inTok ? `  ·  ${inTok} in / ${outTok} out tokens` : "") +
            (neurons !== null ? `  ·  ${neurons.toFixed(1)} neurons` : ""),
        );
        table.push({
          theme,
          variant: variant.name,
          usable: usable.length,
          total: judged.length,
          ms: answer.ms,
          neurons,
        });
      }
    }

    console.log("\n=== summary ===");
    for (const row of table) {
      console.log(
        `${row.variant.padEnd(24)} ${row.theme.padEnd(12)} ${row.usable}/${row.total}  ${row.ms}ms`,
      );
    }
  } finally {
    proc.kill("SIGTERM");
  }
}

await main();
