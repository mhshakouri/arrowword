# Arrowword Co-op

Two people solve a printed Persian arrowword together, from a photo, on separate
devices. No OCR: the humans read the clues, the app holds the grid and the
shared letters.

Live at `arrowword.mhshakouri.dev` (not yet deployed).

## Status

- **A0 worker skeleton: done.** Durable Object per session, R2 photo storage,
  WebSocket sync, server-side validation. 15 acceptance checks.
- **A1 photo and alignment UI: next.**

## Running it

```bash
npm install
npm test        # starts a local worker, runs 15 checks, shuts it down
npm run dev     # local worker on :8787
```

## How it works

One Durable Object per session holds the entire session document and serializes
every write, so conflict handling is nearly free. The session id is a 128 bit
random value and is the only credential: whoever has the link is a player.
Photos live in R2, keyed by session.

Read `docs/SPEC.md` before changing anything. It carries the data model, the
error contract, the limits, the invariants, and the decision records.
