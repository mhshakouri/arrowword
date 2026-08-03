/* One keypress, one cell. Spec section 9 names this the risk center of the
   project, and it is the same rule the server enforces on both prefilled
   letters and player writes, so the two must agree. */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map((s) => s.segment);
}

/* The first grapheme, or null if there is none. Used where a field should hold
   exactly one letter: taking the first is friendlier than rejecting, because a
   Persian keyboard can emit a letter plus a combining mark and a paste can
   deliver a whole word. */
export function firstGrapheme(value: string): string | null {
  const parts = graphemes(value.trim());
  /* The first grapheme that draws something, rather than simply the first: a
     paste or a keyboard can lead with a zero-width joiner. */
  for (const part of parts) if (isVisible(part)) return part;
  return null;
}

export function isSingleGrapheme(value: string): boolean {
  return graphemes(value).length === 1;
}

/* Whether a grapheme would actually draw something.

   A zero-width non-joiner is a grapheme, and so is a space. Both are legitimate
   in Persian text and neither belongs in a cell on its own: the cell would look
   empty while holding a letter, so it would read as untouched and refuse to look
   filled. ZWNJ is kept inside a nickname for exactly the opposite reason, where
   it is doing real work between letters. */
const INVISIBLE = /^[\s\p{Cf}\p{Cc}\p{Zs}]+$/u;

export function isVisible(value: string): boolean {
  return value.length > 0 && !INVISIBLE.test(value);
}
