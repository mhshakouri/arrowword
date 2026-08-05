# Arrowword Co-op

Cooperative Persian arrowword solving for two devices, from a photo, without OCR.
Full spec, including the collaboration protocol and the ready/done gate: `docs/SPEC.md`.
Read the spec before writing code. It is the source of truth, not this file.

Split out of the mhshakouri.dev repo on 2026-07-31 to live on its own subdomain.

Parent project: the personal website, `github.com/mhshakouri/mhshakouri.dev`,
local path `../mhshakouri`. It links to this project and describes it; it never
hosts it. Design tokens are copied from there, never imported.

**State: complete as of 2026-08-05, spec v10.** v1, B1, B3, C1, D1, D2, E1 and
E2 are built, deployed, and past their human checks. C2, live WebRTC voice, is
declined rather than postponed (ADR-15); building it needs a new decision
record. Nothing is owed by a person and no milestone remains.

Three ways in, all working end to end: clone the demo, make a puzzle from a
photo through alignment, tagging, save, and share link, or generate one from a
theme **in Persian or English**. The UI speaks both through a typed dictionary
(ADR-16) and the puzzle's language is chosen separately from the reader's.

**Two things to know before touching generation.** The model must support JSON
Mode, because the schema is the contract and the salvage layer is gone (E1); and
**`npm run probe:live` before merging**, because E1 shipped green tests, a clean
review, and a completely broken feature. Spec section 12 has both stories.

C1 passed the check it exists for on 2026-08-04: a voice clip from a phone in
Iran arrived audibly. The one accepted gap is **iOS Safari, closed as not
testable rather than as tested**; if voice ever misbehaves on an iPhone, the
`AudioContext` resume path is the first suspect.

**Persian copy is drafted by Claude and corrected by Hossein**, and the register
is recorded in D1's milestone entry: plain, explicit, ordinary product Persian.
Drafts skew compact and literal-from-English; every correction so far was
longer, plainer, and used the domain's own word («جدول», not «شبکه»).

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
- `npm test` - the CI suite: unit, acceptance, photo cap, expiry, generation. 368 checks
- `npm run test:all` - the above plus the template run. 383 checks
- `npm run deploy` - deploy by hand. Normally a merge to `main` does it

Three scripts talk to the **real** model. All need `wrangler login`, all spend
neurons, none is ever in CI. **`wrangler dev` without `--local` is what reaches
the real model**, using the OAuth session that login created; cloudflared has
nothing to do with it and is the wrong tool, being a tunnel that points the
other way.

- `npm run probe:live` - **run this before merging anything on the generation
  path.** One real generation through the real `workersAiProvider` and the real
  `generate` loop, shimming only the AI binding. It exists because `npm run
probe` passed while production was down: see E1 in spec section 12.
  `PROBE_LANG=fa` and `PROBE_THEMES` pick the run
- `npm run probe` - put prompts in front of the model and report what came
  back. Good for comparing prompts and models, where it never touches the
  app's shipped path; it is **not** a check that the app works. `PROBE_MODEL`,
  `PROBE_VARIANTS`, `PROBE_THEMES`, `PROBE_LANG`, `PROBE_SCHEMA`,
  `PROBE_MAXTOK` and `PROBE_DUMP` narrow a run, and it reports neurons per
  call, which is the measurement ADR-12 asks for
- `npm run probe:reasoning` - prints a reasoning model's thinking rather than
  counting it, and tries the documented ways to reduce it. Written because
  "these models return nothing" was not a credible finding and turned out to be
  wrong
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
  `src/generate/provider.ts`, which is `llama-3.3-70b-instruct-fp8-fast` since
  E1. **Pick a model that supports JSON Mode or generation breaks**: the schema
  is the contract now and there is no free-form fallback. Cloudflare's
  supported list is stale in both directions, so test rather than trust it. The
  daily ceiling in section 7 derives from the chosen model's output rate, so
  switching means re-deriving it.
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
