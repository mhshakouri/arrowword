# Arrowword Co-op

Cooperative Persian arrowword solving for two devices, from a photo, without OCR.
Full spec, including the collaboration protocol and the ready/done gate: `docs/SPEC.md`.
Read the spec before writing code. It is the source of truth, not this file.

Split out of the mhshakouri.dev repo on 2026-07-31 to live on its own subdomain.

Parent project: the personal website, `github.com/mhshakouri/mhshakouri.dev`,
local path `../mhshakouri`. It links to this project and describes it; it never
hosts it. Design tokens are copied from there, never imported.

**State: v1 complete 2026-08-03. C1, push to talk, is code complete and awaiting
its human check; C2 is live WebRTC voice. The B series, AI generated puzzles, is
postponed behind both (ADR-14).** There
are two ways in and both work end to end: clone the demo from the landing page
and type into the grid, or make a puzzle from a photo through alignment,
tagging, save, and share link. See spec section 12.

Voice ships push to talk first and live WebRTC second, which is the opposite of
the obvious order. The reason is in ADR-14 and it is worth reading before
touching it: on the network this feature exists for, WhatsApp and Telegram are
unreachable, so a clip over the session WebSocket is the only transport that
works. Do not reorder these two milestones without re-reading that record.

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
- `npm test` - the CI suite: unit, acceptance, photo cap, expiry. 98 checks
- `npm run test:all` - the above plus the template run. 113 checks
- `npm run deploy` - deploy by hand. Normally a merge to `main` does it
- `npm run format` / `format:check` - Prettier

Each test file starts and stops its own `wrangler dev`, so they need no setup and
must not be run in parallel. Four entry points, because three of them need a
worker configured differently:

- `test:acceptance` - the main suite, default configuration
- `test:photo` - a 2 KB photo cap, so the limit is testable without moving 8 MB
- `test:expiry` - a 3 second retention window, so expiry is observable
- `test:template` - **local only, excluded from `npm test`.** Needs Durable Object
  state to survive a worker restart, which a GitHub runner does not manage. See
  spec section 7

## Configuration

Spec section 7 has the table. Two things worth knowing before changing anything:
`RETENTION_MS` and `MAX_PHOTO_BYTES` exist for tests and are absent from
`wrangler.jsonc` on purpose, and `TEMPLATE_SESSIONS` is how a demo puzzle is
named, which is a config edit plus a deploy rather than an API call.

## Conventions

- The ten invariants in spec section 4 must never break. Check changes against them.
  `src/types.ts` is deliberately one version behind the spec until A0.5 lands v2.
- Every milestone passes the ready/done gate in spec section 13 before it counts
  as finished. A milestone without a runnable check is not done.
- Stop and ask on the triggers in spec section 15. Decide and record everything
  cheap to change.
- Anything learned the hard way goes into the spec in the same commit.

## Deploy target

`arrowword.mhshakouri.dev`, its own worker, independent of the site's deploys.
