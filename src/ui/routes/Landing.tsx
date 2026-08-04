/* Route `/`. Demo first, per spec section 5.

   The ordering is the point. Section 1 says a visitor arriving from the
   playground will not go and photograph a printed puzzle, so the setup wizard
   is the specialist path and the demo is the front door. */

import { useEffect, useState } from "preact/hooks";
import { ApiError, cloneSession, loadConfig } from "../lib/api.ts";
import { forget, remember, visited } from "../lib/local.ts";
import { navigate } from "../lib/router.ts";

export function Landing() {
  const [sessions, setSessions] = useState(visited);
  /* Three states rather than two. Starting at `null` and only learning the real
     value after `/config` resolves meant a visitor saw "no demo puzzle is set up
     yet" for a moment before the button appeared, which is the opposite of the
     truth and is the first thing anyone arriving from the playground reads. */
  const [demoId, setDemoId] = useState<string | null | "unknown">("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /* A missing demo is an ordinary state, not an error: no template is
       configured until one has been made and named. */
    void loadConfig()
      .then((c) => setDemoId(c.demoSessionId))
      .catch(() => setDemoId(null));
  }, []);

  async function openDemo() {
    if (!demoId || demoId === "unknown") return;
    setError(null);
    setBusy(true);
    try {
      /* Clone first, then go. Nobody is ever sent to the template itself: it is
         read-only, so landing there would mean explaining why typing does
         nothing. A copy is playable immediately and cannot spoil anyone else's. */
      const mine = await cloneSession(demoId);
      remember(mine, "Demo puzzle");
      navigate(`/s/${mine}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.failure.message
          : "Could not open the demo just now.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Arrowword Co-op</h1>
      <p class="lede">
        Solve a puzzle together, on separate devices. Letters sync as you type.
      </p>

      <div class="stack">
        {/* Two ways in, not three.

            It was three: play the demo, make one from a photo, make one with
            AI. That reads as three unrelated products, and it buries the fact
            that the demo and the photo wizard are the *same* puzzle form
            arrived at from two directions. Grouped by what you end up with,
            because that is the choice a visitor is actually making. */}
        <section class="card stack">
          <h2 style="margin-top:0;font-size:1.1rem">
            A photographed arrowword
          </h2>
          <p class="muted" style="margin:0">
            The Persian puzzle this app is named after: a photo of a printed
            grid, with the clues in the picture. Play the ready-made one, or
            photograph your own.
          </p>
          <div class="row">
            {demoId === "unknown" ? (
              <span class="muted">Looking for the demo…</span>
            ) : demoId ? (
              <button
                class="primary"
                disabled={busy}
                onClick={() => void openDemo()}
              >
                {busy ? "Making your copy…" : "Play the demo"}
              </button>
            ) : null}
            <button onClick={() => navigate("/new")}>
              Make one from a photo
            </button>
          </div>
          {demoId && (
            <p class="muted" style="margin:0">
              Playing the demo makes your own copy, so you cannot spoil anyone
              else's.
            </p>
          )}
          {demoId === null && (
            <p class="muted" style="margin:0">
              No demo is set up yet. Make one from a photo, then name it in the
              worker's configuration to publish it here.
            </p>
          )}
          {error && (
            <p class="notice error" role="alert" style="margin:0">
              {error}
            </p>
          )}
        </section>

        <section class="card stack">
          <h2 style="margin-top:0;font-size:1.1rem">
            A crossword written by AI
          </h2>
          <p class="muted" style="margin:0">
            Give a theme and a language model writes an English crossword for
            it: the grid, the words and the clues. Under a minute, no photo.
          </p>
          <div class="row">
            <button class="primary" onClick={() => navigate("/generate")}>
              Write one from a theme
            </button>
          </div>
        </section>

        {sessions.length === 0 ? (
          <p class="muted">
            Puzzles you open will be listed here, in this browser only, because
            there are no accounts.
          </p>
        ) : (
          <section>
            <h2 style="font-size:1.1rem">Puzzles you have opened</h2>
            <p class="muted">
              Kept in this browser only, because there are no accounts. Clearing
              site data loses the list, and puzzles expire after 30 days without
              activity.
            </p>
            <ul class="stack" style="list-style:none;padding:0">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  class="card row"
                  style="justify-content:space-between;gap:0.75rem"
                >
                  <span
                    class="row"
                    style="gap:0.5rem;align-items:baseline;min-width:0"
                  >
                    {/* A failed generation is not a link. It has no grid and
                        never will, so offering to open it promises something
                        that cannot happen. */}
                    {s.failed ? (
                      <span style="min-width:0">{s.title || "Untitled"}</span>
                    ) : (
                      <a
                        href={`/s/${s.id}`}
                        style="min-width:0"
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/s/${s.id}`);
                        }}
                      >
                        {s.title || "Untitled"}
                      </a>
                    )}
                    {s.failed ? (
                      <span class="tag tag-failed">did not build</span>
                    ) : s.kind === "generated" ? (
                      <span class="tag">AI written</span>
                    ) : null}
                  </span>
                  <button
                    onClick={() => {
                      forget(s.id);
                      setSessions(visited());
                    }}
                    aria-label={`Remove ${s.title || "Untitled"} from this list`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            {sessions.some((s) => s.failed) && (
              <p class="muted">
                A puzzle that did not build still gets a link, because the
                session is created before anyone knows whether the model can
                write it. Nothing was saved into it and it deletes itself.
                Removing it here just tidies this list.
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
