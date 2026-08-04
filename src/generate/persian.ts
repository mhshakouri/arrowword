/* Persian answers, reduced to what a grid square can hold.

   Every comparison in generation is a letter comparison: the validator checks
   that a crossing's across letter equals its down letter, the packer looks for
   shared letters, and `check.ts` compares what somebody typed against the
   answer. In English that works because a letter is a letter. In Persian the
   same word has several spellings that are the same word, and unless they are
   folded to one form first, every one of those comparisons is a coin toss.

   Four kinds of difference, all of them common in model output and in what
   people type:

   1. **Arabic characters for Persian letters.** ي (U+064A) for ی (U+06CC) and
      ك (U+0643) for ک (U+06A9) are the big two: they render nearly identically
      and are different code points. A model trained mostly on Arabic emits
      them constantly.
   2. **Diacritics and tatweel.** Harakat are pronunciation marks, not letters,
      and tatweel is a stretching character. Neither occupies a square.
   3. **Zero-width non-joiner.** «می‌شود» is written with a ZWNJ, and it is one
      word of five letters, not six. A cell cannot hold a ZWNJ (invariant: A5
      already refuses a grapheme that draws nothing).
   4. **Alef with hamza and madda.** أ إ ٱ are spellings of ا.

   `آ` folds to `ا` as well, and that is a **judgement call rather than a
   typographic fact**. Iranian crossword convention generally treats them as one
   square, and folding is the forgiving direction: a solver who types ا where
   the answer holds آ is right, which is how a person doing a puzzle on paper
   would score it. The alternative, treating them as distinct, makes a correct
   solver wrong on a distinction the grid cannot show. Flagged in D2's human
   check so a native speaker confirms rather than inherits it. */

/* Folded to the letter on the right. Order matters only in that every source
   here is a single code point, so a single pass is enough.

   **The groups are Hossein's, given on 2026-08-05**, which settles the آ
   question this module opened: آ ا أ إ ء are one letter, ی ئ ي are one, و ؤ
   are one, and ه هٔ are one. That is the ruling of the person the puzzle is
   for, and it is what a solver on paper would score.

   **One conflict in it, resolved here and worth re-checking.** ة was listed in
   two groups, with ت and with ه. It can only fold one way: folding it both
   ways would make ت equal ه by transitivity, and «تا» and «ها» are not the
   same word. It folds to ه, which is the ordinary Persian treatment of Arabic
   loanwords (مدرسة is written مدرسه). If the intent was ت, this line is the
   only thing to change. */
const FOLD: Record<string, string> = {
  ي: "ی" /* ي Arabic yeh    -> ی Farsi yeh */,
  ى: "ی" /* ى alef maksura  -> ی */,
  ئ: "ی" /* ئ yeh with hamza -> ی */,
  ك: "ک" /* ك Arabic kaf    -> ک keheh */,
  ة: "ه" /* ة teh marbuta   -> ه, see the conflict above */,
  ؤ: "و" /* ؤ waw with hamza -> و */,
  أ: "ا" /* أ alef with hamza above -> ا */,
  إ: "ا" /* إ alef with hamza below -> ا */,
  آ: "ا" /* آ alef with madda -> ا */,
  ٱ: "ا" /* ٱ alef wasla    -> ا */,
  ء: "ا" /* ء standalone hamza -> ا, so جزء and جزا are one word */,
};

/* هٔ needs no entry: it is ه followed by U+0654, and DROP removes the mark,
   which leaves ه on its own. Covered by a test rather than left to be
   rediscovered. */

/* Dropped outright: they are marks or joiners, never squares. U+064B to U+0652
   are the harakat, U+0640 is tatweel, U+200B to U+200D cover ZWNJ and its
   neighbours, and U+0654/U+0655 are the hamza marks left over once the letters
   above are folded. */
const DROP = /[\u064B-\u0652\u0640\u200B-\u200D\u0654\u0655]/;

/* The alphabet a square may hold, after folding. Deliberately not a range:
   ranges over this block include the Arabic-only letters this module exists to
   remove, so an explicit list is what makes `isPersianAnswer` mean anything. */
const LETTERS = "ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی";
const LETTER_SET = new Set(LETTERS);

/* One word, folded, marks removed, ready to be compared letter by letter or
   laid into squares. Whitespace around it goes; whitespace inside it does not,
   because a two-word answer is not a thing this app can render and must be
   rejected rather than silently joined. That is the same reasoning the English
   path uses for "ST. LOUIS". */
export function normalizePersian(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFC").trim()) {
    if (DROP.test(ch)) continue;
    out += FOLD[ch] ?? ch;
  }
  return out;
}

/* True when every character is a letter this grid can show. Run on the
   normalized form: the point is to reject «کتاب خانه» and «ORBIT» and
   «کتاب2», not to reject ي, which folding already handled. */
export function isPersianAnswer(normalized: string): boolean {
  if (!normalized) return false;
  for (const ch of normalized) if (!LETTER_SET.has(ch)) return false;
  return true;
}

/* How many squares the word needs. Persian has no case and, once normalized,
   no combining marks, so this is a plain code point count rather than a
   grapheme walk: every remaining character is exactly one square. */
export function persianLength(normalized: string): number {
  return [...normalized].length;
}

/* True when the clue hands over its own answer.

   The English path uses `\b`, which is defined in terms of `\w`, which is
   ASCII: `\bکتاب\b` matches nothing at all, so the whole-word rule silently
   became "never rejects" in Persian and clues containing their answers would
   have sailed through. Persian words are separated by spaces and ZWNJ rather
   than by anything `\w` knows about, so the boundary is written out as "not a
   Persian letter". Both sides are normalized first, or ي in the clue would
   hide an ی in the answer. */
export function persianGivesItAway(clue: string, answer: string): boolean {
  const a = normalizePersian(answer);
  if (!a) return false;
  const c = normalizePersian(clue);
  const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^${LETTERS}])${escaped}($|[^${LETTERS}])`).test(c);
}
