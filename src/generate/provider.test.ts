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
  assert.equal(GENERATION_MODEL, "@cf/meta/llama-3.1-8b-instruct-fp8");
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

/* ---- readEntries accepts the shapes a model actually produces ---- */

test("a layout split into across and down arrays is read", async () => {
  const ai = {
    async run() {
      return {
        response: JSON.stringify({
          across: [{ row: 0, col: 0, answer: "CAT", clue: "It ignores you" }],
          down: [{ row: 0, col: 0, answer: "COT", clue: "A small bed" }],
        }),
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0]?.dir, "across");
  assert.equal(out.entries[1]?.dir, "down");
});

test("a bare array of entries is read", async () => {
  const ai = {
    async run() {
      return {
        response: JSON.stringify([
          {
            dir: "across",
            row: 0,
            col: 0,
            answer: "CAT",
            clue: "It ignores you",
          },
        ]),
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.equal(out.entries.length, 1);
});

test("prose around the JSON does not stop it being read", async () => {
  const ai = {
    async run() {
      return {
        response:
          'Sure! Here is your crossword:\n```json\n{"entries":[{"dir":"down","row":1,"col":2,"answer":"COT","clue":"A small bed"}]}\n```\nHope that helps.',
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

test("a model that rejects the schema is retried without it, not reported as down", async () => {
  const modes: boolean[] = [];
  const ai = {
    async run(_model: string, input: Record<string, unknown>) {
      const withSchema = "response_format" in input;
      modes.push(withSchema);
      if (withSchema) throw new Error("json_schema not supported");
      return {
        response:
          '{"entries":[{"dir":"across","row":0,"col":0,"answer":"CAT","clue":"It ignores you"}]}',
      };
    },
  };
  const out = await workersAiProvider(ai).proposeLayout("t", 5, 5);
  assert.deepEqual(modes, [true, false], "should try schema then plain");
  assert.equal(out.entries.length, 1, "the plain retry result is used");
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

test("a truncated layout still yields the entries that arrived intact", async () => {
  const out = await workersAiProvider(
    replying(REAL_TRUNCATED_LAYOUT),
  ).proposeLayout("space", 11, 11);
  assert.equal(out.entries.length, 3, "SPACE, EARTH and MOON are complete");
  assert.deepEqual(
    out.entries.map((e) => e.answer),
    ["SPACE", "EARTH", "MOON"],
  );
  assert.equal(
    out.entries.some((e) => e.answer === "COMET"),
    false,
    "the entry cut off mid-word must not be salvaged",
  );
});

test("the migrated colon is repaired, so eleven candidates are not lost", async () => {
  const out = await workersAiProvider(replying(REAL_WORD_REPLY)).propose(
    "space",
    12,
  );
  assert.ok(
    out.candidates.length >= 7,
    `only ${out.candidates.length} survived: ${JSON.stringify(out.candidates)}`,
  );
  assert.ok(out.candidates.some((c) => c.answer === "MARS"));
  assert.ok(out.candidates.some((c) => c.answer === "NEBULA"));
});

test("repairing punctuation never invents or alters an answer", async () => {
  const out = await workersAiProvider(replying(REAL_WORD_REPLY)).propose(
    "space",
    12,
  );
  for (const c of out.candidates) {
    assert.match(c.answer, /^[A-Z]+$/);
    assert.ok(REAL_WORD_REPLY.includes(c.answer), `${c.answer} was invented`);
  }
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
