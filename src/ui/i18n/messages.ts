/* The shape both dictionaries must satisfy. ADR-16: this interface is the
   whole i18n mechanism. A missing key or a wrongly-typed parameter is a
   compile error, which is the check a runtime framework cannot give.

   Parametrized messages are functions rather than template strings with
   placeholders, so word order is free to differ between languages and the
   compiler checks the arguments. Persian composes numbers into sentences
   differently than English does; a `{n} squares` template would have baked the
   English order in. */

import type { Cell, TraceStep } from "../../types";

export interface Messages {
  common: {
    back: string;
    home: string;
    backToStart: string;
    close: string;
    navLabel: string;
    untitled: string;
  };
  notFound: {
    title: string;
    lede: string;
  };
  landing: {
    title: string;
    lede: string;
    photoCardTitle: string;
    photoCardBody: string;
    lookingForDemo: string;
    playDemo: string;
    makingCopy: string;
    demoTitle: string;
    makeFromPhoto: string;
    demoCopyNote: string;
    noDemoNote: string;
    demoOpenFailed: string;
    aiCardTitle: string;
    aiCardBody: string;
    writeFromTheme: string;
    emptyListNote: string;
    openedTitle: string;
    openedNote: string;
    didNotBuild: string;
    aiWrittenTag: string;
    removeButton: string;
    removeLabel: (title: string) => string;
    failedListNote: string;
  };
  generate: {
    title: string;
    lede: string;
    themeLabel: string;
    themePlaceholder: string;
    limitNote: string;
    turnstileSlow: string;
    turnstileLoading: string;
    checkNotFinished: string;
    checkFailed: string;
    dailyLimit: string;
    poolSpent: string;
    couldNotStart: string;
    offline: string;
    starting: string;
    makeIt: string;
    waitingForCheck: string;
  };
  wizard: {
    title: string;
    photoLede: string;
    photoLabel: string;
    shrinkNote: (px: number) => string;
    busyShrinking: string;
    busyCreating: string;
    busyUploading: string;
    busySaving: string;
    photoPrepFailed: string;
    gridLede: string;
    rows: string;
    cols: string;
    dragHint: string;
    shrunk: (from: string, to: string) => string;
    cornersRight: string;
    saveForLater: string;
    tagLede: string;
    titleLabel: string;
    saveNotice: string;
    alreadySaved: string;
    couldNotSave: string;
    saveButton: string;
    backToCorners: string;
    savedLede: string;
  };
  tagger: {
    legend: string;
    /* Labels and hints keyed by the cell type they paint, so adding a cell
       type breaks the build here rather than silently missing a button. */
    types: Record<Cell["type"], { label: string; hint: string }>;
    prefilledExtra: string;
    letterPrompt: string;
    photoAlt: string;
    cellLabel: (row: number, col: number, typeLabel: string) => string;
  };
  aligner: {
    photoAlt: string;
    corners: {
      topLeft: string;
      topRight: string;
      bottomRight: string;
      bottomLeft: string;
    };
    moveCorner: (corner: string) => string;
  };
  play: {
    goneTitle: string;
    goneLede: string;
    fullTitle: string;
    fullLede: string;
    openingTitle: string;
    openingLede: string;
    writingTitle: (title: string) => string;
    writingLede: string;
    steps: {
      words: { label: string; note: string };
      validating: { label: string; note: string };
      clues: { label: string; note: string };
      packing: { label: string; note: string };
    };
    attempt: (attempt: number, of: number) => string;
    unreachableTitle: string;
    unreachableLede: string;
    themeFailedTitle: string;
    themeFailedLede: string;
    tryAgain: string;
    tryAnotherTheme: string;
    notFinishedTitle: string;
    notFinishedLede: string;
    finishSetup: string;
    templateLede: string;
    getMyCopy: string;
    aiWrittenNote: (theme: string) => string;
    nicknameLabel: string;
    nicknamePlaceholder: string;
    nicknameNote: string;
    startSolving: string;
    justYou: string;
    reconnecting: string;
    waitingToSend: (n: number) => string;
    checkAnswers: string;
    hideMarks: string;
    allRight: string;
    nothingWrongYet: (blank: number) => string;
    someWrong: (wrong: number, blank: number) => string;
    crosswordHint: string;
    photoHint: string;
    invite: string;
  };
  board: {
    photoAlt: string;
    loadingPhoto: string;
    gridLabel: string;
    cellLabel: (
      row: number,
      col: number,
      ch: string | null,
      wrong: boolean,
    ) => string;
    clueCellLabel: (row: number, col: number) => string;
    deadCellLabel: (row: number, col: number) => string;
    givenCellLabel: (row: number, col: number, letter: string) => string;
    answerCellLabel: (row: number, col: number, ch: string | null) => string;
  };
  clueZoom: {
    dialogLabel: (row: number, col: number) => string;
    photoAlt: (row: number, col: number) => string;
  };
  clues: {
    across: string;
    down: string;
    clueLabel: (
      number: number,
      dir: "across" | "down",
      clue: string,
      len: number,
    ) => string;
  };
  share: {
    label: string;
    copy: string;
    copied: string;
    openPuzzle: string;
    copyBlocked: string;
    keyNote: string;
  };
  voice: {
    unsupported: string;
    join: string;
    asking: string;
    joinNote: string;
    denied: string;
    micFailed: string;
    tryAgain: string;
    justYou: string;
    someone: string;
    speaking: string;
    holdToTalk: string;
    holdLabel: string;
    releaseToSend: (secondsLeft: number) => string;
    releaseLabel: string;
    leave: string;
    recordingNote: string;
    capNote: (seconds: number) => string;
  };
  trace: {
    toggle: (open: boolean, steps: number) => string;
    wholeRecord: string;
    steps: Record<TraceStep["step"], string>;
    notRead: string;
    emptyReply: string;
    whatWasWrong: string;
    sent: string;
    replied: string;
    seconds: (s: string) => string;
  };
  api: {
    rateLimited: string;
    tooLarge: string;
    notFound: string;
    conflictFallback: string;
    badRequestFallback: string;
    unknown: (status: number) => string;
    offline: string;
  };
  photo: {
    notAnImage: string;
    prepFailed: string;
    encodeFailed: string;
    kb: (bytes: number) => string;
  };
}
