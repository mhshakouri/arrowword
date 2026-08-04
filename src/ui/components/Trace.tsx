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
import type { TraceStep } from "../../types";

const LABEL: Record<TraceStep["step"], string> = {
  layout: "Asked for a whole puzzle",
  repair: "Sent the problems back to be fixed",
  words: "Asked for a word list to pack",
  validate: "Checked the grid",
  pack: "Laid it out on this device",
  done: "Finished",
};

export function Trace({ steps }: { steps: TraceStep[] }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;

  return (
    <section style="margin-top:1.5rem">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "Hide" : "Show"} what the model was asked and said (
        {steps.length} step{steps.length === 1 ? "" : "s"})
      </button>

      {open && (
        <div class="stack" style="margin-top:0.75rem">
          <p class="muted" style="margin:0">
            Every exchange with the language model, in order. This is the whole
            record; nothing is summarized.
          </p>
          {steps.map((step, i) => (
            <details key={i} class="card trace-step">
              <summary>
                <strong>{LABEL[step.step] ?? step.step}</strong>
                {step.detail ? `: ${step.detail}` : ""}
                {step.ms !== undefined
                  ? ` (${(step.ms / 1000).toFixed(1)}s)`
                  : ""}
                {step.parsed === false ? " · reply could not be read" : ""}
                {step.mode ? ` · ${step.mode}` : ""}
              </summary>

              {step.problems?.length ? (
                <>
                  <h3 class="trace-heading">What was wrong</h3>
                  <ul class="trace-problems">
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
                  them. */}
              {step.prompt && (
                <>
                  <h3 class="trace-heading">Sent to the model</h3>
                  <pre class="trace-text">{step.prompt}</pre>
                </>
              )}
              {step.reply && (
                <>
                  <h3 class="trace-heading">What it replied</h3>
                  <pre class="trace-text">{step.reply}</pre>
                </>
              )}
              {step.reply === "" && (
                <p class="muted">It replied with nothing at all.</p>
              )}
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
