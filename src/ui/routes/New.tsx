/* Route `/new`, steps 1 to 3 of the wizard in spec section 10: photo, grid
   size, alignment. Tagging and save are A2, so this stops after alignment and
   says so rather than pretending to finish.

   This screen owes two user-facing states from the amended rule 4 in section
   13: rate limited, and photo too large. Both come from ApiError. */

import { useState } from "preact/hooks";
import type { GridAlignment } from "../../types";
import type { Cell } from "../../types";
import {
  ApiError,
  createSession,
  photoUrl,
  savePuzzle,
  uploadPhoto,
} from "../lib/api.ts";
import { defaultAlignment } from "../lib/alignment.ts";
import { downscale, kb, LONGEST_EDGE } from "../lib/photo.ts";
import { remember } from "../lib/local.ts";
import { navigate } from "../lib/router.ts";
import { AlignmentEditor } from "../components/AlignmentEditor.tsx";
import { CellTagger } from "../components/CellTagger.tsx";
import { ShareLink } from "../components/ShareLink.tsx";

const MAX_SIDE = 30; /* Spec section 7. */

type Step = "photo" | "grid" | "tag" | "saved";

/* Everything starts as an answer cell, because a Persian arrowword is mostly
   answer cells: defaulting the other way would mean tagging the whole grid. */
function blankCells(rows: number, cols: number): Cell[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, (): Cell => ({ type: "answer" })),
  );
}

/* `?session=<id>` resumes at the grid step. Without it, a reload after the
   upload would strand a session that already has a photo and make the user pay
   for a second upload against the rate limit. */
function resumable(): string | null {
  const id = new URLSearchParams(location.search).get("session");
  return id && /^[0-9a-f]{32}$/.test(id) ? id : null;
}

export function New() {
  const resumed = resumable();
  const [step, setStep] = useState<Step>(resumed ? "grid" : "photo");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(resumed);
  const [shrunk, setShrunk] = useState<{ from: number; to: number } | null>(
    null,
  );
  const [rows, setRows] = useState(11);
  const [cols, setCols] = useState(11);
  const [alignment, setAlignment] = useState<GridAlignment>(defaultAlignment);
  const [cells, setCells] = useState<Cell[][]>(() => blankCells(11, 11));
  const [title, setTitle] = useState("");

  async function onPick(file: File) {
    setError(null);
    try {
      setBusy("Shrinking the photo");
      const small = await downscale(file);

      setBusy("Creating the puzzle");
      const id = await createSession();

      setBusy("Uploading");
      await uploadPhoto(id, small.blob);

      remember(id, "Untitled");
      setSessionId(id);
      setShrunk({ from: small.originalBytes, to: small.blob.size });
      setStep("grid");
      /* Put the id in the URL so a reload resumes here instead of asking for
         the photo again. replaceState rather than push: going back should leave
         the wizard, not step through it. */
      history.replaceState(null, "", `/new?session=${id}`);
    } catch (err) {
      /* Every branch here is a sentence rather than a status code, which is the
         point of rule 4. `rate-limited` and `too-large` are the two this
         milestone owes. */
      setError(
        err instanceof ApiError
          ? err.failure.message
          : err instanceof Error
            ? err.message
            : "Something went wrong preparing that photo.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    if (!sessionId) return;
    setError(null);
    try {
      setBusy("Saving");
      await savePuzzle(sessionId, {
        title: title.trim() || "Untitled",
        rows,
        cols,
        alignment,
        cells,
      });
      remember(sessionId, title.trim() || "Untitled");
      setStep("saved");
    } catch (err) {
      /* A 409 means this session already has a puzzle, which invariant 4 makes
         permanent. Saying so beats a retry button that can never succeed. */
      setError(
        err instanceof ApiError
          ? err.failure.kind === "conflict"
            ? "This puzzle was already saved once, and a saved puzzle cannot be changed. Start a new one to make a different grid."
            : err.failure.message
          : "Could not save the puzzle.",
      );
    } finally {
      setBusy(null);
    }
  }

  const clampSide = (n: number) => Math.min(MAX_SIDE, Math.max(1, n || 1));

  return (
    <main>
      <h1>New puzzle</h1>

      {step === "photo" && (
        <>
          <p class="lede">
            Photograph the whole printed grid, straight on and in good light.
            The clues have to stay readable, since you will be reading them from
            this photo.
          </p>

          <div class="stack">
            <div class="card">
              <label for="photo">Photo</label>
              <input
                id="photo"
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busy !== null}
                onChange={(e) => {
                  const file = (e.currentTarget as HTMLInputElement).files?.[0];
                  if (file) void onPick(file);
                }}
              />
              <p class="muted" style="margin-bottom:0">
                Shrunk to {LONGEST_EDGE}px on the longest edge before it leaves
                your device, so the upload is small and the clues stay legible.
              </p>
            </div>

            {busy && <p class="notice">{busy}…</p>}
            {error && (
              <p class="notice error" role="alert">
                {error}
              </p>
            )}
          </div>
        </>
      )}

      {step === "grid" && sessionId && (
        <>
          <p class="lede">
            Say how many rows and columns the printed grid has, then drag the
            four corners onto its outer edges.
          </p>

          <div class="stack">
            <div class="card row" style="gap:1rem">
              <div style="flex:1;min-width:6rem">
                <label for="rows">Rows</label>
                <input
                  id="rows"
                  type="number"
                  min={1}
                  max={MAX_SIDE}
                  value={rows}
                  onInput={(e) =>
                    setRows(
                      clampSide(
                        Number((e.currentTarget as HTMLInputElement).value),
                      ),
                    )
                  }
                />
              </div>
              <div style="flex:1;min-width:6rem">
                <label for="cols">Columns</label>
                <input
                  id="cols"
                  type="number"
                  min={1}
                  max={MAX_SIDE}
                  value={cols}
                  onInput={(e) =>
                    setCols(
                      clampSide(
                        Number((e.currentTarget as HTMLInputElement).value),
                      ),
                    )
                  }
                />
              </div>
            </div>

            <AlignmentEditor
              photoSrc={photoUrl(sessionId)}
              rows={rows}
              cols={cols}
              alignment={alignment}
              onChange={setAlignment}
            />

            <p class="muted">
              Drag a corner, or focus one and use the arrow keys for small
              adjustments. Line up the outer border of the printed grid, not the
              first row of cells.
            </p>

            {shrunk && (
              <p class="muted">
                Photo went from {kb(shrunk.from)} to {kb(shrunk.to)}.
              </p>
            )}

            <div class="row">
              <button
                class="primary"
                onClick={() => {
                  /* Sized here rather than on every keystroke, so changing rows
                     mid-typing does not repeatedly discard tagging. */
                  setCells(blankCells(rows, cols));
                  setStep("tag");
                }}
              >
                Corners look right, tag the cells
              </button>
              <button onClick={() => navigate("/")}>Save for later</button>
            </div>
          </div>
        </>
      )}
      {step === "tag" && sessionId && (
        <>
          <p class="lede">
            Mark what each cell is. Everything starts as an answer cell, so you
            only have to mark the clues, the dead cells, and any letters already
            printed.
          </p>

          <div class="stack">
            <CellTagger
              photoSrc={photoUrl(sessionId)}
              rows={rows}
              cols={cols}
              alignment={alignment}
              cells={cells}
              onChange={setCells}
            />

            <div class="card">
              <label for="title">Name this puzzle</label>
              <input
                id="title"
                type="text"
                maxLength={200}
                placeholder="Untitled"
                value={title}
                onInput={(e) =>
                  setTitle((e.currentTarget as HTMLInputElement).value)
                }
              />
            </div>

            <div class="notice">
              Saving fixes the grid permanently. Letters people type are stored
              separately, so the puzzle itself cannot be edited afterwards.
            </div>

            {error && (
              <p class="notice error" role="alert">
                {error}
              </p>
            )}

            <div class="row">
              <button
                class="primary"
                disabled={busy !== null}
                onClick={() => void onSave()}
              >
                {busy ?? "Save and get the share link"}
              </button>
              <button disabled={busy !== null} onClick={() => setStep("grid")}>
                Back to corners
              </button>
            </div>
          </div>
        </>
      )}

      {step === "saved" && sessionId && (
        <>
          <p class="lede">
            Saved. Send this link to whoever is solving with you.
          </p>
          <div class="stack">
            <ShareLink id={sessionId} />
            <button onClick={() => navigate("/")}>Back to start</button>
          </div>
        </>
      )}
    </main>
  );
}
