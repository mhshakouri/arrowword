/* Route `/s/:id`. Spec section 11.

   This screen owes four user-facing states from the amended rule 4 in section
   13, all of which A0.5 shipped as status codes with nowhere to show them:
   session expired or deleted, session full, a write before choosing a name, and
   a template being read only. */

import { useEffect, useState } from "preact/hooks";
import { photoUrl } from "../lib/api.ts";
import {
  nickname as storedNickname,
  remember,
  setNickname,
} from "../lib/local.ts";
import { navigate } from "../lib/router.ts";
import { useSession } from "../lib/session.ts";
import { firstGrapheme, graphemes } from "../lib/grapheme.ts";
import { Board } from "../components/Board.tsx";
import { ClueZoom } from "../components/ClueZoom.tsx";
import { ShareLink } from "../components/ShareLink.tsx";
import { PushToTalk } from "../components/PushToTalk.tsx";
import { CrosswordBoard } from "../components/CrosswordBoard.tsx";
import { ClueList } from "../components/ClueList.tsx";
import { Crumbs } from "../components/Crumbs.tsx";
import { mark, type Marked } from "../lib/check.ts";
import type { Entry } from "../../types";

const MAX_NICKNAME = 24;

export function Play({ id }: { id: string }) {
  const session = useSession(id);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(
    null,
  );
  const [clue, setClue] = useState<{ row: number; col: number } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [sharing, setSharing] = useState(false);
  /* Which clue is lit. Generated puzzles only; a photo puzzle has no entries. */
  const [activeEntry, setActiveEntry] = useState<Entry | null>(null);
  /* Null until somebody asks. Nothing here runs while a person types: ADR-1's
     objection is to being told you are right without asking, and a button
     somebody pressed is a different thing from a grid that colours itself. */
  const [marked, setMarked] = useState<Marked | null>(null);

  const doc = session.doc;

  /* Once the title is known, correct what the landing page remembered. It saves
     the session before the document arrives, so "Demo puzzle" is a placeholder
     until now.

     "Untitled" is skipped rather than written. A generated session carries its
     theme from the moment it is created, and a photo session is genuinely
     untitled until somebody names it, so writing the placeholder back only ever
     replaced a real name with a worse one: the home list filled up with
     Untitled entries whose themes were known all along. */
  useEffect(() => {
    if (doc?.title && doc.title !== "Untitled") {
      remember(id, doc.title, {
        kind: doc.source === "generated" ? "generated" : "photo",
        /* Recorded so the home list can say what happened rather than showing a
           puzzle that cannot be opened. */
        failed: doc.status === "failed",
      });
    }
  }, [id, doc?.title, doc?.source, doc?.status]);

  if (session.status === "missing") {
    return (
      <main>
        <Crumbs />
        <h1>This puzzle is gone</h1>
        <p class="lede">
          Puzzles disappear after 30 days without anyone touching them, and
          anyone holding the link can delete one. Either could have happened
          here, and the app deliberately cannot tell which.
        </p>
        <a class="button primary" href="/">
          Back to start
        </a>
      </main>
    );
  }

  if (session.status === "full") {
    return (
      <main>
        <Crumbs />
        <h1>This puzzle is full</h1>
        <p class="lede">
          Ten people can solve together at once, and there are ten already. Try
          again when someone closes their tab.
        </p>
        <a class="button" href="/">
          Back to start
        </a>
      </main>
    );
  }

  if (!doc) {
    return (
      <main>
        <Crumbs />
        <h1>Opening the puzzle…</h1>
        <p class="lede">
          Fetching the photo and the letters people have typed.
        </p>
      </main>
    );
  }

  /* Generation is asynchronous, so a session is addressable before it has a
     grid. Section 11 wants labeled steps rather than a spinner, because two or
     three model calls take 10 to 30 seconds and a spinner for that long reads
     as broken. */
  if (doc.status === "generating") {
    /* Named steps rather than a spinner, and shown as a list rather than one
       line, because a person watching a blank screen for thirty seconds cannot
       tell "working" from "stuck". Seeing which step is running, and that the
       earlier ones finished, is the difference. */
    const steps: Array<{ key: string; label: string; note: string }> = [
      {
        key: "words",
        label: "Asking the model for a puzzle",
        note: "words, positions and clues, all at once",
      },
      {
        key: "validating",
        label: "Checking every crossing agrees",
        note: "nothing invalid is ever saved",
      },
      {
        key: "clues",
        label: "Sending back what was wrong",
        note: "only if the first attempt did not fit together",
      },
      {
        key: "packing",
        label: "Laying it out on this device",
        note: "only if the model could not place the words itself",
      },
    ];
    const current = session.progress?.step ?? "words";
    const currentIndex = steps.findIndex((s) => s.key === current);
    return (
      <main>
        <Crumbs />
        <h1>Writing “{doc.title}”</h1>
        <p class="lede">
          A language model is writing this puzzle now. It usually takes under
          half a minute, and you can leave this page open.
        </p>
        <ol class="steps">
          {steps.map((step, i) => {
            const state =
              i < currentIndex ? "done" : i === currentIndex ? "now" : "todo";
            return (
              <li key={step.key} class={`step step-${state}`}>
                <span class="step-mark" aria-hidden="true">
                  {state === "done" ? "✓" : state === "now" ? "•" : ""}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  <br />
                  <span class="muted">{step.note}</span>
                </span>
              </li>
            );
          })}
        </ol>
        {(session.progress?.attempt ?? 0) > 0 && (
          <p class="muted" role="status">
            Attempt {(session.progress?.attempt ?? 0) + 1} of 3. The first
            layout did not fit together, so it has been sent back with the exact
            squares that disagreed.
          </p>
        )}
      </main>
    );
  }

  /* A terminal state offering a fresh attempt, never a raw error. A retry
     creates a new session rather than reusing this one, because `puzzleSaved`
     is write-once and this session may already be part way through. */
  if (doc.status === "failed" || session.failure) {
    /* The heading, the explanation and the button have to agree. A screen that
       says "this is not your theme" above a button saying "try another theme"
       tells somebody to do the one thing it just said would not help, and it
       shipped that way. */
    const unreachable = (session.failure ?? "").startsWith("unreachable");
    const known = session.failure && !unreachable;
    return (
      <main>
        <Crumbs />
        <h1>
          {unreachable
            ? "Could not reach the puzzle writer"
            : "That theme did not work out"}
        </h1>
        <p class="lede">
          {unreachable
            ? "The model could not be reached just now, so nothing was built. This is not your theme, and the attempt has been given back to you."
            : known
              ? session.failure
              : "The model answered but could not make a puzzle from it. Short, common, everyday words work best: a subject like “the kitchen” gives it more to work with than a list of names."}
        </p>
        <a class="button primary" href="/generate">
          {unreachable ? "Try again" : "Try another theme"}
        </a>
      </main>
    );
  }

  if (!doc.puzzleSaved) {
    return (
      <main>
        <Crumbs />
        <h1>This puzzle is not finished</h1>
        <p class="lede">
          Somebody started it and has not tagged the cells yet, so there is
          nothing to solve.
        </p>
        <a class="button" href={`/new?session=${id}`}>
          Finish setting it up
        </a>
      </main>
    );
  }

  /* A template is read only by design (ADR-12). Rather than let someone type
     into it and be refused per keystroke, say so and offer the copy that is
     actually playable. */
  if (doc.template) {
    return (
      <main>
        <Crumbs />
        <h1>{doc.title}</h1>
        <p class="lede">
          This is the shared demo, so it cannot be written in. Open your own
          copy and type all you like.
        </p>
        <button class="primary" onClick={() => navigate("/")}>
          Get my own copy
        </button>
      </main>
    );
  }

  const needsName = !session.named && !storedNickname(id);

  return (
    <main>
      <Crumbs />
      <h1 style="font-size:1.25rem">{doc.title}</h1>
      {/* Said plainly and on the puzzle itself, not only on the screen that
          made it. Somebody arriving from a shared link has no idea where this
          came from, and "a machine wrote this" changes how the clues read. */}
      {doc.source === "generated" && (
        <p class="muted" style="margin-top:-0.5rem">
          <span class="tag">AI written</span> A language model wrote this grid
          and its clues from the theme “{doc.theme ?? doc.title}”. Clues can be
          loose or occasionally wrong.
        </p>
      )}

      {needsName ? (
        <div class="card stack">
          <div>
            <label for="nickname">Pick a name</label>
            <input
              id="nickname"
              type="text"
              maxLength={MAX_NICKNAME * 2}
              placeholder="Whatever you like"
              value={draftName}
              onInput={(e) =>
                setDraftName((e.currentTarget as HTMLInputElement).value)
              }
            />
            <p class="muted" style="margin-bottom:0">
              So the others can see who filled what. It is not an account and
              nobody checks it.
            </p>
          </div>
          <div class="row">
            <button
              class="primary"
              disabled={graphemes(draftName.trim()).length === 0}
              onClick={() => {
                const name = graphemes(draftName.trim())
                  .slice(0, MAX_NICKNAME)
                  .join("");
                if (!name) return;
                setNickname(id, name);
                session.introduce(name);
              }}
            >
              Start solving
            </button>
          </div>
        </div>
      ) : (
        <>
          <div class="row" style="margin-bottom:0.75rem">
            {session.peers.length === 0 ? (
              <span class="muted">Just you so far.</span>
            ) : (
              session.peers.map((p) => (
                <span
                  key={p.id}
                  class="peer"
                  style={`--peer-color: var(--player-${p.color % 10})`}
                >
                  {p.nickname}
                </span>
              ))
            )}
          </div>

          {session.status === "reconnecting" && (
            <p class="notice" role="status">
              Reconnecting. Keep typing: letters are kept and sent when the
              connection comes back.
              {session.waiting > 0 && ` ${session.waiting} waiting to send.`}
            </p>
          )}

          {/* No per-keystroke indicator. When the connection is healthy a write
              is acknowledged in milliseconds, so this line mounted and unmounted
              on every letter, changing the page height each time. On a phone,
              where the grid is tall and the keyboard already covers half the
              viewport, a height change while scrolled near the limit makes the
              browser clamp the scroll position, which reads as the page jumping
              while you type. The count is worth showing when it means something,
              which is while reconnecting, and that notice is already there. */}

          {session.refusal && (
            <p class="notice error" role="alert">
              {session.refusal}
            </p>
          )}

          {/* Invariant 11 keeps the two puzzle kinds apart, so the renderer
              branches on `source` rather than sniffing for an alignment. */}
          {doc.source === "generated" ? (
            <>
              <CrosswordBoard
                rows={doc.rows}
                cols={doc.cols}
                cells={doc.cells}
                entries={doc.entries}
                letters={doc.letters}
                peers={session.peers}
                selected={selected}
                highlighted={activeEntry}
                onSelect={(row, col) => {
                  setSelected({ row, col });
                  /* Tapping a square lights whichever entry starts there, if
                     one does, so the clue list follows the grid as well as the
                     grid following the clue list. */
                  const starting = doc.entries.find(
                    (e) => e.row === row && e.col === col,
                  );
                  if (starting) setActiveEntry(starting);
                }}
                onType={(row, col, ch) => {
                  const letter = firstGrapheme(ch);
                  if (letter) session.setLetter(row, col, letter);
                  /* Marks go stale the moment anything changes, and a stale
                     mark is a lie about the square under it. */
                  setMarked(null);
                }}
                onClear={(row, col) => {
                  session.clearLetter(row, col);
                  setMarked(null);
                }}
                wrong={marked?.wrong ?? []}
              />
              <ClueList
                entries={doc.entries}
                selected={activeEntry}
                onPick={(entry) => {
                  setActiveEntry(entry);
                  setSelected({ row: entry.row, col: entry.col });
                }}
              />

              {/* Only generated puzzles can offer this: a photographed
                  arrowword has no entries and therefore no answers to compare
                  against. See the ADR-1 amendment. */}
              <div class="row" style="margin-top:0.75rem">
                <button
                  onClick={() => setMarked(mark(doc.entries, doc.letters))}
                >
                  Check my answers
                </button>
                {marked && (
                  <button onClick={() => setMarked(null)}>Hide marks</button>
                )}
              </div>

              {marked && (
                <p
                  class={`notice${marked.wrong.length ? " error" : ""}`}
                  role="status"
                >
                  {marked.complete
                    ? "All done, and every letter is right."
                    : marked.wrong.length === 0
                      ? `Nothing wrong so far. ${marked.blank} square${marked.blank === 1 ? "" : "s"} still empty.`
                      : `${marked.wrong.length} square${marked.wrong.length === 1 ? "" : "s"} ${marked.wrong.length === 1 ? "is" : "are"} wrong, marked on the grid.${marked.blank ? ` ${marked.blank} still empty.` : ""}`}
                </p>
              )}

              <p class="muted" style="margin-top:0.75rem">
                Tap a clue to jump to its first square. Tap a square and type
                one letter. Backspace clears it. Nothing is checked unless you
                ask.
              </p>
            </>
          ) : (
            <>
              <Board
                photoSrc={photoUrl(id)}
                alignment={doc.alignment!}
                rows={doc.rows}
                cols={doc.cols}
                cells={doc.cells}
                letters={doc.letters}
                peers={session.peers}
                selected={selected}
                readOnly={false}
                onSelect={(row, col) => setSelected({ row, col })}
                onClue={(row, col) => setClue({ row, col })}
                onType={(row, col, ch) => {
                  const letter = firstGrapheme(ch);
                  if (letter) session.setLetter(row, col, letter);
                }}
                onClear={(row, col) => session.clearLetter(row, col)}
              />

              <p class="muted" style="margin-top:0.75rem">
                Tap an outlined cell to read its clue. Tap an empty cell and
                type one letter. Backspace clears it.
              </p>
            </>
          )}

          {/* The link was only offered at save time, so a solver wanting to
              bring somebody in mid-puzzle had to go and find the URL. */}
          {sharing ? (
            <ShareLink id={id} showOpen={false} />
          ) : (
            <button onClick={() => setSharing(true)}>Invite someone</button>
          )}

          <PushToTalk
            peers={session.peers}
            voicePeers={session.voicePeers}
            lastClip={session.lastClip}
            onJoin={session.joinVoice}
            onLeave={session.leaveVoice}
            onClip={session.sendClip}
          />
        </>
      )}

      {clue && doc.alignment && (
        <ClueZoom
          photoSrc={photoUrl(id)}
          alignment={doc.alignment}
          rows={doc.rows}
          cols={doc.cols}
          row={clue.row}
          col={clue.col}
          onClose={() => setClue(null)}
        />
      )}
    </main>
  );
}
