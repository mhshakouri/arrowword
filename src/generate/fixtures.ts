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

import type { Proposal } from "./provider.ts";

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
