/* Route `/generate`. B3, spec section 11.

   A theme, a Turnstile challenge, and a button. The challenge is here and
   nowhere else: section 7 puts it on the generate endpoint only, so the path a
   visitor actually takes, clone the demo and play, never sees one. */

import { useEffect, useRef, useState } from "preact/hooks";
import { navigate } from "../lib/router.ts";
import { remember } from "../lib/local.ts";
import { Crumbs } from "../components/Crumbs.tsx";

const MAX_THEME = 60;
const WIDGET_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

type State = "idle" | "starting" | "refused";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: Record<string, unknown>,
      ) => string | undefined;
      remove?: (id: string) => void;
    };
  }
}

export function Generate() {
  const [theme, setTheme] = useState("");
  const [state, setState] = useState<State>("idle");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  /* Whether a token is in hand. State rather than only a ref, because the
     button has to become enabled when the challenge passes, and a ref changing
     renders nothing. */
  const [ready, setReady] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);
  /* Held in a ref rather than state: a token arriving should not re-render a
     form somebody is typing in. */
  const tokenRef = useRef<string | null>(null);

  /* The site key comes from the worker rather than the bundle, so rotating the
     widget is a config change and a deploy rather than a rebuild. */
  useEffect(() => {
    let gone = false;
    void fetch("/config")
      .then((r) => r.json())
      .then((c: { turnstileSiteKey?: string | null }) => {
        if (!gone) setSiteKey(c.turnstileSiteKey ?? null);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    if (!siteKey || !widgetRef.current) return;
    let gone = false;
    let widgetId: string | undefined;

    const render = () => {
      if (gone || !widgetRef.current || !window.turnstile) return;
      widgetId = window.turnstile.render(widgetRef.current, {
        sitekey: siteKey,
        callback: (token: string) => {
          tokenRef.current = token;
          setReady(true);
        },
        "error-callback": () => {
          tokenRef.current = null;
          setReady(false);
        },
        /* A token is single use and expires. Clearing it on expiry means the
           button refuses rather than sending something Cloudflare will reject,
           which would read to the visitor as the app being broken. */
        "expired-callback": () => {
          tokenRef.current = null;
          setReady(false);
        },
      });
    };

    if (window.turnstile) {
      render();
      return () => {
        gone = true;
        if (widgetId) window.turnstile?.remove?.(widgetId);
      };
    }

    /* `render=explicit` plus a named `onload` is the documented handshake.

       Corrected 2026-08-04, and the first diagnosis was wrong: this was
       originally called a race in which `window.turnstile` was undefined at
       `script.onload`. It is not. The widget does appear, it is simply **slow**,
       sometimes many seconds, and the UI made that look like a failure by
       leaving the button enabled and answering a press with "the check has not
       finished yet" while showing nothing that was in progress.

       The handshake stays because it is the documented way and removes any
       ambiguity about when `turnstile` exists. **The fix a person actually
       notices is the button state below**, which now waits rather than
       accusing. Worth recording: the bug was in what the screen said about a
       slow dependency, not in the dependency. */
    const callback = `onTurnstile_${Math.random().toString(36).slice(2)}`;
    (window as unknown as Record<string, unknown>)[callback] = render;
    const script = document.createElement("script");
    script.src = `${WIDGET_SRC}?render=explicit&onload=${callback}`;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);

    return () => {
      gone = true;
      if (widgetId) window.turnstile?.remove?.(widgetId);
      delete (window as unknown as Record<string, unknown>)[callback];
    };
  }, [siteKey]);

  const start = async () => {
    const cleaned = theme.trim().slice(0, MAX_THEME);
    if (!cleaned) return;
    if (!tokenRef.current) {
      setRefusal("The check has not finished yet. Give it a moment.");
      return;
    }
    setState("starting");
    setRefusal(null);
    try {
      const res = await fetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: cleaned, token: tokenRef.current }),
      });
      /* Spent whether it worked or not: a Turnstile token is single use, so
         holding on to it would guarantee the next attempt fails. */
      tokenRef.current = null;
      setReady(false);

      if (res.ok) {
        const { id } = (await res.json()) as { id: string };
        /* Named and typed from the start, so the list is right even if the
           person closes the tab while it is still being written. */
        remember(id, cleaned.charAt(0).toUpperCase() + cleaned.slice(1), {
          kind: "generated",
        });
        navigate(`/s/${id}`);
        return;
      }

      /* Every one of these is a state with words, per rule 4 of the Done gate.
         The two 429s say different things and a visitor can act on one of
         them. */
      const body = (await res.text()).trim();
      setState("refused");
      setRefusal(
        res.status === 403
          ? "The check did not pass. Reload the page and try again."
          : body === "daily limit reached"
            ? "You have used today's puzzles. They come back tomorrow."
            : body === "out of budget for today"
              ? "Everyone's shared daily budget for new puzzles is spent. It resets tomorrow, and the demo puzzle is still there."
              : "Could not start. Try again in a moment.",
      );
    } catch {
      setState("refused");
      setRefusal("Could not reach the server. Check your connection.");
    }
  };

  return (
    <main>
      <Crumbs />
      <h1>Make a puzzle</h1>
      <p class="lede">
        Give a theme and a language model writes a small English crossword for
        it: the grid, the words and the clues. It takes under a minute, and you
        can share the link with anyone.
      </p>

      <div class="card stack">
        <div>
          <label for="theme">Theme</label>
          <input
            id="theme"
            type="text"
            maxLength={MAX_THEME}
            placeholder="rivers, the kitchen, birds…"
            value={theme}
            disabled={state === "starting"}
            onInput={(e) =>
              setTheme((e.currentTarget as HTMLInputElement).value)
            }
          />
          <p class="muted" style="margin-bottom:0">
            Ten puzzles a day each, because the model runs on a shared free
            allowance. A theme is a subject, not a list: "movies" gives a puzzle
            about film, not a puzzle of film titles.
          </p>
        </div>

        {/* Rendered even before the key arrives, so the layout does not jump
            when it does. */}
        <div ref={widgetRef} />
        {siteKey !== null && !ready && (
          <p class="muted" role="status">
            Checking that you are a person. This is Cloudflare Turnstile and it
            occasionally takes several seconds; the button will enable itself.
          </p>
        )}
        {siteKey === null && (
          <p class="muted">Loading the check that you are a person…</p>
        )}

        {refusal && (
          <p class="notice error" role="alert">
            {refusal}
          </p>
        )}

        <div class="row">
          <button
            class="primary"
            disabled={state === "starting" || !theme.trim() || !ready}
            onClick={() => void start()}
          >
            {state === "starting"
              ? "Starting…"
              : ready
                ? "Make it"
                : "Waiting for the check…"}
          </button>
          <a class="button" href="/">
            Back
          </a>
        </div>
      </div>
    </main>
  );
}
