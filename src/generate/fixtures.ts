/* Recorded model output, so the suite runs with no API key and no neurons.

   Section 7: "The provider sits behind an interface, and the acceptance suite
   runs against recorded proposals: valid ones, ones with a disagreeing
   crossing, one that runs off-grid, and one that never becomes valid so the
   give-up path is exercised. CI holds no API key and must not."

   These are shaped like real Workers AI output rather than like ideal input.
   That is the point: the messy ones below carry the mistakes models actually
   make, lowercase answers, a clue containing its own answer, a two-word phrase,
   an empty clue. If the fixtures were pre-cleaned, `clean()` would be tested
   against nothing and the first real model call would find the bugs. */

import type { LayoutProposal, Proposal } from "./provider.ts";

/* ---- Layouts, as the model proposes them: words with coordinates ---- */

const e = (
  number: number,
  dir: "across" | "down",
  row: number,
  col: number,
  answer: string,
  clue: string,
) => ({ number, dir, row, col, len: answer.length, clue, answer });

/* Valid. CAT/COT/TOP/TAP around a 3x3 ring, every crossing agreeing.

     C A T
     O . O
     T A P
*/
export const LAYOUT_VALID: LayoutProposal = {
  theme: "short words",
  rows: 3,
  cols: 3,
  entries: [
    e(1, "across", 0, 0, "CAT", "It ignores you deliberately"),
    e(1, "down", 0, 0, "COT", "A small bed"),
    e(2, "down", 0, 2, "TOP", "The highest point"),
    e(3, "across", 2, 0, "TAP", "Water comes out of it"),
  ],
};

/* Named in section 12: a disagreeing crossing. The down entry starts with D
   where the across entry says C, which is the single most common way a model
   layout fails. */
export const LAYOUT_DISAGREES: LayoutProposal = {
  theme: "short words",
  rows: 3,
  cols: 3,
  entries: [
    e(1, "across", 0, 0, "CAT", "It ignores you deliberately"),
    e(1, "down", 0, 0, "DOT", "A small round mark"),
  ],
};

/* Named in section 12: an entry running off-grid. FOUR needs four columns and
   the model declared three. */
export const LAYOUT_OFF_GRID: LayoutProposal = {
  theme: "numbers",
  rows: 3,
  cols: 3,
  entries: [
    e(1, "across", 0, 0, "FOUR", "One more than three"),
    e(1, "down", 0, 0, "FIN", "A swimmer's blade"),
  ],
};

/* Two parallel entries with no crossing, which creates unclued runs in the
   perpendicular direction. Reads as a grid until you try to solve it. */
export const LAYOUT_ADJACENT: LayoutProposal = {
  theme: "short words",
  rows: 2,
  cols: 3,
  entries: [
    e(1, "across", 0, 0, "CAT", "It ignores you deliberately"),
    e(2, "across", 1, 0, "OAR", "You row with it"),
  ],
};

/* One broken layout then a valid one, for the repair path. */
export const LAYOUT_REPAIRS: LayoutProposal[] = [
  LAYOUT_DISAGREES,
  LAYOUT_VALID,
];

/* A model that never fixes it. `recordedProvider` repeats its last layout
   forever, so this exercises exhausting the repairs. */
export const LAYOUT_NEVER_VALID: LayoutProposal[] = [LAYOUT_DISAGREES];

/* Clean, usable, and enough words to pack a small grid. */
export const RIVERS: Proposal = {
  theme: "rivers",
  candidates: [
    { answer: "DELTA", clue: "Where a river fans out to meet the sea" },
    { answer: "BANK", clue: "You stand on it to fish" },
    { answer: "MOUTH", clue: "The end of the journey to the ocean" },
    { answer: "SOURCE", clue: "Where it all begins, often a spring" },
    { answer: "RAPIDS", clue: "White water, fast and shallow" },
    { answer: "BASIN", clue: "All the land that drains to one channel" },
    { answer: "TIDE", clue: "The sea's daily rise, felt far upstream" },
    { answer: "SILT", clue: "Fine grains carried along and dropped" },
    { answer: "BEND", clue: "A curve in the channel" },
    { answer: "REED", clue: "Tall grass at the water's edge" },
  ],
};

/* What a model actually returns on a good day: mostly fine, with four entries
   that must not survive `clean()`. Each bad one is a mistake seen in practice
   rather than invented. */
export const MESSY: Proposal = {
  theme: "kitchen",
  candidates: [
    { answer: "whisk", clue: "You beat eggs with it" },
    /* Two words. Stripping the space would produce a non-word. */
    { answer: "FRYING PAN", clue: "Flat, with a handle" },
    /* The clue contains its own answer, which models do constantly. */
    { answer: "LADLE", clue: "A ladle for serving soup" },
    { answer: "SIEVE", clue: "It lets the water out and keeps the rest" },
    /* Empty clue. */
    { answer: "OVEN", clue: "" },
    /* Duplicate of the first, differing only in case. */
    { answer: "WHISK", clue: "For whipping cream by hand" },
    { answer: "KNIFE", clue: "The one tool worth buying well" },
    /* Too short to be worth a clue at this grid size. */
    { answer: "PA", clue: "Short for a cooking vessel" },
    { answer: "GRATER", clue: "Reduces cheese to shreds" },
  ],
};

/* Nothing usable at all: every candidate breaks a rule. Drives the give-up
   path, because no amount of retrying turns this into a puzzle. */
export const UNUSABLE: Proposal = {
  theme: "nonsense",
  candidates: [
    { answer: "", clue: "Nothing" },
    { answer: "12345", clue: "Numbers are not letters" },
    { answer: "A", clue: "One letter is not a word" },
    { answer: "SUPERCALIFRAGILISTIC", clue: "Far too long for the grid" },
    { answer: "CAFÉ", clue: "An accent no grid square can hold" },
  ],
};

/* Enough words that share letters to pack densely, used where a test needs a
   grid with real crossings rather than a plausible theme. */
export const CROSSING_RICH: Proposal = {
  theme: "short words",
  candidates: [
    { answer: "CAT", clue: "It ignores you deliberately" },
    { answer: "COT", clue: "A small bed" },
    { answer: "TAP", clue: "Water comes out of it" },
    { answer: "TOP", clue: "The highest point" },
    { answer: "ART", clue: "What galleries hang" },
    { answer: "OAT", clue: "Porridge starts here" },
    { answer: "APT", clue: "Fitting, suitable" },
    { answer: "PAT", clue: "A gentle touch" },
  ],
};

/* A model that keeps saying the same unusable thing. `recordedProvider`
   repeats its last proposal forever, so a list ending in UNUSABLE exercises
   retry followed by giving up rather than an infinite loop. */
export const NEVER_VALID: Proposal[] = [UNUSABLE, UNUSABLE];

/* One bad attempt then a good one, for the repair and retry path. */
export const RECOVERS: Proposal[] = [UNUSABLE, RIVERS];

/* ---- Named sets the acceptance suite selects with GENERATION_FIXTURES ----

   The suffix convention is what `providerFor` in the worker looks for: a set
   named FOO supplies word lists and FOO_LAYOUTS supplies layouts. Named rather
   than passed as JSON so a test selects a scenario by intent, and so a typo
   fails loudly at the first call rather than quietly generating something
   else. */

/* The model lays out a valid puzzle first time. */
export const GOOD: Proposal[] = [RIVERS];
export const GOOD_LAYOUTS: LayoutProposal[] = [LAYOUT_VALID];

/* The model cannot lay one out, so the client is asked to pack instead. */
export const FALLBACK: Proposal[] = [CROSSING_RICH];
export const FALLBACK_LAYOUTS: LayoutProposal[] = [LAYOUT_DISAGREES];

/* Nothing works anywhere, so the session ends in `failed`. */
export const HOPELESS: Proposal[] = [UNUSABLE];
export const HOPELESS_LAYOUTS: LayoutProposal[] = [LAYOUT_DISAGREES];
