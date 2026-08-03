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
  const [demoId, setDemoId] = useState<string | null>(null);
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
    if (!demoId) return;
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
        <section class="card">
          <h2 style="margin-top:0;font-size:1.1rem">Play the demo</h2>
          {demoId ? (
            <>
              <p class="muted">
                A ready-made puzzle. Opening it makes your own copy, so you
                cannot spoil anyone else's.
              </p>
              <button
                class="primary"
                disabled={busy}
                onClick={() => void openDemo()}
              >
                {busy ? "Making your copy…" : "Open the demo"}
              </button>
              {error && (
                <p class="notice error" role="alert" style="margin-top:0.75rem">
                  {error}
                </p>
              )}
            </>
          ) : (
            <p class="muted">
              No demo puzzle is set up yet. Make one below, then name it in the
              worker's configuration to publish it here.
            </p>
          )}
        </section>

        <section class="card">
          <h2 style="margin-top:0;font-size:1.1rem">Make a puzzle</h2>
          <p class="muted">
            Photograph a printed arrowword, mark the grid over it, and share the
            link. This takes a few minutes.
          </p>
          <button onClick={() => navigate("/new")}>New puzzle</button>
        </section>

        {sessions.length > 0 && (
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
                  style="justify-content:space-between"
                >
                  <a
                    href={`/s/${s.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/s/${s.id}`);
                    }}
                  >
                    {s.title || "Untitled"}
                  </a>
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
          </section>
        )}
      </div>
    </main>
  );
}
