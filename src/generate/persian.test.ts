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

/* The groups below are Hossein's ruling of 2026-08-05, one test each, so a
   later "tidy up" of the fold table fails loudly rather than quietly changing
   which words are considered equal. */
test("the alef group folds together: آ ا أ إ ء", () => {
  const forms = ["آب", "اب", "أب", "إب", "ءب"];
  for (const form of forms) assert.equal(normalizePersian(form), "اب");
  assert.equal(normalizePersian("جزء"), "جزا");
});

test("the yeh group folds together: ی ئ ي", () => {
  for (const form of ["دریا", "درئا", "دريا"]) {
    assert.equal(normalizePersian(form), "دریا");
  }
});

test("the waw group folds together: و ؤ", () => {
  assert.equal(normalizePersian("مؤمن"), "مومن");
});

test("the heh group folds together: ه and هٔ", () => {
  /* هٔ is ه plus a combining hamza, so this also pins that DROP handles the
     mark rather than the fold table needing an entry for it. */
  assert.equal(normalizePersian("خانهٔ"), "خانه");
  assert.equal(normalizePersian("خانه"), "خانه");
  /* ة always folds to ه, confirmed 2026-08-05: a word-final ت is sometimes
     written ة and sometimes ه, and ة is rare in Persian either way. */
  assert.equal(normalizePersian("مدرسة"), "مدرسه");
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

/* ---- The trust boundary, which is where folding actually has to happen ----

   `clean` and `readEntries` are the only two places model output enters the
   app, so folding there is what lets the validator, the packer and `check.ts`
   compare plain strings without knowing a language exists. These tests pin
   that, because moving the fold downstream would still pass every test in the
   block above and quietly break every crossing. */

test("a Persian proposal is folded on the way in", async () => {
  const { clean } = await import("./provider.ts");
  /* Arabic yeh in the answer, and the same word spelled with the Persian yeh
     in the clue. Unfolded these are different strings, so the giveaway rule
     would miss and the crossing check would later disagree with itself. */
  const out = clean(
    { theme: "t", candidates: [{ answer: "دريا", clue: "آب شور" }] },
    "fa",
  );
  assert.equal(out.candidates[0]?.answer, "دریا");
});

test("a Persian answer with a ZWNJ is measured in squares, not code points", async () => {
  const { clean } = await import("./provider.ts");
  const out = clean(
    { theme: "t", candidates: [{ answer: "می‌شود", clue: "اتفاق می‌افتد" }] },
    "fa",
  );
  assert.equal(out.candidates[0]?.answer, "میشود");
});

test("English is untouched by any of this", async () => {
  const { clean } = await import("./provider.ts");
  const out = clean(
    { theme: "t", candidates: [{ answer: "river", clue: "It flows" }] },
    "en",
  );
  assert.equal(out.candidates[0]?.answer, "RIVER");
});

test("a Persian clue that gives its answer away is dropped", async () => {
  const { clean } = await import("./provider.ts");
  const out = clean(
    { theme: "t", candidates: [{ answer: "کتاب", clue: "کتاب را بخوان" }] },
    "fa",
  );
  assert.deepEqual(out.candidates, []);
});

test("an English word is not a valid Persian answer, and the reverse", async () => {
  const { clean } = await import("./provider.ts");
  assert.deepEqual(
    clean({ theme: "t", candidates: [{ answer: "RIVER", clue: "c" }] }, "fa")
      .candidates,
    [],
  );
  assert.deepEqual(
    clean({ theme: "t", candidates: [{ answer: "دریا", clue: "c" }] }, "en")
      .candidates,
    [],
  );
});

test("the recorded Persian fixture survives cleaning the way it should", async () => {
  const { clean } = await import("./provider.ts");
  const { BIRDS_FA } = await import("./fixtures.ts");
  const out = clean(BIRDS_FA, "fa");
  const answers = out.candidates.map((c) => c.answer);

  /* Folded: the fixture holds شكاري with the Arabic kaf and yeh, which is what
     the model really sent. */
  assert.ok(
    answers.includes("شکاری"),
    `expected the folded form, got ${JSON.stringify(answers)}`,
  );
  assert.ok(!answers.includes("شكاري"), "the Arabic spelling must not survive");

  /* Dropped: a clue containing its answer, and a two-word answer. */
  assert.ok(!answers.includes("کلاغ"), "the giveaway clue must be dropped");
  assert.ok(
    !answers.some((a) => a.includes(" ")),
    "a two-word answer cannot go in a run of squares",
  );

  /* Dropped by the cross-answer rule, and this is the fixture earning its
     keep. «عقاب» is clued «پرنده‌ای شکاری و بزرگ» while «شکاری» is itself an
     answer in the same set, so solving one hands over the other. The model
     really did this, here and again on an English "rivers" run where MISSOURI
     was clued "Flows into the Mississippi River eventually" beside
     MISSISSIPPI. */
  assert.ok(
    !answers.includes("عقاب"),
    "a clue naming another answer must be dropped",
  );

  /* Everything that survives is a placeable Persian word. */
  for (const a of answers) {
    assert.ok(isPersianAnswer(a), `${a} is not placeable`);
    assert.ok(persianLength(a) >= 3 && persianLength(a) <= 11);
  }
  assert.equal(answers.length, 7);
});
