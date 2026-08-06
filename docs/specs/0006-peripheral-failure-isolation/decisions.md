# Decisions — Peripheral Failure Isolation

Rationale for `spec.md`. Historical; the spec is authoritative.

## Why a mechanism instead of a rule

The invariant was already the codebase's intent — the workspace, navigator,
transcription, and admission paths all degrade correctly. It still broke in five
places, and two of them were written the same day the rule was being discussed.
`await eventStore.append(...)` reads as ordinary care; nothing objects at review
time, and no test notices. A named `note()` that cannot throw makes the correct
form the shorter one, and the fault-injection tests make a regression fail loudly
rather than wait for a full disk to find it.

## Publish synchronously, persist asynchronously

Making `append` fire-and-forget alone would have broken read-your-writes: a
client that creates a session and immediately polls `/v1/events` could miss the
event, and one existing test caught exactly that. Since readers already serve
from the in-memory ring, the fix is to sequence, record, and emit synchronously
and to queue only the disk write. Visibility is unchanged, durability keeps its
ordering, and the failure is no longer on the caller's path.

The cost is that compaction can now run while an append is still queued. Rather
than serialize them again, compaction rewrites only records at or below
`durableSequence`; anything still queued is appended afterwards by its own write.
Without that, a compaction would write a pending record and its queued append
would write it a second time.

## `unhandledRejection` but not `uncaughtException`

A rejection that nobody handled is usually a peripheral promise nobody awaited —
precisely the class this spec isolates — and killing every live session over one
is a worse outcome than continuing with a logged report. An uncaught exception is
different: it unwound a stack mid-operation and left state unknown. Overriding
that default would keep a possibly corrupted process serving turns, so it stays
fatal.

## The last net settles memory first

`failUnexpectedExecution` used to persist and then update in-memory state. If
persistence threw, the session kept a stale `activeSubmissionId` and the runtime
believed a finished turn was still running. Settling memory first means the
runtime's own view is correct even when nothing can be written, and the writes
are attempted afterwards with their failures reported.

## Quoted attachments warn instead of refusing

This reverses a deliberate earlier choice, which was that a turn should never run
on partial context. That reasoning holds for the message's own attachments and
they are unchanged. For a *quote*, refusing means an enrichment of someone else's
earlier message discarded a complete message of the user's own — the invariant's
central case. The driver is told what is missing, so it can ask rather than guess,
and the user sees why.

## No retries

A retry queue for peripheral work is a feature with its own failure modes:
ordering, duplication, unbounded growth, and a second place where a stuck write
can accumulate. Degrade-and-report is the whole contract here; anything that
needs delivery guarantees should be core, and core is allowed to fail a turn.
