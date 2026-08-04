/* The compiler already guarantees both dictionaries have every key with the
   right shape, so these tests check the one thing types cannot: that the
   Persian is actually Persian. An `en` string pasted into `fa` to get the
   build passing satisfies the type and fails here. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { en } from "./en.ts";
import { fa } from "./fa.ts";

/* Deliberately identical across languages: brand names do not translate. */
const SAME = new Set(["landing.title"]);

type Dict = Record<string, unknown>;

function leaves(
  obj: Dict,
  path: string[] = [],
): Array<{ path: string; value: unknown }> {
  return Object.entries(obj).flatMap(([key, value]) => {
    const here = [...path, key];
    return typeof value === "object" && value !== null
      ? leaves(value as Dict, here)
      : [{ path: here.join("."), value }];
  });
}

test("no dictionary leaf is an empty string", () => {
  for (const dict of [en, fa]) {
    for (const leaf of leaves(dict as unknown as Dict)) {
      if (typeof leaf.value === "string") {
        assert.notEqual(leaf.value.trim(), "", `${leaf.path} is empty`);
      }
    }
  }
});

test("every Persian string differs from its English counterpart", () => {
  const english = new Map(
    leaves(en as unknown as Dict).map((l) => [l.path, l.value]),
  );
  for (const leaf of leaves(fa as unknown as Dict)) {
    if (typeof leaf.value !== "string" || SAME.has(leaf.path)) continue;
    assert.notEqual(
      leaf.value,
      english.get(leaf.path),
      `${leaf.path} was not translated`,
    );
  }
});

test("Persian strings contain no Latin digits", () => {
  /* The digit rule in fa.ts, enforced: a count that renders as `3` inside
     Persian prose means somebody forgot `d()`. */
  for (const leaf of leaves(fa as unknown as Dict)) {
    if (typeof leaf.value !== "string") continue;
    assert.doesNotMatch(
      leaf.value,
      /[0-9]/,
      `${leaf.path} contains Latin digits`,
    );
  }
});
