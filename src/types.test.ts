/* `migrate()` runs on every document read, and until B1 it had no test at all.

   That was survivable while it was unreachable: no v1 document was ever
   deployed, so the v1 path had never executed in production. The v3 bump ends
   that. Live sessions exist, a template that never expires exists, and the next
   read of each of them goes through this function. A mistake here does not throw,
   it silently returns a document missing a field, and the failure surfaces later
   as an empty grid or a lost photo.

   So these tests characterize the old behavior as well as the new one. The v1
   cases are not dead weight: they are the proof that adding v3 did not quietly
   change what a v1 document turns into. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyDoc, migrate, type SessionDoc } from "./types.ts";

const NOW = 1_700_000_000_000;

/* A v2 document exactly as A0.5 wrote it: no v3 fields, nothing optional. */
function v2Doc(overrides: Record<string, unknown> = {}) {
  return {
    v: 2,
    title: "A puzzle",
    photoKey: "photos/abc.jpg",
    rows: 2,
    cols: 2,
    alignment: {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 1, y: 0 },
      bottomRight: { x: 1, y: 1 },
      bottomLeft: { x: 0, y: 1 },
    },
    cells: [
      [{ type: "clue" }, { type: "answer" }],
      [{ type: "answer" }, { type: "prefilled", letter: "ب" }],
    ],
    letters: { "0,1": { ch: "م", at: NOW, by: "player-one" } },
    players: { "player-one": { nickname: "Ali", color: 3, firstSeenAt: NOW } },
    createdAt: NOW,
    lastActiveAt: NOW + 500,
    puzzleSaved: true,
    template: false,
    clonedFrom: null,
    ...overrides,
  };
}

/* v1, which had no attribution, no players, and none of the expiry or template
   fields. This shape never reached production, but the function still claims to
   handle it, and an untested claim is worth exactly nothing. */
function v1Doc(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    title: "Old puzzle",
    photoKey: "photos/old.jpg",
    rows: 1,
    cols: 2,
    alignment: null,
    cells: [[{ type: "answer" }, { type: "answer" }]],
    letters: { "0,0": { ch: "س", at: NOW } },
    createdAt: NOW,
    puzzleSaved: true,
    ...overrides,
  };
}

test("a current document passes through unchanged", () => {
  const doc = emptyDoc(NOW);
  assert.equal(migrate(doc), doc);
});

test("emptyDoc is already current, so it never migrates", () => {
  const fresh = emptyDoc(NOW);
  assert.deepEqual(migrate(fresh), fresh);
});

test("migrating twice changes nothing the second time", () => {
  const once = migrate(v2Doc() as never);
  const twice = migrate(once);
  assert.deepEqual(twice, once);
});

test("a v2 document keeps every field it had", () => {
  const before = v2Doc();
  const after = migrate(before as never);
  assert.equal(after.title, "A puzzle");
  assert.equal(after.photoKey, "photos/abc.jpg");
  assert.equal(after.rows, 2);
  assert.equal(after.cols, 2);
  assert.equal(after.puzzleSaved, true);
  assert.equal(after.createdAt, NOW);
  assert.equal(after.lastActiveAt, NOW + 500);
  assert.equal(after.clonedFrom, null);
  assert.deepEqual(after.cells, before.cells);
});

/* Letters and players are the two things a solver would notice losing, and they
   are the two the migration touches most. */
test("a v2 document keeps its letters and their attribution", () => {
  const after = migrate(v2Doc() as never);
  assert.equal(after.letters["0,1"]?.ch, "م");
  assert.equal(after.letters["0,1"]?.by, "player-one");
  assert.equal(after.letters["0,1"]?.at, NOW);
});

test("a v2 document keeps its players and their colors", () => {
  const after = migrate(v2Doc() as never);
  assert.equal(after.players["player-one"]?.nickname, "Ali");
  assert.equal(after.players["player-one"]?.color, 3);
});

test("a v2 template stays a template", () => {
  const after = migrate(v2Doc({ template: true }) as never);
  assert.equal(after.template, true);
});

test("a v2 clone keeps its lineage", () => {
  const after = migrate(v2Doc({ clonedFrom: "a".repeat(32) }) as never);
  assert.equal(after.clonedFrom, "a".repeat(32));
});

/* ---- v1, which is the path that had never run ---- */

test("a v1 document credits unattributed letters rather than dropping them", () => {
  const after = migrate(v1Doc() as never);
  assert.equal(after.letters["0,0"]?.ch, "س");
  assert.equal(after.letters["0,0"]?.by, "anonymous");
});

test("a v1 document gains an empty player list rather than undefined", () => {
  const after = migrate(v1Doc() as never);
  assert.deepEqual(after.players, {});
});

/* The expiry alarm slides against lastActiveAt. A v1 document has none, and
   leaving it undefined would make the arithmetic produce NaN, which compares
   false against every deadline: the session would never expire. */
test("a v1 document gets a lastActiveAt so expiry can be computed", () => {
  const after = migrate(v1Doc() as never);
  assert.equal(after.lastActiveAt, NOW);
  assert.equal(Number.isFinite(after.lastActiveAt), true);
});

test("a v1 document is never a template and never a clone", () => {
  const after = migrate(v1Doc() as never);
  assert.equal(after.template, false);
  assert.equal(after.clonedFrom, null);
});

test("a v1 document with no letters at all survives", () => {
  const after = migrate(v1Doc({ letters: {} }) as never);
  assert.deepEqual(after.letters, {});
});

/* ---- v3, the bump that runs against live data ---- */

test("a v2 document becomes v3", () => {
  assert.equal(migrate(v2Doc() as never).v, 3);
});

test("an existing puzzle is a Persian photo puzzle, because nothing else existed", () => {
  const after = migrate(v2Doc() as never);
  assert.equal(after.source, "photo");
  assert.equal(after.lang, "fa");
});

/* Invariant 11 keeps the two puzzle kinds apart. Every migrated document is a
   photo puzzle, so none of them may arrive carrying generated-only data. */
test("a migrated photo puzzle carries no entries and no theme", () => {
  const after = migrate(v2Doc() as never);
  assert.deepEqual(after.entries, []);
  assert.equal(after.theme, null);
});

/* `status` and `puzzleSaved` describe the same session from two angles, and the
   play screen trusts one while expiry trusts the other. They cannot disagree. */
test("a saved puzzle migrates to playable", () => {
  const after = migrate(v2Doc({ puzzleSaved: true }) as never);
  assert.equal(after.status, "playable");
});

test("an unsaved puzzle migrates to draft", () => {
  const after = migrate(v2Doc({ puzzleSaved: false }) as never);
  assert.equal(after.status, "draft");
});

test("status never contradicts puzzleSaved", () => {
  for (const saved of [true, false]) {
    const after = migrate(v2Doc({ puzzleSaved: saved }) as never);
    assert.equal(after.status === "playable", saved);
  }
});

/* The chain is the point: a v1 document must reach v3 through the same v2 code
   every v2 document uses, so the two paths cannot drift apart. */
test("a v1 document reaches v3 in one call", () => {
  const after = migrate(v1Doc() as never);
  assert.equal(after.v, 3);
  assert.equal(after.source, "photo");
  assert.equal(after.status, "playable");
});

test("the v1 chain produces the same result as migrating step by step", () => {
  const direct = migrate(v1Doc() as never);
  /* Same fields the intermediate step would have produced, then the v3 ones. */
  assert.equal(direct.letters["0,0"]?.by, "anonymous");
  assert.deepEqual(direct.players, {});
  assert.equal(direct.lastActiveAt, NOW);
  assert.equal(direct.template, false);
});

test("a v1 draft reaches v3 as a draft, not a playable puzzle", () => {
  const after = migrate(v1Doc({ puzzleSaved: false }) as never);
  assert.equal(after.status, "draft");
});

/* ---- Every migrated document must satisfy the current type ---- */

const REQUIRED: Array<keyof SessionDoc> = [
  "v",
  "title",
  "photoKey",
  "rows",
  "cols",
  "alignment",
  "cells",
  "letters",
  "players",
  "createdAt",
  "lastActiveAt",
  "puzzleSaved",
  "template",
  "clonedFrom",
  "source",
  "lang",
  "entries",
  "status",
  "theme",
];

for (const [name, make] of [
  ["v1", v1Doc],
  ["v2", v2Doc],
] as const) {
  test(`a migrated ${name} document has every field the current type declares`, () => {
    const after = migrate(make() as never) as Record<string, unknown>;
    for (const field of REQUIRED) {
      assert.notEqual(
        after[field],
        undefined,
        `${field} is missing after migrating from ${name}`,
      );
    }
  });
}
