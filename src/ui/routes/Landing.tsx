/* Route `/`. Demo first, per spec section 5.

   The ordering is the point. Section 1 says a visitor arriving from the
   playground will not go and photograph a printed puzzle, so the setup wizard
   is the specialist path and the demo is the front door. */

import { useEffect, useState } from "preact/hooks";
import { ApiError, cloneSession, loadConfig } from "../lib/api.ts";
import { forget, remember, visited } from "../lib/local.ts";
import { navigate } from "../lib/router.ts";
import { useT } from "../i18n/index.ts";

export function Landing() {
  const t = useT();
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

  /* "Untitled" is the server's sentinel and is stored verbatim, so it is
     mapped to the reader's language at display time rather than at save time. */
  const shownTitle = (title: string | undefined) =>
    !title || title === "Untitled" ? t.common.untitled : title;

  async function openDemo() {
    if (!demoId || demoId === "unknown") return;
    setError(null);
    setBusy(true);
    try {
      /* Clone first, then go. Nobody is ever sent to the template itself: it is
         read-only, so landing there would mean explaining why typing does
         nothing. A copy is playable immediately and cannot spoil anyone else's. */
      const mine = await cloneSession(demoId);
      remember(mine, t.landing.demoTitle);
      navigate(`/s/${mine}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.failure.message
          : t.landing.demoOpenFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>{t.landing.title}</h1>
      <p class="lede">{t.landing.lede}</p>

      <div class="stack">
        {/* Two ways in, not three.

            It was three: play the demo, make one from a photo, make one with
            AI. That reads as three unrelated products, and it buries the fact
            that the demo and the photo wizard are the *same* puzzle form
            arrived at from two directions. Grouped by what you end up with,
            because that is the choice a visitor is actually making. */}
        <section class="card stack">
          <h2 style="margin-top:0;font-size:1.1rem">
            {t.landing.photoCardTitle}
          </h2>
          <p class="muted" style="margin:0">
            {t.landing.photoCardBody}
          </p>
          <div class="row">
            {demoId === "unknown" ? (
              <span class="muted">{t.landing.lookingForDemo}</span>
            ) : demoId ? (
              <button
                class="primary"
                disabled={busy}
                onClick={() => void openDemo()}
              >
                {busy ? t.landing.makingCopy : t.landing.playDemo}
              </button>
            ) : null}
            <button onClick={() => navigate("/new")}>
              {t.landing.makeFromPhoto}
            </button>
          </div>
          {demoId && (
            <p class="muted" style="margin:0">
              {t.landing.demoCopyNote}
            </p>
          )}
          {demoId === null && (
            <p class="muted" style="margin:0">
              {t.landing.noDemoNote}
            </p>
          )}
          {error && (
            <p class="notice error" role="alert" style="margin:0">
              {error}
            </p>
          )}
        </section>

        <section class="card stack">
          <h2 style="margin-top:0;font-size:1.1rem">{t.landing.aiCardTitle}</h2>
          <p class="muted" style="margin:0">
            {t.landing.aiCardBody}
          </p>
          <div class="row">
            <button class="primary" onClick={() => navigate("/generate")}>
              {t.landing.writeFromTheme}
            </button>
          </div>
        </section>

        {sessions.length === 0 ? (
          <p class="muted">{t.landing.emptyListNote}</p>
        ) : (
          <section>
            <h2 style="font-size:1.1rem">{t.landing.openedTitle}</h2>
            <p class="muted">{t.landing.openedNote}</p>
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
                      <span style="min-width:0">{shownTitle(s.title)}</span>
                    ) : (
                      <a
                        href={`/s/${s.id}`}
                        style="min-width:0"
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/s/${s.id}`);
                        }}
                      >
                        {shownTitle(s.title)}
                      </a>
                    )}
                    {s.failed ? (
                      <span class="tag tag-failed">
                        {t.landing.didNotBuild}
                      </span>
                    ) : s.kind === "generated" ? (
                      <span class="tag">{t.landing.aiWrittenTag}</span>
                    ) : null}
                  </span>
                  <button
                    onClick={() => {
                      forget(s.id);
                      setSessions(visited());
                    }}
                    aria-label={t.landing.removeLabel(shownTitle(s.title))}
                  >
                    {t.landing.removeButton}
                  </button>
                </li>
              ))}
            </ul>
            {sessions.some((s) => s.failed) && (
              <p class="muted">{t.landing.failedListNote}</p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
