# Arrowword Co-op

Cooperative Persian arrowword solving for two devices, from a photo, without OCR.
Full spec, including the collaboration protocol and the ready/done gate: `docs/SPEC.md`.
Read the spec before writing code. It is the source of truth, not this file.

Split out of the mhshakouri.dev repo on 2026-07-31 to live on its own subdomain.

Parent project: the personal website, `github.com/mhshakouri/mhshakouri.dev`,
local path `../mhshakouri`. It links to this project and describes it; it never
hosts it. Design tokens are copied from there, never imported.

**State: A5 code complete 2026-08-03, awaiting the full-puzzle check. That is
the last of v1; after it, the B series adds AI generated puzzles.** The demo is playable end to end: clone it from the landing
page and type into the grid. What remains is optimistic echo, reconnection, and
retry of an unacknowledged write. A puzzle can
now be made end to end: photo, alignment, tagging, save, share link. What
remains is the demo template, play rendering, and sync. See spec section 12.

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

- `npm run dev` - local worker on :8787
- `npm run typecheck` - TypeScript
- `npm test` - acceptance suite, starts its own worker if none is running
- `npm run deploy` - deploy to Cloudflare (needs `wrangler login`)
- `npm run format` - Prettier

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
