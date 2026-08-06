# Burst Joining

## Status

Implemented on 2026-08-06.

Messages that arrive together become one turn. A long paste that a Telegram
client splits into several messages currently starts a separate turn per part,
so the agent answers fragments of a thought in sequence instead of the thought.

This specification covers only messages that arrive **before** a turn starts.
Messages arriving **while** a turn runs keep today's behavior — they serialize
per route — and are the subject of a later specification.

## Design

Every ordinary message enters a per-route buffer instead of dispatching
immediately. The buffer holds for a short debounce window, and each new arrival
resets that window. When the window expires the buffered parts are combined into
one prompt and dispatched as a single operation.

The first message is debounced too. That is the point: a split paste has no
"first message" worth answering on its own, and 200 ms is imperceptible against
a turn that takes seconds. Nothing is started and then discarded — the runtime
never sees the parts separately, so there is no partial turn to interrupt, no
provider context to unwind, and no answer to throw away.

| Setting | Default | Meaning |
| --- | --- | --- |
| `CLI_RUNTIME_TELEGRAM_BURST_DEBOUNCE_MS` | `200` | Quiet time before a buffered burst dispatches. Each arrival resets it. |
| `CLI_RUNTIME_TELEGRAM_BURST_MAX_WAIT_MS` | `2000` | Total time a burst may hold before it dispatches regardless of arrivals. |
| `CLI_RUNTIME_TELEGRAM_BURST_MAX_PARTS` | `25` | Parts after which a burst dispatches immediately. |

Setting the debounce to `0` disables joining: every message dispatches on its own.

### Combining

Parts combine in arrival order. Each part contributes the text it would have
contributed alone — including its own `<telegram-reply-context>` block when that
part was a reply — and the pieces are joined with a newline. A burst of plain
text therefore reconstitutes as the paste it came from, and a burst mixing a
reply with a follow-up thought keeps both meanings rather than dropping one.

Attachments from every part are downloaded and submitted together, in part
order. Voice transcripts and their warnings are still reported individually.

The combined submission uses the first part's identity: its chat and topic for
replies, its ordinal for barrier ordering, and its message ID for the runtime's
idempotency key.

### Commands

A command is never absorbed into a burst.

- `/stop` **discards** a pending burst. The user asking to stop cannot have meant
  "and then run what I was typing"; the reply says how many parts were dropped.
- Every other command **flushes** the pending burst first, so the burst reaches
  the route chain ahead of the command and arrival order is preserved.

### Durability

Buffering happens after an update is persisted and before it is dispatched, so
the existing guarantee is unchanged: an accepted update is on disk before
Telegram's offset advances. A burst interrupted by a restart replays from the
queue and re-forms on the next start.

Every part's queue record is removed only when the combined operation succeeds.
A failure that cannot be reported to the user re-dispatches every part, which
re-buffers and re-combines them.

## Non-Goals

- Messages that arrive while a turn is running. They still queue per route; how
  to steer, replace, or interrupt a running turn is a separate design.
- Joining across routes. A burst is per chat and topic.
- Reordering. Parts combine strictly in arrival order.
- Semantic merging. Parts are concatenated, not summarized or deduplicated.

## Requirements And Release Gate

Each line is one assertion.

**Joining**

- two messages arriving inside the debounce window produce exactly one submission
  containing both texts in arrival order
- a message arriving after the window produces a second, separate submission
- each arrival resets the window, so parts spaced closer than the debounce join
  however many there are
- a burst reaching the maximum wait dispatches even while parts keep arriving
- a burst reaching the maximum part count dispatches immediately
- a debounce of `0` dispatches every message separately
- bursts in different routes are independent and do not join

**Content**

- attachments from every part are submitted together, in part order
- a part that was a reply keeps its own reply-context block in the combined prompt
- the combined submission carries the first part's chat, topic, and idempotency key

**Commands**

- a command arriving during a burst dispatches the burst first, then the command
- `/stop` during a burst discards it and says how many parts were dropped
- an immediate command still bypasses the route chain

**Durability**

- every part's queue record is removed after the combined operation succeeds
- parts persisted but not yet dispatched replay after a restart and re-form
- a failure that cannot be reported re-dispatches every part

**Regression**

- a single message with no burst behaves exactly as before, one submission per
  message, with the debounce as its only added latency
- route serialization, barriers, and ordinals are unchanged

## Implementation Surface

- `src/config.js` — the three settings
- `src/telegram.js` — per-route burst buffer, flush and discard, `dispatch`
  routing ordinary messages through the buffer, `handleOrdinary` accepting parts
- `test/burst-joining.test.js`
- `README.md`, `docs/guides/telegram-projects.md`
