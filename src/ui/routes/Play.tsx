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
import { Trace } from "../components/Trace.tsx";
import { useT } from "../i18n/index.ts";
import type { Entry } from "../../types";

const MAX_NICKNAME = 24;

export function Play({ id }: { id: string }) {
  const t = useT();
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
        <h1>{t.play.goneTitle}</h1>
        <p class="lede">{t.play.goneLede}</p>
        <a class="button primary" href="/">
          {t.common.backToStart}
        </a>
      </main>
    );
  }

  if (session.status === "full") {
    return (
      <main>
        <Crumbs />
        <h1>{t.play.fullTitle}</h1>
        <p class="lede">{t.play.fullLede}</p>
        <a class="button" href="/">
          {t.common.backToStart}
        </a>
      </main>
    );
  }

  if (!doc) {
    return (
      <main>
        <Crumbs />
        <h1>{t.play.openingTitle}</h1>
        <p class="lede">{t.play.openingLede}</p>
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
      { key: "words", ...t.play.steps.words },
      { key: "validating", ...t.play.steps.validating },
      { key: "clues", ...t.play.steps.clues },
      { key: "packing", ...t.play.steps.packing },
    ];
    const current = session.progress?.step ?? "words";
    const currentIndex = steps.findIndex((s) => s.key === current);
    return (
      <main>
        <Crumbs />
        <h1>{t.play.writingTitle(doc.title)}</h1>
        <p class="lede">{t.play.writingLede}</p>
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
            {t.play.attempt((session.progress?.attempt ?? 0) + 1, 3)}
          </p>
        )}
        <Trace steps={session.trace} />
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
          {unreachable ? t.play.unreachableTitle : t.play.themeFailedTitle}
        </h1>
        <p class="lede">
          {unreachable
            ? t.play.unreachableLede
            : known
              ? session.failure
              : t.play.themeFailedLede}
        </p>
        <a class="button primary" href="/generate">
          {unreachable ? t.play.tryAgain : t.play.tryAnotherTheme}
        </a>
        {/* The most useful thing on this screen. Somebody whose puzzle failed
            wants to know why, and the app knows. */}
        <Trace steps={session.trace} />
      </main>
    );
  }

  if (!doc.puzzleSaved) {
    return (
      <main>
        <Crumbs />
        <h1>{t.play.notFinishedTitle}</h1>
        <p class="lede">{t.play.notFinishedLede}</p>
        <a class="button" href={`/new?session=${id}`}>
          {t.play.finishSetup}
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
        <p class="lede">{t.play.templateLede}</p>
        <button class="primary" onClick={() => navigate("/")}>
          {t.play.getMyCopy}
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
          <span class="tag">{t.landing.aiWrittenTag}</span>{" "}
          {t.play.aiWrittenNote(doc.theme ?? doc.title)}
        </p>
      )}

      {needsName ? (
        <div class="card stack">
          <div>
            <label for="nickname">{t.play.nicknameLabel}</label>
            <input
              id="nickname"
              type="text"
              maxLength={MAX_NICKNAME * 2}
              placeholder={t.play.nicknamePlaceholder}
              value={draftName}
              onInput={(e) =>
                setDraftName((e.currentTarget as HTMLInputElement).value)
              }
            />
            <p class="muted" style="margin-bottom:0">
              {t.play.nicknameNote}
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
              {t.play.startSolving}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div class="row" style="margin-bottom:0.75rem">
            {session.peers.length === 0 ? (
              <span class="muted">{t.play.justYou}</span>
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
              {t.play.reconnecting}
              {session.waiting > 0 && t.play.waitingToSend(session.waiting)}
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
                lang={doc.lang}
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
                lang={doc.lang}
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
                  {t.play.checkAnswers}
                </button>
                {marked && (
                  <button onClick={() => setMarked(null)}>
                    {t.play.hideMarks}
                  </button>
                )}
              </div>

              {marked && (
                <p
                  class={`notice${marked.wrong.length ? " error" : ""}`}
                  role="status"
                >
                  {marked.complete
                    ? t.play.allRight
                    : marked.wrong.length === 0
                      ? t.play.nothingWrongYet(marked.blank)
                      : t.play.someWrong(marked.wrong.length, marked.blank)}
                </p>
              )}

              <p class="muted" style="margin-top:0.75rem">
                {t.play.crosswordHint}
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
                {t.play.photoHint}
              </p>
            </>
          )}

          {/* The link was only offered at save time, so a solver wanting to
              bring somebody in mid-puzzle had to go and find the URL. */}
          {sharing ? (
            <ShareLink id={id} showOpen={false} />
          ) : (
            <button onClick={() => setSharing(true)}>{t.play.invite}</button>
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
