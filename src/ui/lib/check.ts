/* Checking answers, for generated puzzles only. Amends ADR-1, see section 17.

   ADR-1 says the app never checks answers, and its stated reason is that "the
   write path never becomes an oracle that tells a player they guessed
   correctly". That reason is about the **server**, and this does not touch it:
   the answers are already in the document on this device, put there by ADR-13
   on the reasoning that a puzzle you generated for yourself has nothing to
   defend. Comparing two strings that are both already here adds no capability
   to anyone.

   Scope, deliberately narrow:

   - **Generated puzzles only.** A photographed arrowword has no `entries` and
     therefore no answers, so there is nothing to compare against. Nobody
     transcribes the solution of a printed puzzle to make this work.
   - **Asked for, never volunteered.** Nothing here runs while somebody types.
     A grid that colors itself as you go is a different game, and ADR-1's real
     objection, that being told you are right removes the point of thinking,
     applies to unsolicited feedback rather than to a button somebody pressed.
   - **Says what is wrong, not what is right.** Wrong squares are named. The
     correct letters are not filled in, because that is a reveal and a reveal
     is a different feature with a different argument. */

import type { Entry, LetterValue } from "../../types";

export interface Marked {
  /* Every square an entry covers that has a letter in it and should not. */
  wrong: Array<{ row: number; col: number }>;
  /* Answer squares with nothing typed yet. Not wrong, just unfinished, and the
     difference matters: "you have three mistakes" and "you have three squares
     left" are different sentences. */
  blank: number;
  /* Entries whose every square is filled and correct. */
  solved: number;
  entries: number;
  complete: boolean;
}

function cellsOf(entry: Entry): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = [];
  for (let i = 0; i < entry.len; i += 1) {
    out.push(
      entry.dir === "across"
        ? { row: entry.row, col: entry.col + i }
        : { row: entry.row + i, col: entry.col },
    );
  }
  return out;
}

/* Compared case-insensitively and after trimming, because the grid uppercases
   what is typed but a letter that arrived from a paste, another device, or an
   older client may not have. A player being told a correct letter is wrong
   because of its case would be the worst possible version of this feature. */
const same = (a: string, b: string) =>
  a.trim().toLocaleUpperCase() === b.trim().toLocaleUpperCase();

export function mark(
  entries: Entry[],
  letters: Record<string, LetterValue>,
): Marked {
  const wrong: Array<{ row: number; col: number }> = [];
  const seen = new Set<string>();
  let blank = 0;
  let solved = 0;

  for (const entry of entries) {
    const answer = [...entry.answer];
    let full = true;
    let right = true;

    cellsOf(entry).forEach((cell, i) => {
      const key = `${cell.row},${cell.col}`;
      const typed = letters[key]?.ch ?? "";
      const expected = answer[i] ?? "";

      if (!typed) {
        full = false;
        right = false;
        /* Counted once even where two entries cross it, or a shared blank
           square would be reported twice. */
        if (!seen.has(`blank:${key}`)) {
          seen.add(`blank:${key}`);
          blank += 1;
        }
        return;
      }
      if (!same(typed, expected)) {
        right = false;
        if (!seen.has(`wrong:${key}`)) {
          seen.add(`wrong:${key}`);
          wrong.push(cell);
        }
      }
    });

    if (full && right) solved += 1;
  }

  return {
    wrong,
    blank,
    solved,
    entries: entries.length,
    complete: entries.length > 0 && solved === entries.length,
  };
}
