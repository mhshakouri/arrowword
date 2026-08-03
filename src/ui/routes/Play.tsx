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

const MAX_NICKNAME = 24;

export function Play({ id }: { id: string }) {
  const session = useSession(id);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(
    null,
  );
  const [clue, setClue] = useState<{ row: number; col: number } | null>(null);
  const [draftName, setDraftName] = useState("");

  const doc = session.doc;

  /* Once the title is known, correct what the landing page remembered. It saves
     the session before the document arrives, so "Demo puzzle" is a placeholder
     until now. */
  useEffect(() => {
    if (doc?.title) remember(id, doc.title);
  }, [id, doc?.title]);

  if (session.status === "missing") {
    return (
      <main>
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
        <h1>Opening the puzzle…</h1>
        <p class="lede">
          Fetching the photo and the letters people have typed.
        </p>
      </main>
    );
  }

  if (!doc.puzzleSaved) {
    return (
      <main>
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
      <h1 style="font-size:1.25rem">{doc.title}</h1>

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

          {session.status === "closed" && (
            <p class="notice error" role="alert">
              The connection dropped. Reload to carry on. Reconnecting by itself
              arrives with the next milestone.
            </p>
          )}

          {session.refusal && (
            <p class="notice error" role="alert">
              {session.refusal}
            </p>
          )}

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
            Tap an outlined cell to read its clue. Tap an empty cell and type
            one letter. Backspace clears it.
          </p>
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
