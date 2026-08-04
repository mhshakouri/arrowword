/* The cases these cover are the ones that make a crossing silently wrong, so
   each is a spelling a model or a person actually produces rather than a
   theoretical code point. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPersianAnswer,
  normalizePersian,
  persianGivesItAway,
  persianLength,
} from "./persian.ts";

test("Arabic yeh and kaf fold to their Persian letters", () => {
  /* The pair that ruins crossings: identical on screen, different code points,
     and a model trained mostly on Arabic emits them constantly. */
  assert.equal(normalizePersian("كتاب"), "کتاب");
  assert.equal(normalizePersian("دريا"), "دریا");
  assert.notEqual("كتاب", "کتاب");
  assert.equal(normalizePersian("كتاب"), normalizePersian("کتاب"));
});

test("a zero-width non-joiner is not a square", () => {
  const withZwnj = "می‌شود";
  assert.equal(persianLength(normalizePersian(withZwnj)), 5);
  assert.equal(normalizePersian(withZwnj), "میشود");
});

test("diacritics and tatweel are dropped", () => {
  assert.equal(normalizePersian("کِتاب"), "کتاب");
  assert.equal(normalizePersian("کـتـاب"), "کتاب");
});

test("alef spellings fold together", () => {
  assert.equal(normalizePersian("آب"), "اب");
  assert.equal(normalizePersian("أمير"), "امیر");
});

test("a normalized answer is letters only", () => {
  assert.ok(isPersianAnswer(normalizePersian("کتاب")));
  assert.ok(isPersianAnswer(normalizePersian("دريا")));
  /* Two words cannot go in one run of squares, and are rejected rather than
     joined, for the same reason "ST. LOUIS" is rejected in English. */
  assert.ok(!isPersianAnswer(normalizePersian("کتاب خانه")));
  assert.ok(!isPersianAnswer(normalizePersian("ORBIT")));
  assert.ok(!isPersianAnswer(normalizePersian("کتاب2")));
  assert.ok(!isPersianAnswer(""));
});

test("length counts squares, not code points before folding", () => {
  assert.equal(persianLength(normalizePersian("کِتاب")), 4);
  assert.equal(persianLength(normalizePersian("آسمان")), 5);
});

test("a clue containing its answer is caught in Persian", () => {
  /* The English rule uses \b, which is ASCII-only, so this check silently
     never fired in Persian: the whole reason this function exists. */
  assert.ok(persianGivesItAway("کتاب را بخوان", "کتاب"));
  /* Across spellings, too: an Arabic yeh in the clue must not hide a Farsi
     yeh in the answer. */
  assert.ok(persianGivesItAway("دريا آبی است", "دریا"));
});

test("a longer word merely containing the answer is not a giveaway", () => {
  /* The English version shipped as a substring match and starved the fallback,
     killing ART for "departure". The Persian boundary must not repeat it:
     «کتابخانه» contains «کتاب» and is a different word. */
  assert.ok(!persianGivesItAway("جایی پر از کتابخانه", "کتاب"));
  assert.ok(!persianGivesItAway("محل نگهداری کتاب‌ها", "کتابخانه"));
});
