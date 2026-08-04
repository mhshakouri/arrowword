# Arrowword Co-op

Cooperative Persian arrowword solving for two devices, from a photo, without OCR.
Full spec, including the collaboration protocol and the ready/done gate: `docs/SPEC.md`.
Read the spec before writing code. It is the source of truth, not this file.

Split out of the mhshakouri.dev repo on 2026-07-31 to live on its own subdomain.

Parent project: the personal website, `github.com/mhshakouri/mhshakouri.dev`,
local path `../mhshakouri`. It links to this project and describes it; it never
hosts it. Design tokens are copied from there, never imported.

**State: v2 closed out 2026-08-04; D1, the bilingual UI, is code complete as
of 2026-08-05 and awaits its human check.** v1, B1, B3 and C1 are built,
deployed, and past their human checks. C2, live WebRTC voice, is declined
rather than postponed (ADR-15); building it needs a new decision record. The
UI speaks Persian and English through a typed dictionary (ADR-16), switchable
from every screen; the outstanding human check is a native read-through of the
Persian copy.

C1 passed the check it exists for on 2026-08-04: a voice clip from a phone in
Iran arrived audibly. The one accepted gap is **iOS Safari, closed as not
testable rather than as tested**; if voice ever misbehaves on an iPhone, the
`AudioContext` resume path is the first suspect. Three ways in, all working end
to end: clone the demo from the landing page, make a puzzle from a photo
through alignment, tagging, save, and share link, or generate a crossword from
a theme. See spec section 12.

Voice is push to talk over the session WebSocket, and that is deliberate: on
the network this feature exists for, WhatsApp and Telegram are unreachable, so
a clip over the WebSocket that already syncs letters is the only transport that
works. ADR-14 chose that bet and the Iran clip settled it.

**This is a public app** as of 2026-08-02 (spec v6): open to visitors with no
credentials, linked from the playground series on mhshakouri.dev. There is no
authentication and there will not be, see ADR-7. Anyone on the internet can call
every endpoint, so rate limits, bounded retention, and stream-enforced upload
limits are load-bearing rather than nice to have.

## Stack

- Cloudflare Worker, one Durable Object per session (`ArrowwordSession`), R2 for photos
- One DO alarm per session drives self-expiry, 30 days of inactivity (ADR-8)
- TypeScript strict, `noUncheckedIndexedAccess`
- No framework on the server. UI is a Vite single page app on Preact, served as
  static assets from this same worker (ADR-10), which keeps everything
  same-origin. `run_worker_first` in `wrangler.jsonc` decides what reaches the
  worker instead of the asset handler.
- Two tsconfigs on purpose: the worker gets Workers types and no DOM, the UI
  gets DOM and no Workers types.
- CI is GitHub Actions, checks only. CD is Cloudflare Workers Builds, which
  deploys every push to `main` (ADR-11). Branch protection requiring `checks`
  is what keeps `main` deployable, so do not remove it.

## Commands

- `npm run dev` - the worker on :8787, serving the API and the built UI
- `npm run dev:ui` - Vite with hot reload, proxying the API to :8787. Run both
- `npm run build` - the UI into `dist/`, which the worker serves as assets
- `npm run typecheck` - two configs: the worker has no DOM, the UI has no Workers
- `npm test` - the CI suite: unit, acceptance, photo cap, expiry, generation. 333 checks
- `npm run test:all` - the above plus the template run. 348 checks
- `npm run deploy` - deploy by hand. Normally a merge to `main` does it
- `npm run probe` - put prompts in front of the **real** model and report what
  came back, judged by the real modules. Needs `wrangler login` and spends
  neurons, so it is local only and never in CI. `PROBE_MODEL`, `PROBE_VARIANTS`,
  `PROBE_THEMES` and `PROBE_DUMP` narrow a run. This is the by-hand measurement
  script ADR-12 asks for, and it reports neurons per call
- `npm run format` / `format:check` - Prettier

Each test file starts and stops its own `wrangler dev`, so they need no setup and
must not be run in parallel. Five entry points, because four of them need a
worker configured differently:

- `test:acceptance` - the main suite, default configuration
- `test:photo` - a 2 KB photo cap, so the limit is testable without moving 8 MB
- `test:expiry` - a 3 second retention window, so expiry is observable
- `test:generate` - a Turnstile test secret and recorded fixtures, so generation
  runs with no key and spends no neurons. Restarts its worker per scenario
- `test:template` - **local only, excluded from `npm test`.** Needs Durable Object
  state to survive a worker restart, which a GitHub runner does not manage. See
  spec section 7

## Configuration

Spec section 7 has the table. Things worth knowing before changing anything:

- `RETENTION_MS`, `MAX_PHOTO_BYTES`, `GENERATION_FIXTURES` and
  `GENERATION_POOL_KEY` exist for tests and are absent from `wrangler.jsonc` on
  purpose.
- `TEMPLATE_SESSIONS` is how a demo puzzle is named: a config edit plus a
  deploy rather than an API call.
- `GENERATION_MODEL` picks the Workers AI model, empty meaning the default in
  `src/generate/provider.ts`. The daily ceiling in section 7 is derived from the
  chosen model's output rate, so switching means re-deriving it.
- `GENERATION_LAYOUT_FIRST` asks the model for a whole layout before asking for
  words, which is how the pipeline ran until 2026-08-04 and does not work with
  a small model. Off by default; kept so the comparison stays available.
- `GENERATION_DEBUG` logs the model's raw reply and should stay off: the app
  shows the same transcript on its own pages, which is where somebody who needs
  it can reach it.
- `TURNSTILE_SECRET` is a secret, set with `wrangler secret put`. Its public
  partner `TURNSTILE_SITE_KEY` is a var and belongs in the file.

## Conventions

- The eighteen invariants in spec section 4 must never break. Check changes against them.
  `src/types.ts` and spec section 4 are in step at `v: 3` since B1. If they ever
  drift again, the spec is the source of truth and the code is the bug.
- Every milestone passes the ready/done gate in spec section 13 before it counts
  as finished. A milestone without a runnable check is not done.
- Stop and ask on the triggers in spec section 15. Decide and record everything
  cheap to change.
- Anything learned the hard way goes into the spec in the same commit.

## Deploy target

`arrowword.mhshakouri.dev`, its own worker, independent of the site's deploys.
