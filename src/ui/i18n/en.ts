/* English, word for word the copy the app shipped with. The B3 failure and
   progress strings were tuned against real failures (spec section 12); change
   them only with the same care. */

import type { Messages } from "./messages.ts";

export const en: Messages = {
  common: {
    back: "← Back",
    home: "Home",
    backToStart: "Back to start",
    close: "Close",
    navLabel: "Navigation",
    untitled: "Untitled",
  },
  notFound: {
    title: "Nothing here",
    lede: "That address does not match a puzzle.",
  },
  landing: {
    title: "Arrowword Co-op",
    lede: "Solve a puzzle together, on separate devices. Letters sync as you type.",
    photoCardTitle: "A photographed arrowword",
    photoCardBody:
      "The Persian puzzle this app is named after: a photo of a printed grid, with the clues in the picture. Play the ready-made one, or photograph your own.",
    lookingForDemo: "Looking for the demo…",
    playDemo: "Play the demo",
    makingCopy: "Making your copy…",
    demoTitle: "Demo puzzle",
    makeFromPhoto: "Make one from a photo",
    demoCopyNote:
      "Playing the demo makes your own copy, so you cannot spoil anyone else's.",
    noDemoNote:
      "No demo is set up yet. Make one from a photo, then name it in the worker's configuration to publish it here.",
    demoOpenFailed: "Could not open the demo just now.",
    aiCardTitle: "A crossword written by AI",
    aiCardBody:
      "Give a theme and a language model writes an English crossword for it: the grid, the words and the clues. Under a minute, no photo.",
    writeFromTheme: "Write one from a theme",
    emptyListNote:
      "Puzzles you open will be listed here, in this browser only, because there are no accounts.",
    openedTitle: "Puzzles you have opened",
    openedNote:
      "Kept in this browser only, because there are no accounts. Clearing site data loses the list, and puzzles expire after 30 days without activity.",
    didNotBuild: "did not build",
    aiWrittenTag: "AI written",
    removeButton: "Remove",
    removeLabel: (title) => `Remove ${title} from this list`,
    failedListNote:
      "A puzzle that did not build still gets a link, because the session is created before anyone knows whether the model can write it. Nothing was saved into it and it deletes itself. Removing it here just tidies this list.",
  },
  generate: {
    title: "Make a puzzle",
    lede: "Give a theme and a language model writes a small English crossword for it: the grid, the words and the clues. It takes under a minute, and you can share the link with anyone.",
    themeLabel: "Theme",
    themePlaceholder: "rivers, the kitchen, birds…",
    limitNote:
      'Ten puzzles a day each, because the model runs on a shared free allowance. A theme is a subject, not a list: "movies" gives a puzzle about film, not a puzzle of film titles.',
    turnstileSlow:
      "Checking that you are a person. This is Cloudflare Turnstile and it occasionally takes several seconds; the button will enable itself.",
    turnstileLoading: "Loading the check that you are a person…",
    checkNotFinished: "The check has not finished yet. Give it a moment.",
    checkFailed: "The check did not pass. Reload the page and try again.",
    dailyLimit: "You have used today's puzzles. They come back tomorrow.",
    poolSpent:
      "Everyone's shared daily budget for new puzzles is spent. It resets tomorrow, and the demo puzzle is still there.",
    couldNotStart: "Could not start. Try again in a moment.",
    offline: "Could not reach the server. Check your connection.",
    starting: "Starting…",
    makeIt: "Make it",
    waitingForCheck: "Waiting for the check…",
  },
  wizard: {
    title: "New puzzle",
    photoLede:
      "Photograph the whole printed grid, straight on and in good light. The clues have to stay readable, since you will be reading them from this photo.",
    photoLabel: "Photo",
    shrinkNote: (px) =>
      `Shrunk to ${px}px on the longest edge before it leaves your device, so the upload is small and the clues stay legible.`,
    busyShrinking: "Shrinking the photo",
    busyCreating: "Creating the puzzle",
    busyUploading: "Uploading",
    busySaving: "Saving",
    photoPrepFailed: "Something went wrong preparing that photo.",
    gridLede:
      "Say how many rows and columns the printed grid has, then drag the four corners onto its outer edges.",
    rows: "Rows",
    cols: "Columns",
    dragHint:
      "Drag a corner, or focus one and use the arrow keys for small adjustments. Line up the outer border of the printed grid, not the first row of cells.",
    shrunk: (from, to) => `Photo went from ${from} to ${to}.`,
    cornersRight: "Corners look right, tag the cells",
    saveForLater: "Save for later",
    tagLede:
      "Mark what each cell is. Everything starts as an answer cell, so you only have to mark the clues, the dead cells, and any letters already printed.",
    titleLabel: "Name this puzzle",
    saveNotice:
      "Saving fixes the grid permanently. Letters people type are stored separately, so the puzzle itself cannot be edited afterwards.",
    alreadySaved:
      "This puzzle was already saved once, and a saved puzzle cannot be changed. Start a new one to make a different grid.",
    couldNotSave: "Could not save the puzzle.",
    saveButton: "Save and get the share link",
    backToCorners: "Back to corners",
    savedLede: "Saved. Send this link to whoever is solving with you.",
  },
  tagger: {
    legend: "Tap a type, then tap or drag over the grid",
    types: {
      answer: { label: "Answer", hint: "A letter goes here" },
      clue: { label: "Clue", hint: "Printed clue text" },
      dead: { label: "Dead", hint: "Not part of the puzzle" },
      prefilled: { label: "Given", hint: "A letter already printed" },
    },
    prefilledExtra: ". Tap one cell at a time; it will ask for the letter.",
    letterPrompt: "Which letter is printed in this cell?",
    photoAlt:
      "Your photographed puzzle, with the grid you aligned drawn over it.",
    cellLabel: (row, col, typeLabel) =>
      `Row ${row + 1}, column ${col + 1}, currently ${typeLabel}`,
  },
  aligner: {
    photoAlt:
      "The puzzle you photographed. Drag the four corners onto the printed grid.",
    corners: {
      topLeft: "top left",
      topRight: "top right",
      bottomRight: "bottom right",
      bottomLeft: "bottom left",
    },
    moveCorner: (corner) => `Move the ${corner} corner`,
  },
  play: {
    goneTitle: "This puzzle is gone",
    goneLede:
      "Puzzles disappear after 30 days without anyone touching them, and anyone holding the link can delete one. Either could have happened here, and the app deliberately cannot tell which.",
    fullTitle: "This puzzle is full",
    fullLede:
      "Ten people can solve together at once, and there are ten already. Try again when someone closes their tab.",
    openingTitle: "Opening the puzzle…",
    openingLede: "Fetching the photo and the letters people have typed.",
    writingTitle: (title) => `Writing “${title}”`,
    writingLede:
      "A language model is writing this puzzle now. It usually takes under half a minute, and you can leave this page open.",
    steps: {
      words: {
        label: "Asking the model for a puzzle",
        note: "words, positions and clues, all at once",
      },
      validating: {
        label: "Checking every crossing agrees",
        note: "nothing invalid is ever saved",
      },
      clues: {
        label: "Sending back what was wrong",
        note: "only if the first attempt did not fit together",
      },
      packing: {
        label: "Laying it out on this device",
        note: "only if the model could not place the words itself",
      },
    },
    attempt: (attempt, of) =>
      `Attempt ${attempt} of ${of}. The first layout did not fit together, so it has been sent back with the exact squares that disagreed.`,
    unreachableTitle: "Could not reach the puzzle writer",
    unreachableLede:
      "The model could not be reached just now, so nothing was built. This is not your theme, and the attempt has been given back to you.",
    themeFailedTitle: "That theme did not work out",
    themeFailedLede:
      "The model answered but could not make a puzzle from it. Short, common, everyday words work best: a subject like “the kitchen” gives it more to work with than a list of names.",
    tryAgain: "Try again",
    tryAnotherTheme: "Try another theme",
    notFinishedTitle: "This puzzle is not finished",
    notFinishedLede:
      "Somebody started it and has not tagged the cells yet, so there is nothing to solve.",
    finishSetup: "Finish setting it up",
    templateLede:
      "This is the shared demo, so it cannot be written in. Open your own copy and type all you like.",
    getMyCopy: "Get my own copy",
    aiWrittenNote: (theme) =>
      `A language model wrote this grid and its clues from the theme “${theme}”. Clues can be loose or occasionally wrong.`,
    nicknameLabel: "Pick a name",
    nicknamePlaceholder: "Whatever you like",
    nicknameNote:
      "So the others can see who filled what. It is not an account and nobody checks it.",
    startSolving: "Start solving",
    justYou: "Just you so far.",
    reconnecting:
      "Reconnecting. Keep typing: letters are kept and sent when the connection comes back.",
    waitingToSend: (n) => ` ${n} waiting to send.`,
    checkAnswers: "Check my answers",
    hideMarks: "Hide marks",
    allRight: "All done, and every letter is right.",
    nothingWrongYet: (blank) =>
      `Nothing wrong so far. ${blank} square${blank === 1 ? "" : "s"} still empty.`,
    someWrong: (wrong, blank) =>
      `${wrong} square${wrong === 1 ? "" : "s"} ${wrong === 1 ? "is" : "are"} wrong, marked on the grid.${blank ? ` ${blank} still empty.` : ""}`,
    crosswordHint:
      "Tap a clue to jump to its first square. Tap a square and type one letter. Backspace clears it. Nothing is checked unless you ask.",
    photoHint:
      "Tap an outlined cell to read its clue. Tap an empty cell and type one letter. Backspace clears it.",
    invite: "Invite someone",
  },
  board: {
    photoAlt: "The photographed puzzle you are solving.",
    loadingPhoto: "Loading the photo…",
    gridLabel: "Puzzle grid",
    cellLabel: (row, col, ch, wrong) =>
      `Row ${row + 1}, column ${col + 1}${ch ? `, ${ch}` : ", empty"}${wrong ? ", marked wrong" : ""}`,
    clueCellLabel: (row, col) =>
      `Clue at row ${row + 1}, column ${col + 1}. Tap to read it.`,
    deadCellLabel: (row, col) =>
      `Row ${row + 1}, column ${col + 1}, not part of the puzzle`,
    givenCellLabel: (row, col, letter) =>
      `Row ${row + 1}, column ${col + 1}, given letter ${letter}`,
    answerCellLabel: (row, col, ch) =>
      `Row ${row + 1}, column ${col + 1}${ch ? `, contains ${ch}` : ", empty"}`,
  },
  clueZoom: {
    dialogLabel: (row, col) => `Clue at row ${row + 1}, column ${col + 1}`,
    photoAlt: (row, col) =>
      `The clue printed at row ${row + 1}, column ${col + 1}`,
  },
  clues: {
    across: "Across",
    down: "Down",
    clueLabel: (number, dir, clue, len) =>
      `${number} ${dir}, ${clue}, ${len} letters`,
  },
  share: {
    label: "Share this link",
    copy: "Copy link",
    copied: "Copied",
    openPuzzle: "Open the puzzle",
    copyBlocked:
      "Copying was blocked. Tap the box above to select the link, then copy it.",
    keyNote:
      "Anyone with this link can play and can edit letters. There are no accounts, so treat it like a key. The puzzle disappears after 30 days without activity.",
  },
  voice: {
    unsupported:
      "Talking needs a browser with microphone access over a secure connection. This one cannot, so the puzzle is text only here.",
    join: "Talk to the others",
    asking: "Asking…",
    joinNote:
      "Hold a button, say something, let go. Up to four people. Nothing is recorded or kept.",
    denied:
      "The microphone is blocked for this site. Allow it in your browser's address bar, then tap “Talk to the others” again.",
    micFailed: "The microphone would not start.",
    tryAgain: "Try again",
    justYou: "In voice: just you. Nobody can hear you yet.",
    someone: "Someone",
    speaking: " speaking",
    holdToTalk: "Hold to talk",
    holdLabel: "Hold to talk",
    releaseToSend: (secondsLeft) => `Release to send · ${secondsLeft}s`,
    releaseLabel: "Release to send",
    leave: "Leave voice",
    recordingNote: "Recording. Let go to send.",
    capNote: (seconds) => `Up to ${seconds} seconds at a time.`,
  },
  trace: {
    toggle: (open, steps) =>
      `${open ? "Hide" : "Show"} what the model was asked and said (${steps} step${steps === 1 ? "" : "s"})`,
    wholeRecord:
      "Every exchange with the language model, in order. This is the whole record; nothing is summarized.",
    steps: {
      layout: "Asked for a whole puzzle",
      repair: "Sent the problems back to be fixed",
      words: "Asked for a word list to pack",
      validate: "Checked the grid",
      pack: "Laid it out on this device",
      done: "Finished",
    },
    notRead: " · reply could not be read",
    emptyReply: "It replied with nothing at all.",
    whatWasWrong: "What was wrong",
    sent: "Sent to the model",
    replied: "What it replied",
    seconds: (s) => ` (${s}s)`,
  },
  api: {
    rateLimited:
      "You have made a lot of puzzles in the last hour. Try again a bit later.",
    tooLarge:
      "That photo is too large even after shrinking. Try a photo taken at a lower resolution.",
    notFound: "That puzzle does not exist, or it has expired.",
    conflictFallback: "That is already saved.",
    badRequestFallback: "That request was not valid.",
    unknown: (status) => `Something went wrong (${status}).`,
    offline: "Could not reach the server. Check your connection.",
  },
  photo: {
    notAnImage: "That file does not look like an image.",
    prepFailed: "This browser could not prepare the photo.",
    encodeFailed: "This browser could not encode the photo.",
    kb: (bytes) => `${Math.round(bytes / 1024)} KB`,
  },
};
