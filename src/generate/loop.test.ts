/* The generation pipeline, B3. Section 12 asks for: a recorded invalid proposal
   is repaired, and a proposal that never validates ends as failed.

   The give-up path matters more than the happy path here. A loop that generates
   good puzzles and hangs on bad ones is worse than one that fails politely,
   because the failure is what a visitor meets when a theme is awkward. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, problemsFrom, type Progress } from "./loop.ts";
import { recordedProvider, type Provider } from "./provider.ts";
import {
  LAYOUT_ADJACENT,
  LAYOUT_DISAGREES,
  LAYOUT_NEVER_VALID,
  LAYOUT_OFF_GRID,
  LAYOUT_REPAIRS,
  LAYOUT_VALID,
  RIVERS,
  UNUSABLE,
} from "./fixtures.ts";
import { validate, cellsFrom } from "./validate.ts";

const SMALL = {
  rows: 3,
  cols: 3,
  limits: { maxRows: 11, maxCols: 11, maxEntries: 12 },
};

/* ---- The happy path ---- */

test("a valid layout is playable on the first attempt", async () => {
  const provider = recordedProvider([RIVERS], [LAYOUT_VALID]);
  const out = await generate(provider, "short words", SMALL);
  assert.equal(out.status, "playable");
  assert.equal(provider.layoutCalls, 1, "no repair was needed");
});

test("a playable outcome carries entries that actually validate", async () => {
  const provider = recordedProvider([RIVERS], [LAYOUT_VALID]);
  const out = await generate(provider, "short words", SMALL);
  assert.equal(out.status, "playable");
  if (out.status !== "playable") return;
  const cells = cellsFrom(out.entries, out.rows, out.cols);
  assert.equal(validate(cells, out.entries).ok, true);
});

test("the word list is not fetched when the layout works", async () => {
  const provider = recordedProvider([RIVERS], [LAYOUT_VALID]);
  await generate(provider, "short words", SMALL);
  assert.equal(
    provider.calls,
    0,
    "propose() was called despite a valid layout",
  );
});

/* ---- Named in section 12: a recorded invalid proposal is repaired ---- */

test("a disagreeing crossing is repaired and becomes playable", async () => {
  const provider = recordedProvider([RIVERS], LAYOUT_REPAIRS);
  const out = await generate(provider, "short words", SMALL);
  assert.equal(out.status, "playable");
  assert.equal(provider.layoutCalls, 2, "one proposal and one repair");
});

test("repair is told what was wrong, not merely that it failed", async () => {
  const seen: string[][] = [];
  const provider: Provider = {
    async proposeLayout() {
      return LAYOUT_DISAGREES;
    },
    async repair(_previous, problems) {
      seen.push(problems);
      return LAYOUT_VALID;
    },
    async propose() {
      return RIVERS;
    },
  };
  await generate(provider, "short words", SMALL);
  assert.equal(seen.length, 1);
  /* The detail names the square and both letters, which is the difference
     between a model that fixes the problem and one that produces a new one. */
  assert.match(seen[0]?.[0] ?? "", /0,0/);
});

test("an off-grid entry is reported as such to the repair step", async () => {
  const seen: string[][] = [];
  const provider: Provider = {
    async proposeLayout() {
      return LAYOUT_OFF_GRID;
    },
    async repair(_p, problems) {
      seen.push(problems);
      return LAYOUT_VALID;
    },
    async propose() {
      return RIVERS;
    },
  };
  const out = await generate(provider, "numbers", SMALL);
  assert.equal(out.status, "playable");
  assert.match(seen[0]?.join(" ") ?? "", /outside a 3x3 grid/);
});

test("an unintended adjacency is caught and sent back", async () => {
  const seen: string[][] = [];
  const provider: Provider = {
    async proposeLayout() {
      return LAYOUT_ADJACENT;
    },
    async repair(_p, problems) {
      seen.push(problems);
      return LAYOUT_VALID;
    },
    async propose() {
      return RIVERS;
    },
  };
  await generate(provider, "short words", SMALL);
  assert.match(seen[0]?.join(" ") ?? "", /no entry/);
});

/* ---- Named in section 12: a proposal that never validates ---- */

test("a layout that never validates falls back to packing", async () => {
  const provider = recordedProvider([RIVERS], LAYOUT_NEVER_VALID);
  const out = await generate(provider, "short words", SMALL);
  assert.equal(out.status, "pack");
  if (out.status !== "pack") return;
  assert.ok(out.candidates.length > 2);
});

test("the fallback stops after the configured number of repairs", async () => {
  const provider = recordedProvider([RIVERS], LAYOUT_NEVER_VALID);
  await generate(provider, "short words", { ...SMALL, maxRepairs: 2 });
  assert.equal(provider.layoutCalls, 3, "one proposal plus two repairs");
});

test("maxRepairs of zero tries once and gives up on the layout", async () => {
  const provider = recordedProvider([RIVERS], LAYOUT_NEVER_VALID);
  await generate(provider, "short words", { ...SMALL, maxRepairs: 0 });
  assert.equal(provider.layoutCalls, 1);
});

/* The terminal state. Nothing usable anywhere. */
test("a model that returns nothing usable ends as failed", async () => {
  const provider = recordedProvider([UNUSABLE], LAYOUT_NEVER_VALID);
  const out = await generate(provider, "nonsense", SMALL);
  assert.equal(out.status, "failed");
});

test("the failure reason says something a person could read", async () => {
  const provider = recordedProvider([UNUSABLE], LAYOUT_NEVER_VALID);
  const out = await generate(provider, "nonsense", SMALL);
  assert.equal(out.status, "failed");
  if (out.status !== "failed") return;
  assert.ok(out.reason.length > 20, out.reason);
});

test("a single usable word is not enough to pack, so it fails", async () => {
  const provider = recordedProvider(
    [{ theme: "t", candidates: [{ answer: "CAT", clue: "It ignores you" }] }],
    LAYOUT_NEVER_VALID,
  );
  const out = await generate(provider, "t", SMALL);
  assert.equal(out.status, "failed");
});

/* ---- A provider that throws is an attempt, not an outcome ---- */

test("a provider that throws once still succeeds on the retry", async () => {
  let calls = 0;
  const provider: Provider = {
    async proposeLayout() {
      calls += 1;
      if (calls === 1) throw new Error("network");
      return LAYOUT_VALID;
    },
    async repair() {
      calls += 1;
      if (calls === 1) throw new Error("network");
      return LAYOUT_VALID;
    },
    async propose() {
      return RIVERS;
    },
  };
  const out = await generate(provider, "short words", SMALL);
  assert.equal(out.status, "playable");
});

test("a provider that always throws falls through rather than propagating", async () => {
  const provider: Provider = {
    async proposeLayout() {
      throw new Error("down");
    },
    async repair() {
      throw new Error("down");
    },
    async propose() {
      throw new Error("down");
    },
  };
  const out = await generate(provider, "t", SMALL);
  assert.equal(out.status, "failed");
});

test("an empty entry list is treated as a failed attempt, not a valid puzzle", async () => {
  const provider = recordedProvider(
    [RIVERS],
    [{ theme: "t", rows: 3, cols: 3, entries: [] }],
  );
  const out = await generate(provider, "t", SMALL);
  assert.notEqual(out.status, "playable");
});

/* ---- Progress, which the client renders instead of a spinner ---- */

test("progress is reported for every attempt", async () => {
  const seen: Progress[] = [];
  const provider = recordedProvider([RIVERS], LAYOUT_REPAIRS);
  await generate(provider, "short words", {
    ...SMALL,
    onProgress: (p) => seen.push(p),
  });
  assert.ok(seen.length >= 2);
  assert.ok(seen.some((p) => p.step === "validating"));
});

test("progress attempts count up rather than repeating", async () => {
  const seen: Progress[] = [];
  const provider = recordedProvider([RIVERS], LAYOUT_NEVER_VALID);
  await generate(provider, "short words", {
    ...SMALL,
    onProgress: (p) => seen.push(p),
  });
  const attempts = [...new Set(seen.map((p) => p.attempt))];
  assert.deepEqual(
    attempts,
    [...attempts].sort((a, b) => a - b),
  );
});

test("the packing step is announced before the fallback runs", async () => {
  const seen: Progress[] = [];
  const provider = recordedProvider([RIVERS], LAYOUT_NEVER_VALID);
  await generate(provider, "short words", {
    ...SMALL,
    onProgress: (p) => seen.push(p),
  });
  assert.ok(seen.some((p) => p.step === "packing"));
});

/* ---- problemsFrom ---- */

test("problems are capped so a repair prompt stays repairable", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    code: "crossing-disagrees" as const,
    detail: `problem ${i}`,
    entry: i,
  }));
  assert.equal(problemsFrom(many).length, 8);
});

test("problems carry the validator's own detail strings", () => {
  const out = problemsFrom([
    { code: "off-grid", detail: "reaches 9,9", entry: 0 },
  ]);
  assert.deepEqual(out, ["reaches 9,9"]);
});

/* ---- An outage is not a bad theme ----

   The first real generation failed because the model id was wrong, and the
   loop reported it as the theme's fault, which sent the person who tried it
   away rewording a word that was fine. A message that blames the wrong party
   is worse than a vague one. */

test("a provider that always throws says it was unreachable", async () => {
  const provider: Provider = {
    async proposeLayout() {
      throw new Error("model not found");
    },
    async repair() {
      throw new Error("model not found");
    },
    async propose() {
      throw new Error("model not found");
    },
  };
  const out = await generate(provider, "rivers", SMALL);
  assert.equal(out.status, "failed");
  if (out.status !== "failed") return;
  assert.match(out.reason, /unreachable/);
});

test("a model that answers but says nothing usable blames the theme, not the network", async () => {
  const provider = recordedProvider([UNUSABLE], LAYOUT_NEVER_VALID);
  const out = await generate(provider, "nonsense", SMALL);
  assert.equal(out.status, "failed");
  if (out.status !== "failed") return;
  assert.doesNotMatch(out.reason, /unreachable/);
});

test("one throw among working calls does not read as an outage", async () => {
  let first = true;
  const provider: Provider = {
    async proposeLayout() {
      if (first) {
        first = false;
        throw new Error("flaky");
      }
      return LAYOUT_NEVER_VALID[0]!;
    },
    async repair() {
      return LAYOUT_NEVER_VALID[0]!;
    },
    /* Empty rather than the UNUSABLE fixture: a hand-rolled provider does not
       run `clean()`, so returning that fixture raw would hand the loop five
       usable-looking candidates and produce a packing rather than a failure. */
    async propose() {
      return { theme: "t", candidates: [] };
    },
  };
  const out = await generate(provider, "t", SMALL);
  assert.equal(out.status, "failed");
  if (out.status !== "failed") return;
  assert.doesNotMatch(out.reason, /unreachable/);
});

/* ---- An unparseable answer is re-proposed, not "repaired" ----

   `repair` sends the previous proposal back for correction. Correcting nothing
   returns nothing to correct, so when the first answer failed to parse, two of
   the three attempts were spent asking the model to fix an empty list. */

test("an empty proposal is re-proposed rather than sent for repair", async () => {
  let proposals = 0;
  let repairs = 0;
  const provider: Provider = {
    async proposeLayout(theme, rows, cols) {
      proposals += 1;
      /* Second proposal is the good one, so the test also proves the retry
         actually reaches it. */
      return proposals >= 2 ? LAYOUT_VALID : { theme, rows, cols, entries: [] };
    },
    async repair() {
      repairs += 1;
      return LAYOUT_VALID;
    },
    async propose() {
      return RIVERS;
    },
  };
  const out = await generate(provider, "t", SMALL);
  assert.equal(out.status, "playable");
  assert.equal(proposals, 2, "the empty answer should be asked again");
  assert.equal(repairs, 0, "nothing was there to repair");
});

test("a proposal with entries is sent for repair, not re-proposed", async () => {
  let proposals = 0;
  let repairs = 0;
  const provider: Provider = {
    async proposeLayout() {
      proposals += 1;
      return LAYOUT_DISAGREES;
    },
    async repair() {
      repairs += 1;
      return LAYOUT_VALID;
    },
    async propose() {
      return RIVERS;
    },
  };
  const out = await generate(provider, "t", SMALL);
  assert.equal(out.status, "playable");
  assert.equal(proposals, 1);
  assert.equal(repairs, 1, "a broken layout is worth repairing");
});
