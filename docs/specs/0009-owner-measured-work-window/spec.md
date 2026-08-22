# Owner-Measured Work Window

## Status

Implemented on 2026-08-18.

## Problem

The 48-active-hour retention window models a person working: a stretch of turns,
then a break of at least six hours, then another stretch. It counts every turn that
has valid timestamps, whatever caused it.

A scheduled wake is not a person working. Counting it corrupts the measurement in
two ways, and the second is much worse than the first.

**It spends budget nothing asked for.** Measured on this workspace on 2026-08-18,
before the change: failed and interrupted turns alone accounted for 4.2 of 37 hours
on one session (11%) and 6.9 of 23.6 hours on another (29%). Real conversation was
being evicted that much sooner.

**It fuses clusters.** A cluster ends only at a six-hour break, so any schedule
firing more often than that stops a break from ever forming. The session becomes one
endless cluster — and because the newest cluster is always retained whole, the
selection loop adds it, spends the entire budget on the first step, and drops
everything older.

This was observed live, not hypothesised. A `0 */2 * * *` wake on one session had
fused it into a single cluster of 59.8 hours running since 2026-08-15, which the
rule could no longer trim at all. Recomputed counting only owner turns, the same
session is 44.4 hours in two clusters: the break reappears and the budget falls back
under the ceiling. The five sessions on the same box with no schedule were identical
before and after, to the decimal.

The failure mode this protects against is not theoretical either. An agent on
another host once ran the same failing job 16,541 times over 68 days. Transplanted here, that pattern
would not merely waste CPU — it would spend the whole retention budget on the storm
and delete every conversation that came before it.

## Rule

Work clusters are built from **owner-authored turns only**. Everything from the
oldest retained cluster onward is retained regardless of who authored it.

- A scheduled turn no longer spends budget and no longer bridges a break.
- A scheduled turn is still history and is still retained. It simply stops deciding
  where the boundary falls. Retaining only what falls inside an owner cluster would
  delete the record of every overnight job, which is the opposite of the intent.
- A session with **no** owner turns — an autonomous agent that is only ever woken —
  falls back to measuring all of its turns. Measuring it against nothing would
  retain nothing.

## Provenance

The runtime cannot infer this. A wake and a Telegram message arrive as the same
`POST /v1/sessions/<key>/submissions`. So the caller declares it:

```json
{ "message": "...", "source": "owner" | "scheduler" }
```

- Absent or unrecognized is normalized to `owner`. Every existing caller, and every
  turn already on disk, therefore keeps meaning exactly what it did.
- The Telegram adapter sends `owner` explicitly rather than relying on the default.
- The `wake` skill sends `scheduler`.
- The value is persisted on the submission record and on the finalized turn record.

One field, two consumers: a memory consolidation pass needs the same discriminator
to skip machine-authored turns when building a batch, and would otherwise have to
match on the `<system-intervention>` wrapper — a string owned by a skill, forgeable
by anyone who types it, and living inside the user text a consolidator reads.

## Deliberate consequences

- **Existing history is unchanged.** Records written before the field existed carry
  no `source`, count as owner, and retain exactly as they did. The correction
  applies to turns written from now on; a session already fused into one cluster
  un-fuses as labelled turns replace unlabelled ones.
- **A chained wake is still a scheduled turn** even when it continues work the owner
  asked for. The window measures when a person was present, not who benefits.
- **`source` is asserted, not authenticated.** Any client on the runtime socket can
  claim `owner`. That is the same trust level as every other field on the endpoint.

## Driver neutrality

Nothing here is provider-specific. Provenance is established by the caller, above
the driver layer; retention operates on timestamps and this field. A session's turn
records commonly mix drivers — the session key contains no driver, so `/driver`
leaves both drivers appending to one history file — and the window is computed the
same way over that mixed sequence.

## Tests

- [x] A scheduled storm spanning three days does not evict the conversation before
      it, and the storm's own turns are still retained.
- [x] A session with only scheduled turns falls back to measuring them.
- [x] A turn with no `source` counts as owner, so pre-existing records are stable.
- [x] The finalized record carries `source` for both an owner turn and a woken one.
