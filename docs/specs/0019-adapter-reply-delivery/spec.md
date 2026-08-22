# 0019: The adapter must not lose a reply it already asked for

## Status

Specced, tests written to fail first, then built, 2026-08-22.

**Guarantees touched:** 1 and 5. Both were kept faithfully by the core and broken
at the last hop, in `src/surface/telegram.js`. This is a change in `src/`, so it is
a core change by the rule in `AGENTS.md`, with the tests this spec names.

## The three defects

A whole-repository review on 2026-08-22 found two high findings, both reply-loss
paths in the Telegram adapter, plus the honest-refusal gap they share.

**1. One unguarded call abandons an accepted turn.** Between submission acceptance
and reply collection there was exactly one Telegram call with no error handling:
the `sendStatus` that posts the Working bubble. A Telegram 429 or 5xx there threw
past the turn; nothing ever polled the submission again. The retry re-ran the
update, found the session busy, reported "needs attention: running", and started
an authentication terminal for a session that was fine. If that message sent, the
queue file settled and the reply was unrecoverable. The same sequence fired with
no Telegram error at all when the adapter process died mid-turn and its restart
replayed the queue into the still-busy session.

**2. Rate limits were treated as fatal.** `api()` threw on any non-ok result
without reading `parameters.retry_after`, and `send()` fired reply chunks in a
tight loop. A long reply therefore invited a 429 partway through, and the whole
retry budget burned out inside the wait Telegram had asked for. The longest
replies, which are the most valuable ones, were the most likely to strand.

**3. A busy session produced a false diagnosis.** Any submission attempt against
a busy session was answered with the attention flow, which is a statement about a
broken session, not a busy one.

## The fix

**Rejoin instead of misdiagnose.** The daemon already checks the idempotency key
before the busy refusal (`admitSubmission`), so replaying the update that started
the running turn returns that same submission. The adapter now lets a busy session
(`preparing`, `submitting`, `running`, `interrupting`) through to the POST and
lets the daemon adjudicate: its own turn is rejoined and its reply collected; a
genuinely different message gets `SESSION_BUSY`, which the adapter reports as what
it is, with no attention message and no auth terminal.

**A failed bubble degrades to no bubble.** `sendStatus` failure leaves the turn
polling with no status message id. Every downstream consumer already tolerates a
missing id: edits no-op and finalization falls back to a fresh message.

**Obey `retry_after`.** On a result carrying `parameters.retry_after`, `api()`
waits that long (capped, a few attempts) and retries. Reply chunks are paced with
a short delay so long replies stop provoking the limit in the first place.

## What decides success

Tests in `test/telegram.test.js`, each failing on the code as it was:

- a replayed update whose session is busy rejoins its own submission and delivers
  the reply, with no attention message and no `/v1/auth/*/start`;
- a `sendStatus` failure still delivers the completed reply;
- a genuine `SESSION_BUSY` conflict is reported as busy, with no auth terminal;
- a 429 carrying `retry_after` is retried and succeeds.

## Not built, and known

A message that hits a genuine busy conflict is still reported and dropped rather
than queued behind the running turn; the report now says the truth and asks for a
resend. Queueing it is a scheduling decision this spec deliberately does not take.
