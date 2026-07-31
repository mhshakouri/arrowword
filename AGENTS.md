# Arrowword Co-op

Cooperative Persian arrowword solving for two devices, from a photo, without OCR.
Full spec, including the collaboration protocol and the ready/done gate: `docs/SPEC.md`.
Read the spec before writing code. It is the source of truth, not this file.

Split out of the mhshakouri.dev repo on 2026-07-31 to live on its own subdomain.

Parent project: the personal website, `github.com/mhshakouri/mhshakouri.dev`,
local path `../mhshakouri`. It links to this project and describes it; it never
hosts it. Design tokens are copied from there, never imported.

**State: A0 complete, not deployed.** Deploying needs an R2 bucket created on
Hossein's account first, which is his step, not Claude's. See spec section 14.

## Stack

- Cloudflare Worker, one Durable Object per session (`ArrowwordSession`), R2 for photos
- TypeScript strict, `noUncheckedIndexedAccess`
- No framework on the server. UI framework not yet chosen.

## Commands

- `npm run dev` - local worker on :8787
- `npm run typecheck` - TypeScript
- `npm test` - acceptance suite, starts its own worker if none is running
- `npm run deploy` - deploy to Cloudflare (needs `wrangler login`)
- `npm run format` - Prettier

## Conventions

- The invariants in spec section 4 must never break. Check changes against them.
- Every milestone passes the ready/done gate in spec section 13 before it counts
  as finished. A milestone without a runnable check is not done.
- Stop and ask on the triggers in spec section 15. Decide and record everything
  cheap to change.
- Anything learned the hard way goes into the spec in the same commit.

## Deploy target

`arrowword.mhshakouri.dev`, its own worker, independent of the site's deploys.
