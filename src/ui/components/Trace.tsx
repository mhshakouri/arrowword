/* What was asked and what came back, shown on the page.

   Until this existed, diagnosing a failed generation meant `wrangler tail` on
   the author's laptop while somebody else pressed the button. That is not a
   thing a visitor can do and it was slow even for the person who wrote it.

   It is also the honest thing to show. A generated puzzle is the one place in
   this app where a machine makes a decision nobody can see, and a screen that
   says "that theme did not work out" while knowing exactly why is withholding
   the only useful part.

   Collapsed by default. Somebody who wanted a puzzle does not want a
   transcript, and somebody whose puzzle failed wants nothing else. */

import { useState } from "preact/hooks";
import { useT } from "../i18n/index.ts";
import type { TraceStep } from "../../types";

export function Trace({ steps }: { steps: TraceStep[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;

  return (
    <section style="margin-top:1.5rem">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        {t.trace.toggle(open, steps.length)}
      </button>

      {open && (
        <div class="stack" style="margin-top:0.75rem">
          <p class="muted" style="margin:0">
            {t.trace.wholeRecord}
          </p>
          {steps.map((step, i) => (
            <details key={i} class="card trace-step">
              <summary>
                <strong>{t.trace.steps[step.step] ?? step.step}</strong>
                {step.detail ? `: ${step.detail}` : ""}
                {step.ms !== undefined
                  ? t.trace.seconds((step.ms / 1000).toFixed(1))
                  : ""}
                {step.parsed === false ? t.trace.notRead : ""}
                {step.mode ? ` · ${step.mode}` : ""}
              </summary>

              {step.problems?.length ? (
                <>
                  <h3 class="trace-heading">{t.trace.whatWasWrong}</h3>
                  {/* Validator output is English regardless of the UI. */}
                  <ul class="trace-problems" dir="ltr">
                    {step.problems.map((p, j) => (
                      <li key={j}>{p}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {/* Rendered inside <pre> as text, never as HTML. The prompt
                  carries a theme somebody typed and the reply is model output,
                  so both are exactly the untrusted strings invariant 8 is
                  about, and this is the screen that displays the most of
                  them. The transcript itself is English model traffic, which
                  is why the <pre> blocks pin dir="ltr" whatever the UI is. */}
              {step.prompt && (
                <>
                  <h3 class="trace-heading">{t.trace.sent}</h3>
                  <pre class="trace-text" dir="ltr">
                    {step.prompt}
                  </pre>
                </>
              )}
              {step.reply && (
                <>
                  <h3 class="trace-heading">{t.trace.replied}</h3>
                  <pre class="trace-text" dir="ltr">
                    {step.reply}
                  </pre>
                </>
              )}
              {step.reply === "" && <p class="muted">{t.trace.emptyReply}</p>}
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
