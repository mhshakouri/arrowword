/* Optimistic writes, and what to do when the server disagrees.

   Pure on purpose. This is the part of A4 where a mistake is quiet: a letter
   that reverts when it should not, or a stale write that lands on top of
   somebody else's newer one, both look like the app being flaky rather than like
   a bug with a location. Keeping it out of the socket and out of the DOM means it
   can be tested exhaustively without either. */

import type { LetterValue } from "../../types";

export type Letters = Record<string, LetterValue>;

export interface Pending {
  /* What we asked for. `null` means a clear. */
  ch: string | null;
  /* What the cell held before we touched it, so a refusal can put it back. */
  previous: LetterValue | undefined;
  /* When we asked, used to decide whether a retry is still safe. */
  at: number;
}

export type PendingMap = Record<string, Pending>;

export const key = (row: number, col: number) => `${row},${col}`;

/* One entry per cell rather than a queue. Typing three letters into one cell
   before the network recovers should send the third, not all three: section 7
   asks for the last unacknowledged write, and per cell is the useful reading of
   "last" when several cells are waiting. */
export function remember(
  pendingMap: PendingMap,
  letters: Letters,
  row: number,
  col: number,
  ch: string | null,
  now: number,
): PendingMap {
  const k = key(row, col);
  const existing = pendingMap[k];
  return {
    ...pendingMap,
    [k]: {
      ch,
      /* Keep the value from before the *first* unacknowledged write, so a
         revert undoes everything we did rather than stepping back one edit into
         another optimistic state. */
      previous: existing ? existing.previous : letters[k],
      at: now,
    },
  };
}

/* The optimistic view: what the grid should show while the server has not
   answered yet. Applied to the confirmed letters rather than replacing them, so
   an incoming broadcast for another cell is never lost. */
export function echo(
  letters: Letters,
  pendingMap: PendingMap,
  by: string,
): Letters {
  const out = { ...letters };
  for (const [k, p] of Object.entries(pendingMap)) {
    if (p.ch === null) delete out[k];
    else out[k] = { ch: p.ch, at: p.at, by };
  }
  return out;
}

/* A broadcast arrived for a cell. If it matches what we asked for, the write
   landed and stops being pending. If it does not, somebody else wrote after us
   and their value stands: also stop waiting, because a retry would be a fight
   rather than a repair. */
export function confirm(
  pendingMap: PendingMap,
  row: number,
  col: number,
): PendingMap {
  const k = key(row, col);
  if (!(k in pendingMap)) return pendingMap;
  const next = { ...pendingMap };
  delete next[k];
  return next;
}

/* The server refused this cell. Put back what was there and stop waiting. */
export function revert(
  letters: Letters,
  pendingMap: PendingMap,
  row: number,
  col: number,
): { letters: Letters; pending: PendingMap } {
  const k = key(row, col);
  const p = pendingMap[k];
  if (!p) return { letters, pending: pendingMap };

  const nextLetters = { ...letters };
  if (p.previous) nextLetters[k] = p.previous;
  else delete nextLetters[k];

  const nextPending = { ...pendingMap };
  delete nextPending[k];
  return { letters: nextLetters, pending: nextPending };
}

export interface Retry {
  row: number;
  col: number;
  ch: string | null;
}

/* What to re-send after a reconnect, given the state the server just sent.

   Conditional rather than unconditional, which is a deliberate refinement of
   "retry the last unacknowledged write" in section 7. A write that was never
   acknowledged is usually a write that never arrived, and re-sending it is a
   repair. But if the cell now holds something newer than our attempt, somebody
   else wrote it while we were away, and re-sending would silently undo their
   work. Last write wins is fine for two people typing at once; it is not fine as
   a way to resolve a reconnect, because the stale side would always win by
   arriving later. */
export function retriable(
  pendingMap: PendingMap,
  fresh: Letters,
  myPlayerId: string,
): Retry[] {
  const out: Retry[] = [];
  for (const [k, p] of Object.entries(pendingMap)) {
    const [rowText, colText] = k.split(",");
    const row = Number(rowText);
    const col = Number(colText);
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue;

    const current = fresh[k];
    /* Already what we wanted: the write did land, we just never heard.

       Compared as "the cell's letter, or null when empty" rather than against
       the entry itself, because a pending clear wants `null` and an empty cell
       is `undefined`. Testing those directly made a clear that had already
       landed look outstanding, so it was re-sent every reconnect. */
    const currentCh = current ? current.ch : null;
    if (currentCh === p.ch) continue;
    /* Somebody else has been here since we tried. Their value stands. */
    if (current && current.by !== myPlayerId && current.at > p.at) continue;
    out.push({ row, col, ch: p.ch });
  }
  return out;
}
