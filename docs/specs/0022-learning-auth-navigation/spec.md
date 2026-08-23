# 0022: Navigation that learns the screens it was asked about

## Status

Specced, tests written and confirmed failing against the prior code, then built,
2026-08-23. This is the first slice of the driver-auth rework the owner asked
for; the attach hardening and the full URL-and-code delivery UX are deliberately
not in it.

**Guarantee touched:** none of the eight changes meaning. It is a core change by
the rule in `AGENTS.md` (the diff is in `src/`), scoped to the drivers layer:
the navigator and the auth manager.

## The idea, in the owner's terms

The intelligence layer navigates a driver's terminal toward its authentication
point by reading the tmux screen and choosing keystrokes. Every time it is
consulted about a screen nothing recognized, it must also say how to recognize
that screen next time: a case-insensitive regular expression that captures the
gist of the screen, the one stable phrase, never session-specific values. If
the whole authentication attempt succeeds, every screen learned during it is
committed to a persistent library; the next encounter is answered from the
library with no model call. Reliability comes from the model teaching the
deterministic layer, one successful attempt at a time.

## The pieces

**1. The screen library** (`drivers/screen-library.js`). A JSONL file at
`<state>/navigation/screens.jsonl`. Each entry: driver, the pattern, the action
it resolves to, the model's reason, when it was added, and which attempt taught
it. Entries are loaded once and matched against the bounded recent screen.
Patterns are capped at 200 characters, must compile, and must not match the
empty string; entries failing any of that are skipped on load and refused on
learn. The library is committed to only by a successful attempt: consults
accumulate as pending under an attempt id, `recordOutcome(attemptId, true)`
appends them, `false` discards them. A wrong lesson therefore requires a
successful authentication to have carried it, and the file is plain JSONL the
owner can edit or delete.

**2. The decision shape induces thinking.** The structured output is reordered
so the model must produce, in order: `reason`, `steps` (its short plan),
`screen_regex`, and only then `action`, `key`, `text`. The navigation model
becomes `gpt-5.6-terra` and requests low reasoning effort
(`CLI_RUNTIME_NAVIGATOR_EFFORT`, default `low`, `none` omits the parameter);
the ordered output is where the thinking happens instead. The system prompt
teaches the regex craft with examples: capture the stable title or question,
three to eight words, never codes, emails, tokenized URLs, or counts.

**3. The navigator consults the library first.** `decide()` checks the library
before paying for a model call; a hit is returned as a learned decision and
recorded as such in events. A model decision carrying a valid `screen_regex`
is remembered under the caller's attempt id. Callers that pass no attempt id
(session startup today) read the library but never write it.

**4. The auth manager navigates toward the prompt.** `start()` no longer stops
at the first screen: while the parsed phase is still `starting` and the pane is
alive, unknown screens are resolved through the navigator (throttled, bounded
by the startup timeout) until the auth URL or device code appears. Navigation
stops there; entering credentials remains human-driven. The attempt id is held
per driver; the existing status probe is the single commit point: a probe that
reports authenticated commits the attempt's lessons, a replaced or failed
attempt discards them. With the navigator disabled, behaviour is exactly
today's.

**5. The capture corpus** (`tools/capture-screens.mjs`). A development tool
that polls a tmux pane, deduplicates consecutive frames, and writes numbered
screen files plus an index. It exists so one real authentication event,
recorded once, becomes a replayable corpus; committed fixtures are sanitized
by hand from it, and raw captures stay out of the repository.

## What decides success

Tests written first and confirmed failing:

- a decision's `screen_regex` is validated: too long, non-compiling, or
  empty-matching patterns are dropped without failing the action;
- the first consult of an unknown screen calls the model and remembers the
  pattern; after `recordOutcome(true)` a fresh navigator over the same state
  directory resolves that screen from the library with no model call;
- `recordOutcome(false)` leaves the library untouched;
- the OpenAI request carries the new model default, `reasoning_effort`, and a
  schema whose first required property is `reason`;
- the auth manager walks a scripted unknown screen to the device-code screen
  through a stubbed navigator, and an authenticated status probe commits the
  lesson; a second manager over the same state resolves the same screen without
  the stub.

## Risks, stated

A model-supplied pattern is stored and executed. The caps (length, compile,
non-empty match, bounded input) limit pathological patterns; provenance and the
success-only commit limit poisoning; the file is owner-editable. Learned
actions are limited to the navigator's existing bounded vocabulary, and the
loop still never types credentials: the deterministic parser decides when the
auth point is reached, not the model.

## Not built, and known

The delivery UX (URL and code pushed to the owner in chat, code pasted back,
the 15-minute attempt ceiling) and the attach hardening are the next slices.
Session startup reads the library but does not yet learn into it; giving it an
attempt id is a two-line follow-up once this shape has survived real use.
