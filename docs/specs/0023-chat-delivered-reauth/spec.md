# 0023: Re-authentication delivered through the chat

## Status

Specced, tests written and confirmed failing against the prior code, then built,
2026-08-24. Developed and cleared in the test environment per the owner's
process; deployed only on their word. Completes the flow `0022` began.

**Guarantees touched:** none of the eight changes meaning; guarantee 5's spirit
extends to the repair path: when a turn cannot run because a driver lost its
login, the repair now arrives on the same route the message came from, instead
of pointing at a terminal that may not be reachable at all (`/attach` is not
even configured on this agent, which is how the gap surfaced).

## The flow

When an ordinary message finds its session `auth_required` even after the
optimistic restart, the adapter no longer sends attach instructions. It starts
the auth terminal (whose `0022` loop walks known screens deterministically,
library-taught screens second, the Terra model third, and stops at the auth
point), reads the parsed URL and device code, and tells the owner exactly what
to do in chat:

- **Codex**: open the URL, enter the code, approve. Nothing to send back; the
  adapter polls the status probe and announces completion by itself.
- **Claude**: open the URL, approve, reply here with the authorization code.
  A pending-reauth route treats a single long code-shaped token as that code,
  submits it to the auth terminal, and confirms with the status probe.

On success the adapter announces it and re-runs the original message that hit
the broken login, so the owner's request is answered rather than orphaned. One
pending re-authentication per route; a second trigger refreshes the code
message instead of stacking. The attempt expires after
`CLI_RUNTIME_TELEGRAM_REAUTH_TIMEOUT_MS` (default fifteen minutes, the owner's
ceiling), with an expiry notice naming how to restart. Polling cadence is
`CLI_RUNTIME_TELEGRAM_REAUTH_POLL_MS` (default ten seconds). Timers are cleared
on adapter stop; a restart forgets the pending attempt, and the owner's next
message simply starts a fresh one.

## Also in this change

The `0022` auth loop consults the deterministic startup table
(`startupScreenAction`) before the navigator, with a same-screen latch, so
screens the runtime already knows (theme, renderer dialogs) cost neither a
model call nor a library entry during authentication.

## What decides success

Tests written first and confirmed failing:

- an auth-required session produces a chat message carrying the URL and code,
  registers the pending attempt, and never mentions attach;
- a code-shaped reply while pending is submitted, and on a confirming probe the
  original message is re-run and answered;
- with nothing sent back (the codex path), the poll alone detects the repaired
  login, announces it, and resumes the original message;
- an expired attempt reports the expiry and clears itself;
- the auth walk resolves a known startup screen deterministically, with zero
  navigator consults.

## Not built, and known

A pending attempt does not survive an adapter restart; the queue record was
already settled and the owner's next message restarts cleanly. Attach hardening
remains the separate deferred slice, now lower-stakes because attach is no
longer the repair path.
