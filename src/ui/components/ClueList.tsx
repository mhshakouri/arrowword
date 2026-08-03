/* The numbered clue list beside the grid. B3, spec section 11.

   Where a photo puzzle's clues live in the photograph and are read by zooming
   into a cell, a generated puzzle has no clue cells at all (invariant 12) and
   its clues live in `entries`. So this is not the ClueZoom overlay with
   different content; it is the other half of a different puzzle form.

   Tapping a clue selects its first cell and lights its run, which is the only
   navigation either renderer offers. It is not auto-advance: the player asked
   to go somewhere and went there. */

import type { Entry } from "../../types";

export function ClueList({
  entries,
  selected,
  onPick,
}: {
  entries: Entry[];
  selected: Entry | null;
  onPick: (entry: Entry) => void;
}) {
  const across = entries
    .filter((e) => e.dir === "across")
    .sort((a, b) => a.number - b.number);
  const down = entries
    .filter((e) => e.dir === "down")
    .sort((a, b) => a.number - b.number);

  const section = (title: string, list: Entry[]) =>
    list.length === 0 ? null : (
      <div class="clue-group">
        <h2 class="clue-heading">{title}</h2>
        <ol class="clue-list">
          {list.map((entry) => {
            const isSelected =
              selected?.dir === entry.dir &&
              selected?.row === entry.row &&
              selected?.col === entry.col;
            return (
              <li key={`${entry.dir}-${entry.number}`}>
                <button
                  type="button"
                  class={`clue${isSelected ? " clue-selected" : ""}`}
                  aria-current={isSelected ? "true" : undefined}
                  /* Explicit, because the name computed from the contents came
                     out empty: the number, the clue and the length are three
                     spans, and a screen reader was reading "button" and
                     nothing else. Section 16 requires state announced to
                     assistive tech, and this is the control that navigates the
                     puzzle. */
                  aria-label={`${entry.number} ${title.toLowerCase()}, ${entry.clue}, ${entry.len} letters`}
                  onClick={() => onPick(entry)}
                >
                  <span class="clue-number">{entry.number}</span>
                  {/* Rendered as text, never as HTML. Model output is
                      untrusted (invariant 8) and it is sanitized on write; this
                      is the second half of that, which is not putting it
                      anywhere that would interpret it. */}
                  <span class="clue-text">{entry.clue}</span>
                  <span class="clue-length" aria-hidden="true">
                    {entry.len}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    );

  return (
    <div class="clues">
      {section("Across", across)}
      {section("Down", down)}
    </div>
  );
}
