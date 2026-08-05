/* The provider boundary, B3. No key, no network, no neurons.

   `clean()` gets most of the attention because it is the only thing standing
   between model output and a grid. Section 7 calls model output untrusted twice
   over: structurally, which the validator handles, and as text, which is
   sanitized where it is stored. This is the structural half. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clean,
  GENERATION_MODEL,
  recordedProvider,
  workersAiProvider,
  type Proposal,
} from "./provider.ts";
import {
  CROSSING_RICH,
  MESSY,
  NEVER_VALID,
  RECOVERS,
  RIVERS,
  UNUSABLE,
} from "./fixtures.ts";

const answers = (p: Proposal) => p.candidates.map((c) => c.answer);

/* ---- clean(), the structural gate ---- */

test("a clean proposal survives intact", () => {
  const out = clean(RIVERS);
  assert.equal(out.candidates.length, RIVERS.candidates.length);
});

test("lowercase answers are uppercased rather than dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "whisk", clue: "You beat eggs with it" }],
  });
  assert.deepEqual(answers(out), ["WHISK"]);
});

test("a two-word answer is dropped, not stripped of its space", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "FRYING PAN", clue: "Flat, with a handle" }],
  });
  assert.deepEqual(answers(out), []);
});

test("an answer with an accent is dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "CAFÉ", clue: "Somewhere to sit" }],
  });
  assert.deepEqual(answers(out), []);
});

test("digits are not letters", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "12345", clue: "Numbers" }],
  });
  assert.deepEqual(answers(out), []);
});

test("answers outside the length range are dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [
      { answer: "PA", clue: "Too short" },
      { answer: "SUPERCALIFRAGILISTIC", clue: "Too long" },
      { answer: "CAT", clue: "Just right" },
    ],
  });
  assert.deepEqual(answers(out), ["CAT"]);
});

/* Models do this constantly when a theme word is rare, and it makes the puzzle
   unsolvable in the sense that matters: the answer is already printed. */
test("a clue containing its own answer is dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "LADLE", clue: "A ladle for serving soup" }],
  });
  assert.deepEqual(answers(out), []);
});

test("the answer check is case insensitive inside the clue", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "The oven in your kitchen" }],
  });
  assert.deepEqual(answers(out), []);
});

test("an empty clue is dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "" }],
  });
  assert.deepEqual(answers(out), []);
});

test("a clue past the length cap is dropped", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "x".repeat(121) }],
  });
  assert.deepEqual(answers(out), []);
});

test("a clue at exactly the cap is kept", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "x".repeat(120) }],
  });
  assert.deepEqual(answers(out), ["OVEN"]);
});

test("whitespace in clues is collapsed", () => {
  const out = clean({
    theme: "t",
    candidates: [{ answer: "OVEN", clue: "  It   gets\n\nhot  " }],
  });
  assert.equal(out.candidates[0]?.clue, "It gets hot");
});

/* A duplicate produces two entries with the same solution, which reads as a
   mistake even when it validates. */
test("a duplicate answer is dropped, including one differing only in case", () => {
  const out = clean({
    theme: "t",
    candidates: [
      { answer: "WHISK", clue: "You beat eggs with it" },
      { answer: "whisk", clue: "For whipping cream by hand" },
    ],
  });
  assert.deepEqual(answers(out), ["WHISK"]);
});

test("missing or malformed candidates do not throw", () => {
  const out = clean({ theme: "t" } as unknown as Proposal);
  assert.deepEqual(out.candidates, []);
  const out2 = clean({
    theme: "t",
    candidates: [null, undefined, {}] as unknown as Proposal["candidates"],
  });
  assert.deepEqual(out2.candidates, []);
});

/* ---- The fixtures themselves, which are recordings and not ideal input ---- */

test("the messy fixture loses exactly its four bad candidates", () => {
  const out = clean(MESSY);
  assert.deepEqual(answers(out), ["WHISK", "SIEVE", "KNIFE", "GRATER"]);
});

test("the unusable fixture yields nothing at all", () => {
  assert.deepEqual(clean(UNUSABLE).candidates, []);
});

test("the crossing-rich fixture survives cleaning, since packing needs it", () => {
  assert.equal(
    clean(CROSSING_RICH).candidates.length,
    CROSSING_RICH.candidates.length,
  );
});

test("every fixture is clean-safe, meaning cleaning twice changes nothing", () => {
  for (const fixture of [RIVERS, MESSY, UNUSABLE, CROSSING_RICH]) {
    const once = clean(fixture);
    assert.deepEqual(clean(once), once, `${fixture.theme} is not idempotent`);
  }
});

/* ---- recordedProvider ---- */

test("a recorded provider replays proposals in order", async () => {
  const provider = recordedProvider(RECOVERS);
  assert.deepEqual((await provider.propose("t", 10)).candidates, []);
  assert.ok((await provider.propose("t", 10)).candidates.length > 0);
});

/* Repeating rather than throwing is what lets a test exercise "the model kept
   saying the same unusable thing" instead of "the fixture list ran out". */
test("a recorded provider repeats its last proposal forever", async () => {
  const provider = recordedProvider(NEVER_VALID);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual((await provider.propose("t", 10)).candidates, []);
  }
  assert.equal(provider.calls, 5);
});

test("a recorded provider stamps the theme it was asked for", async () => {
  const provider = recordedProvider([RIVERS]);
  assert.equal((await provider.propose("mountains", 10)).theme, "mountains");
});

test("a recorded provider cleans what it replays", async () => {
  const provider = recordedProvider([MESSY]);
  const out = await provider.propose("kitchen", 10);
  assert.equal(
    out.candidates.some((c) => c.answer.includes(" ")),
    false,
  );
});

test("a recorded provider with no proposals is a programming error", () => {
  assert.throws(() => recordedProvider([]), /needs proposals/);
});

/* ---- The model id ----

   B3 shipped with `@cf/meta/llama-3.1-8b-instruct`, which Workers AI does not
   serve; the real id carries an `-fp8` suffix. Every call threw, the loop
   counted each throw as a failed attempt exactly as designed, and the first
   person to try the feature was told their theme was the problem.

   Nothing here can ask Cloudflare what exists, because CI holds no credential
   and must not. What it can do is stop the value drifting silently: this test
   fails if the id changes, so changing it is a deliberate act with a reason in
   the diff rather than an edit nobody reviews. `wrangler ai models list` is
   the ten seconds that would have caught it. */

test("the default generation model id is pinned, and changing it is deliberate", () => {
  assert.equal(GENERATION_MODEL, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
});

/* Configurable, so a comparison is a deploy rather than a pull request, and the
   value actually reaches the call rather than being decoration. */
test("an overriding model id is the one asked for", async () => {
  let asked = "";
  const ai = {
    async run(model: string) {
      asked = model;
      return { response: '{"candidates":[]}' };
    },
  };
  await workersAiProvider(ai, false, "@cf/some/other-model").propose("t", 4);
  assert.equal(asked, "@cf/some/other-model");
});

test("no override means the default", async () => {
  let asked = "";
  const ai = {
    async run(model: string) {
      asked = model;
      return { response: '{"candidates":[]}' };
    },
  };
  await workersAiProvider(ai).propose("t", 4);
  assert.equal(asked, GENERATION_MODEL);
});

test("the model id looks like a Workers AI id at all", () => {
  assert.match(GENERATION_MODEL, /^@cf\/[a-z0-9-]+\/[a-z0-9.-]+$/);
});

/* ---- The clue-gives-it-away rule matches words, not substrings ----

   Shipped as `clue.toUpperCase().includes(answer)`, which kills a three letter
   answer whenever its letters appear anywhere in the clue. Short answers are
   the ones a small grid needs most, and enough of them were dropped that the
   word list came back empty and the packing fallback could not run. */

const kept = (answer: string, clue: string) =>
  clean({ theme: "t", candidates: [{ answer, clue }] }).candidates.length === 1;

test("a clue merely containing the answer's letters is kept", () => {
  assert.ok(kept("ART", "Departure lounge"), "ART killed by 'departure'");
  assert.ok(kept("ONE", "Money spent on a film"), "ONE killed by 'money'");
  assert.ok(kept("OAT", "Coat of paint"), "OAT killed by 'coat'");
  assert.ok(kept("SET", "Sunset over the studio"), "SET killed by 'sunset'");
  assert.ok(kept("ACT", "A factual scene"), "ACT killed by 'factual'");
});

test("a clue containing the answer as a word is still dropped", () => {
  assert.equal(kept("LADLE", "A ladle for serving soup"), false);
  assert.equal(kept("ART", "The art of film"), false);
  assert.equal(kept("REEL", "A film reel holder"), false);
});

test("the word match ignores case and punctuation around the word", () => {
  assert.equal(kept("SET", "On the set, before dawn"), false);
  assert.equal(kept("SET", "Where filming happens (the SET)"), false);
});

/* ---- readEntries reads the one shape the schema permits ----

   Three tests were deleted here on 2026-08-05, and what they asserted is worth
   recording because it is now forbidden rather than merely unused: a layout
   split into `across` and `down` arrays was accepted, a bare top-level array
   was accepted, and JSON buried in prose and a Markdown fence was dug out.

   All three were tolerance for a model that could not be held to a schema. On
   a JSON Mode model those replies mean the schema was not honoured, and
   quietly accepting them would hide exactly the fault the schema exists to
   surface. The tests below assert the opposite of what those did. */

test("a shape other than {entries:[...]} yields nothing rather than being coerced", async () => {
  for (const response of [
    JSON.stringify({
      across: [{ row: 0, col: 0, answer: "CAT", clue: "It ignores you" }],
    }),
    JSON.stringify([
      { dir: "across", row: 0, col: 0, answer: "CAT", clue: "It ignores you" },
    ]),
  ]) {
    const out = await workersAiProvider({
      async run() {
        return { response };
      },
    }).proposeLayout("t", 5, 5);
    assert.deepEqual(out.entries, [], `should not coerce: ${response}`);
  }
});

test("prose around the JSON is no longer dug out, because a schema forbids it", async () => {
  const ai = {
    async run() {
      return {
        response:
          'Sure! Here is your crossword:\n```json\n{"entries":[{"dir":"down","row":1,"col":2,"answer":"COT","clue":"A small bed"}]}\n```\nHope that helps.',
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.deepEqual(
    out.entries,
    [],
    "prose means the schema was not honoured, which is a failure worth seeing",
  );
});

test("a schema-shaped reply is read, which is the path that now matters", async () => {
  const ai = {
    async run() {
      return {
        response:
          '{"entries":[{"dir":"down","row":1,"col":2,"answer":"COT","clue":"A small bed"}]}',
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0]?.answer, "COT");
});

test("len is derived from the answer, never read from the model", async () => {
  const ai = {
    async run() {
      return {
        response: JSON.stringify({
          entries: [
            {
              dir: "across",
              row: 0,
              col: 0,
              answer: "CAT",
              clue: "c",
              len: 99,
            },
          ],
        }),
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(out.entries[0]?.len, 3);
});

/* ---- JSON schema mode, and the fallback that keeps it honest ----

   Cloudflare's documentation says a model that cannot satisfy a schema returns
   an error. An error reaching the loop is counted as a throw and reported to
   the player as the service being unreachable, so a model that simply does not
   support schemas would have looked like an outage. */

test("a schema is sent when the model accepts one", async () => {
  let sawSchema = false;
  const ai = {
    async run(_model: string, input: Record<string, unknown>) {
      sawSchema = "response_format" in input;
      return { response: '{"entries":[]}' };
    },
  };
  await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(sawSchema, true);
});

/* The inverse of what this asserted until 2026-08-05, when the answer to a
   schema rejection was to retry free-form and salvage whatever came back.

   That made sense when the model could not do JSON Mode, because the fallback
   was the only path that ever ran. On a model that can, a schema rejection
   means the model could not satisfy the schema for this particular theme,
   which is a failed attempt and not a reason to go back to guessing. */
test("a schema rejection is a failed attempt, not a retry without the schema", async () => {
  let calls = 0;
  const ai = {
    async run(_model: string, input: Record<string, unknown>) {
      calls += 1;
      assert.ok("response_format" in input, "the schema is always sent");
      throw new Error("JSON Mode couldn't be met");
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(calls, 1, "no free-form retry");
  assert.deepEqual(out.entries, []);
});

/* The distinction that matters, and the one section 12 spent a lesson on:
   telling somebody their theme was bad when the model was down. A schema
   refusal is the theme's problem; anything else is an outage. */
/* The distinction the regex has to get right, and the reason it is not simply
   /schema/i: 5025 is a misconfiguration that fails every theme identically, so
   reporting it as the theme's problem would send every visitor away rewording
   something that was never the issue. */
test("a model that cannot do JSON Mode at all is an outage, not a bad theme", async () => {
  const ai = {
    async run() {
      throw new Error("5025: This model doesn't support JSON Schema");
    },
  };
  await assert.rejects(
    () => workersAiProvider(ai).proposeLayout("t", 5, 5),
    /5025/,
    "a misconfigured model must throw, so the loop calls it unreachable",
  );
});

test("an unrecognised error is an outage too, which is the safer default", async () => {
  const ai = {
    async run() {
      throw new Error("connection reset");
    },
  };
  await assert.rejects(() => workersAiProvider(ai).proposeLayout("t", 5, 5));
});

test("a schema refusal is recorded as such, so the trace can tell them apart", async () => {
  const provider = workersAiProvider({
    async run() {
      throw new Error("JSON Mode couldn't be met");
    },
  });
  await provider.proposeLayout("t", 5, 5);
  assert.equal(provider.lastExchange?.()?.mode, "schema-refused");
  assert.equal(provider.lastExchange?.()?.parsed, false);
});

test("a model that is genuinely down still throws, so an outage is still an outage", async () => {
  const ai = {
    async run() {
      throw new Error("service unavailable");
    },
  };
  await assert.rejects(() => workersAiProvider(ai).proposeLayout("t", 5, 5));
});

/* Constraint task, not a creative one: crossings suffer far more at a high
   setting than clues gain. */
test("a low temperature is sent", async () => {
  let temp: unknown;
  const ai = {
    async run(_model: string, input: Record<string, unknown>) {
      temp = input.temperature;
      return { response: '{"entries":[]}' };
    },
  };
  await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(typeof temp, "number");
  assert.ok((temp as number) <= 0.3, `temperature ${temp} is too high`);
});

/* ---- The prompt carries what the model needs to derive nothing ---- */

test("the layout prompt spells out the coordinate arithmetic", async () => {
  let sent = "";
  const ai = {
    async run(_model: string, input: Record<string, unknown>) {
      sent = String(
        (input.messages as Array<{ content: string }>)[0]?.content ?? "",
      );
      return { response: '{"entries":[]}' };
    },
  };
  await workersAiProvider(ai).proposeLayout("rivers", 11, 11);
  assert.match(sent, /\(row, col \+ k\)/, "across arithmetic missing");
  assert.match(sent, /\(row \+ k, col\)/, "down arithmetic missing");
  assert.match(sent, /Correct crossing example/, "worked example missing");
});

/* Hardcoding 10 would be wrong for any other grid size, and the packer already
   accepts a size from the caller. */
test("the layout prompt states the real bounds for the grid it was given", async () => {
  let sent = "";
  const ai = {
    async run(_model: string, input: Record<string, unknown>) {
      sent = String(
        (input.messages as Array<{ content: string }>)[0]?.content ?? "",
      );
      return { response: '{"entries":[]}' };
    },
  };
  await workersAiProvider(ai).proposeLayout("t", 7, 9);
  assert.match(sent, /past row 6 or col 8/);
});

test("the repair prompt restates the bounds and allows deleting an entry", async () => {
  let sent = "";
  const ai = {
    async run(_model: string, input: Record<string, unknown>) {
      sent = String(
        (input.messages as Array<{ content: string }>)[0]?.content ?? "",
      );
      return { response: '{"entries":[]}' };
    },
  };
  await workersAiProvider(ai).repair(
    { theme: "t", rows: 11, cols: 11, entries: [] },
    ["0,0 is A in entry 0 and B here"],
  );
  assert.match(sent, /past row 10 or col 10/, "bounds not restated");
  assert.match(sent, /delete an offending entry/, "deletion not permitted");
  assert.match(sent, /0,0 is A in entry 0/, "the specific problem is missing");
});

/* ---- Replies that actually came back, pasted verbatim ----

   Every case below is a real reply from a real generation, kept as evidence
   rather than paraphrased. Invented input tests the parser against what its
   author imagined a model does; these test it against what one did. */

/* The colon migrates inside the key's closing quote from the second candidate
   onwards. Twelve candidates, eleven lost, and the survivor was the one written
   before the model slipped into the pattern. */
const REAL_WORD_REPLY = `Here are 12 space-related words for your crossword:

\`\`\`
[
  {"answer":"MARS","clue":"Red planet"},
  {"answer":"ORBIT","clue:"Path around a star"},
  {"answer":"ASTEROID","clue:"Rocky object in space"},
  {"answer":"SATELLITE","clue:"Object in orbit around Earth"},
  {"answer":"GALAXY","clue:"Collection of stars"},
  {"answer":"COMET","clue:"Icy body in the solar system"},
  {"answer":"NEBULA","clue:"Interstellar gas cloud"},
  {"answer":"PLANET","clue:"Celestial body orbits a star"}
]
\`\`\``;

/* Cut off mid-string because max_tokens was never set. The complete entries
   before the cut are perfectly good and were being thrown away with it. */
const REAL_TRUNCATED_LAYOUT = `{
  "entries": [
    {
      "dir": "across",
      "row": 0,
      "col": 0,
      "answer": "SPACE",
      "clue": "The final frontier"
    },
    {
      "dir": "down",
      "row": 0,
      "col": 4,
      "answer": "EARTH",
      "clue": "Home sweet home"
    },
    {
      "dir": "across",
      "row": 1,
      "col": 5,
      "answer": "MOON",
      "clue": "Lunar phase"
    },
    {
      "dir": "down",
      "row": 2,
      "col": 6,
      "answer": "COMET`;

const replying = (response: string) => ({
  async run() {
    return { response };
  },
});

/* These two replies are kept verbatim because they are what the 8B really
   sent, and they are now regression material of a different kind: they are
   what the app must **stop** trying to rescue.

   Until 2026-08-05, `REAL_TRUNCATED_LAYOUT` was mined for the three complete
   entries inside a document whose outer brace never closed, and
   `REAL_WORD_REPLY` had a migrated colon repaired so that eleven candidates
   were not lost to one. Both behaviours were correct for a model that could
   not be held to a schema, and both are now the wrong answer: on a JSON Mode
   model a reply in this state means the schema was not honoured, and salvaging
   it would turn a visible fault into a puzzle built from whatever survived. */
test("a truncated reply yields nothing, because a schema should not truncate", async () => {
  const out = await workersAiProvider(
    replying(REAL_TRUNCATED_LAYOUT),
  ).proposeLayout("space", 11, 11);
  assert.deepEqual(
    out.entries,
    [],
    "salvage is gone: an unparseable document is a failed attempt",
  );
});

test("a reply with the migrated colon yields nothing, rather than being repaired", async () => {
  const out = await workersAiProvider(replying(REAL_WORD_REPLY)).propose(
    "space",
    12,
  );
  assert.deepEqual(out.candidates, []);
});

test("max_tokens is set, because the default cut replies in half", async () => {
  let sent: Record<string, unknown> = {};
  const ai = {
    async run(_model: string, input: Record<string, unknown>) {
      sent = input;
      return { response: '{"entries":[]}' };
    },
  };
  await workersAiProvider(ai).proposeLayout("t", 11, 11);
  assert.equal(typeof sent.max_tokens, "number");
  assert.ok(
    (sent.max_tokens as number) >= 1024,
    `max_tokens ${sent.max_tokens} is too small for a layout with clues`,
  );
});

test("a reply that is only prose still yields nothing rather than throwing", async () => {
  const out = await workersAiProvider(
    replying("I am sorry, I cannot help with that."),
  ).proposeLayout("t", 11, 11);
  assert.deepEqual(out.entries, []);
});
