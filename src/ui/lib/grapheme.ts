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
  return parts.length > 0 ? (parts[0] ?? null) : null;
}

export function isSingleGrapheme(value: string): boolean {
  return graphemes(value).length === 1;
}
