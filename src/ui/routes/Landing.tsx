/* Route `/`. Demo first, per spec section 5.

   The ordering is the point. Section 1 says a visitor arriving from the
   playground will not go and photograph a printed puzzle, so the setup wizard
   is the specialist path and the demo is the front door. */

import { useState } from "preact/hooks";
import { forget, visited } from "../lib/local.ts";
import { navigate } from "../lib/router.ts";

/* Set once A2.5 creates the template. Until then the demo card says so rather
   than linking somewhere that 404s. */
const DEMO_SESSION_ID: string | null = null;

export function Landing() {
  const [sessions, setSessions] = useState(visited);

  return (
    <main>
      <h1>Arrowword Co-op</h1>
      <p class="lede">
        Solve a puzzle together, on separate devices. Letters sync as you type.
      </p>

      <div class="stack">
        <section class="card">
          <h2 style="margin-top:0;font-size:1.1rem">Play the demo</h2>
          {DEMO_SESSION_ID ? (
            <>
              <p class="muted">
                A ready-made puzzle. Opening it makes your own copy, so you
                cannot spoil anyone else's.
              </p>
              <button
                class="primary"
                onClick={() => navigate(`/s/${DEMO_SESSION_ID}`)}
              >
                Open the demo
              </button>
            </>
          ) : (
            <p class="muted">
              Not ready yet. The demo puzzle arrives with milestone A2.5, which
              needs the tagging step built first.
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
