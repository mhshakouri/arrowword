# Arrowword Co-op

Several people solve a Persian crossword together, in real time, on separate
devices. No accounts and no OCR: the humans read the clues, the app holds the
grid, the shared letters, and the voice.

**Live at [arrowword.mhshakouri.dev](https://arrowword.mhshakouri.dev).** Open
it, click the demo, send the link to someone.

## What it does

Three ways to start a puzzle:

- **Clone the demo**, which is one click from the landing page.
- **Photograph a printed arrowword**, mark the grid over the photo by dragging
  four corners, tag each cell, save, share the link.
- **Generate one from a theme**, in Persian or English, using Workers AI.

Then, in a session: letters sync live, letters typed offline are kept and sent
when the connection returns, and players can hold a button to talk to each
other. The interface is Persian and English, switchable from any screen, and
the puzzle's language is chosen separately from the reader's.

## Running it

```bash
npm install
npm run build    # the UI into dist/, which the worker serves
npm run dev      # worker on :8787, serving the API and the built UI
npm test         # 368 checks; each file starts and stops its own worker
```

`npm run dev:ui` runs Vite with hot reload alongside it. See `AGENTS.md` for
the rest of the commands, including the scripts that talk to the real model.

## How it works

One **Durable Object per session** holds the whole session document and
serializes every write, so conflict handling costs nothing. The session id is
128 random bits and is the only credential: whoever has the link is a player.
Sessions expire themselves after 30 days of inactivity through a DO alarm, with
an R2 lifecycle rule as a backstop. Photos live in R2, keyed by session.

The UI is a Preact single page app served as static assets **from the same
worker** that serves the API, so everything is same-origin and there is no
CORS. Crossword packing runs in the browser, because Workers Free allows 10ms
of CPU per request and a backtracking packer is pure CPU; the server validates
whatever the client produces, exactly as it would any other untrusted input.

Voice is push to talk over the WebSocket that already carries the puzzle. That
is deliberate rather than convenient: on the network this was built for,
mainstream calling apps are unreachable, so the transport that already works is
the only one that works. Clips are relayed and dropped, never stored.

## The documents

`docs/SPEC.md` is the source of truth, not this file. It carries the data
model and its eighteen invariants, the error contract, every configurable
limit, the milestone history with what each check actually proved, and
seventeen decision records including the ones for things that were **not**
built.

`AGENTS.md` is the working guide: commands, conventions, and the two things to
know before touching generation.

## Two things worth reading even if you never run it

**A validator can tell you output is well formed. It cannot tell you it is any
good.** While choosing a generation model, a small model passed every
mechanical check, script, length, single word, no Arabic letters, eight out of
eight, while offering a paw as a bird and calling a leopard one. Persian made
that visible; the problem is not Persian. See D2 in the spec.

**Green tests, a clean review, and a completely broken feature.** Workers AI
returns its reply as a parsed object under JSON Mode and as a string without
it. Every provider test returned a string, so the suite passed while the live
app could not generate anything at all. `npm run probe:live` exists because of
that, and it runs before anything on the generation path merges. See E1.
