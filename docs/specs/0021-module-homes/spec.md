# 0021: Two modules move to where their imports say they live

## Status

Specced, tests written and confirmed failing against the prior tree, then built,
2026-08-23.

**Guarantee touched:** none of the eight changes meaning. This is a core change by
the rule in `AGENTS.md` because the diff is in `src/`, and it is the same kind of
change as `0011`: the layout catches up with what is already true, plus one small
behavioural consequence (the navigator now provisions its own OpenAI backend).

## The finding

The import graph disagreed with the directory layout in two places.

**`core/notices.js` was core in name only.** Nothing in `core/` imports it; its
only consumer in the tree is the Telegram adapter, and beyond the spool it holds
`RunMarker` and `restartAnnouncement`, which exist because a chat surface has an
owner to announce restarts to (spec `0005`). This is also the honest resolution of
refactor.md §4's known wrinkle: the `[telegram]` log prefixes inside core were
never mislabeled strings, they were correctly labeled strings in the wrong
directory. The on-disk spool format remains guarantee 8's egress contract exactly
as before; only the module that reads it moves.

**The navigator's OpenAI backend lived in `surface/`.** `drivers/navigator.js`
needs `navigationDecision`, which sat in `surface/openai-helper.js`, and the
"drivers never import surface" rule was satisfied only because `main.js` injected
the helper. Letter observed, spirit not: delete `surface/` and session-startup
navigation loses its backend even though navigating startup screens is entirely a
driver concern. Transcription genuinely is surface; it exists because voice notes
arrive from a chat.

**`core/client.js` stays, and the decision is recorded here.** It is also
imported by nothing in `core/`, but it is the caller half of the socket API pair
and belongs beside `server.js` as the contract's two faces; the CLI in `main.js`
and any future surface are its intended consumers. The structural rule below is
written to permit exactly this shape: a core module used from the composition
root is core; a core module used only by the surface is not.

## The change

1. `core/notices.js` moves to `surface/notices.js`, byte-identical logic, imports
   adjusted. Nothing else rides along.
2. `surface/openai-helper.js` splits: `NAVIGATION_SCHEMA` and `navigationDecision`
   move to a new `drivers/openai-navigation.js`; transcription stays in the slim
   helper. The two generic HTTP utilities they shared (`withAbortTimeout`,
   `jsonOrNull`) move to `core/util.js`.
3. `drivers/navigator.js` constructs its own `OpenAINavigation` from config; the
   injected parameter becomes `navigation` and remains for tests. `main.js` no
   longer builds an OpenAI helper for the daemon at all; only the Telegram mode
   does, for transcription.

## What decides success

- A new structural rule in `test/source-layout.test.js`: **core hosts nothing
  that only the surface uses.** Every module under `core/` must be imported by
  core, drivers, or the root files. It fails on the prior tree (notices) and
  passes after the move, and it is what stops the next surface-only module from
  quietly settling in core.
- A new navigator test: with `CLI_RUNTIME_OPENAI_NAVIGATOR=1` and an API key in
  config, a navigator constructed with no injected helper is enabled and produces
  a decision through its own backend. It fails on the prior code, where an
  uninjected navigator is silently disabled.
- The moved and split modules keep their existing suites, re-pointed.

## Not done, and known

The `[telegram]` prefix inside what is now `surface/notices.js` is left exactly
as it is: in its new home the label is simply true. `refactor.md` §4's wrinkle is
closed by the move, not by an edit.
