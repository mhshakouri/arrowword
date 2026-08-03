/* Route `/new`, steps 1 to 3 of the wizard in spec section 10: photo, grid
   size, alignment. Tagging and save are A2, so this stops after alignment and
   says so rather than pretending to finish.

   This screen owes two user-facing states from the amended rule 4 in section
   13: rate limited, and photo too large. Both come from ApiError. */

import { useState } from "preact/hooks";
import type { GridAlignment } from "../../types";
import { ApiError, createSession, photoUrl, uploadPhoto } from "../lib/api.ts";
import { defaultAlignment } from "../lib/alignment.ts";
import { downscale, kb, LONGEST_EDGE } from "../lib/photo.ts";
import { remember } from "../lib/local.ts";
import { navigate } from "../lib/router.ts";
import { AlignmentEditor } from "../components/AlignmentEditor.tsx";

const MAX_SIDE = 30; /* Spec section 7. */

type Step = "photo" | "grid";

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

            <div class="notice">
              Tagging each cell and saving arrives with milestone A2. Your photo
              and this session are already saved, so the link keeps working.
              <div class="row" style="margin-top:0.75rem">
                <button onClick={() => navigate("/")}>Back to start</button>
              </div>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
