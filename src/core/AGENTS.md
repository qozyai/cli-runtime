# core

The turn path. A message arrives, a model runs, an answer comes back, and the turn
is recorded. That is what this directory is.

The eight guarantees in the repository's `AGENTS.md` live here. Read them before
changing anything in this directory; a change here is a core change and carries a
spec and a test that fails without it.

## What may be imported

- other files in `core/`
- `drivers/` — the core has to be able to launch one

**Never `surface/`.** Nothing here may know that a chat application exists. This
directory deals in session keys and workspaces. `test/source-layout.test.js` enforces
it, and will also fail if a new file is left in `src/` root rather than placed.

## The shape of a mistake here

Adding a branch on which provider ran, above `artifact-parser.js`. Making something
optional into something a turn depends on. Changing when a turn is considered
finished. Reaching for the owner, the route, or the project catalog — if you need
one of those, the thing you are building belongs in `surface/`.
