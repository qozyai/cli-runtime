# Workspace State Age Floors

## Status

Implemented on 2026-08-18.

Two absolute age floors under the existing 48-active-hour work-cluster rule. The
cluster rule is unchanged; this only adds ceilings it cannot express.

## Problem

The work-cluster rule retains the newest clusters of a session until their
accumulated durations reach 48 hours, and idle gaps do not consume the budget. It
therefore only ever drops the *older* clusters of a session that is still being
used.

A session that is abandoned — a thread finished, a project switched away from,
a diagnostic run once — stops accumulating active time. Its budget is never
spent, so nothing in it is ever dropped, and every archived input and output file
it ever staged is retained forever.

Measured on one workspace on 2026-08-17: four idle sessions, untouched for 13–14
days, pinning **23.4 MB** that no rule could release. One abandoned thread of 72
turns accounted for 22 MB of it. The turn records for those same sessions were
226 KB. The records are worth keeping and cost nothing; the attached media is
three orders of magnitude larger and is what actually accumulates.

A second observation from the same workspace: the newest cluster is always
retained whole, because the selection loop adds every turn in a cluster before
checking the budget. A session that never idles six hours is therefore never
pruned at all, however long it runs.

## Rules

**Archived media expires at 30 days.** Any submission directory under
`io/inbox`, `io/outbox`, `io/history/inbox`, or `io/history/outbox` older than the
media floor is removed, regardless of whether its turn is still retained and
regardless of pending-delivery protection. After a month nothing is going to
deliver an output that was never acknowledged.

**Any file expires at 90 days.** Any regular file anywhere under `.qozyai` whose
mtime is older than the outer floor is removed, then any submission directory the
sweep left empty is removed. This is what finally releases an abandoned session:
its history JSONL ages out with everything else.

Both floors are configurable — `workspaceMediaMaxAgeMs`, `workspaceFileMaxAgeMs` —
so tests do not have to fabricate timestamps months in the past.

## Deliberate consequences

- **A turn record can outlive its files.** `inputs[].archivePath` and
  `outputs[].archivePath` may point at bytes that no longer exist between 30 and 90
  days. The record keeps name, mime type, size, and transcript text, so the
  conversation stays complete and searchable; only the bytes go. Readers must treat
  an archive path as a hint, not a guarantee.
- **Age beats pending delivery.** The existing protection that retains an
  archived-but-undelivered output is overridden by the 30-day floor.
- **The 90-day floor deletes history records.** That is the point. It is the only
  rule that can release a session nobody will ever speak to again.
- **Symbolic links are never followed** by the sweep, so it cannot delete anything
  outside the workspace state tree.
- **Structural directories are never removed**, only submission directories left
  empty. `ensure()` would recreate them, but removing them here would race a turn
  in flight.

## Age source

A submission directory's age comes from the timestamp inside its own name
(`sub_YYYYMMDDTHHMMSSmmmZ_hash`), which survives the directory being touched for
any unrelated reason. mtime is the fallback for anything not named that way. The
outer file sweep uses mtime, because an appended file is legitimately recent.

## Tests

- [x] Archived media expires on age while its turn is still retained, and the turn
      record survives.
- [x] The outer floor removes an aged file, keeps a recent one, and leaves the
      directory structure intact.
- [x] Existing 48-active-hour retention and pending-output protection continue to
      pass unchanged.
