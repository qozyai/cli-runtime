# 0017 — Retention is policy, and it runs on a clock

**Status:** **superseded in part by `0018`, the same day.** The env policy block (§3),
the maintenance tick (§4) and the traversal-root hardening (§7) were built and then
removed: `0018` takes age-based deletion out of the runtime entirely, so there is no
policy to configure, no tree to walk and no clock to run.

**What survives from this spec** is the part that was never about age: the record-keep
floor and the grace window in §3, which exist because a terminal submission record is
the surface a caller polls to collect its reply. Those are still in `src/` and still
carried by the installer.

**Guarantee touched:** **7** — peripheral failures never fail a turn. This adds a
periodic job inside the daemon, and the whole of its failure handling is "log it, keep
the interval alive". Guarantee 8 is deliberately *not* touched: the tick is internal,
so it adds no ingress. That is one of the reasons it is a tick and not a socket
command.

**Settles** `0012` and `0013`, both of which proposed moving cleanup out of `src/`.
Neither move happens. §2 says why, and it is not the reason either spec expected.

## 1. Two problems, one of them invisible

**Retention is hardcoded.** `WorkspaceState` already reads `workspaceMediaMaxAgeMs`
and `workspaceFileMaxAgeMs` from config (`workspace-state.js:212-213`) — and nothing
in `config.js` ever sets them. Only the tests pass them. So in production the 30-day
and 90-day floors are constants wearing a config-shaped hat, and the newest-1,000
record keep is a literal `slice(1000)`.

**A workspace with no turns is never pruned.** `schedulePrune()` is called from
exactly two places, both on turn-completion paths. No turn, no prune. So the project
you stop using is the one that keeps every voice note forever, while the project you
use daily is pruned hundreds of times. That is backwards, and nothing reports it: the
symptom is disk, and disk is nobody's alert.

## 2. Why this is not a plugin

`0012` and `0013` both proposed moving cleanup outside, and `AGENTS.md` still lists
age-based cleanup in `src/` under "Wrong, and known". The attempt was made and the
evidence came back against it.

**What actually happened.** `0015` changed the runtime's `sweepAgedFiles()` to walk
`history/` and `io/` instead of the whole `.qozyai/` root, so the floor could not
delete memory. The outside twin — `plugins/archive-sweep`, which had been written to
be provably identical — was not updated. Its equivalence suite went red within a day,
and had it been enabled it would have deleted memory at ninety days. Nothing was lost,
because it shipped disabled. (The runner does have a service unit and is resident — a
claim to the contrary elsewhere in these specs was stale; see `0018` §5.) The lesson
is not that somebody forgot to run a suite. It is that **a second implementation of a
deletion rule is a liability that has to be actively maintained in exchange for
nothing**, and the exchange is worse when one copy is dormant.

**What a plugin would have to own to be worth it.** Not the trigger — a trigger buys
only the clock, and a clock is a `setInterval`. Owning *policy* would be worth it, and
policy turns out not to need a plugin either: the seam is already in the constructor,
it just has no wire to the environment. That wire is §3.

So no plugin prunes anything. `queue-janitor` stays, judged by a different argument
entirely — it is a containment patch for an adapter bug, not a retention policy.
`archive-sweep` stays disabled and becomes the tripwire that caught this, which is the
one job a redundant implementation is actually good at.

## 3. Policy becomes configuration

| Env | Config key | Default | Governs |
|---|---|---|---|
| `CLI_RUNTIME_WORKSPACE_MEDIA_MAX_AGE_MS` | `workspaceMediaMaxAgeMs` | 30 days | archived inbox/outbox directories, by newest file |
| `CLI_RUNTIME_WORKSPACE_FILE_MAX_AGE_MS` | `workspaceFileMaxAgeMs` | 90 days | any file left under `history/` or `io/` |
| `CLI_RUNTIME_OPERATIONAL_RECORD_KEEP` | `operationalRecordKeep` | 1000, floor 100 | terminal submission records and their prompt files |
| `CLI_RUNTIME_OPERATIONAL_RECORD_GRACE_MS` | `operationalRecordGraceMs` | 10 minutes | how long a terminal record is immune regardless of count |
| `CLI_RUNTIME_MAINTENANCE_INTERVAL_MS` | `maintenanceIntervalMs` | 6 hours, or `0` to disable | how often §4 runs |

**Out of range falls back to the default rather than clamping.** An operator who writes
a number the runtime will not honour should get the documented behaviour, not a
silently different one that still looks configured.

**Why the record keep has a floor, and a grace window as well.** A terminal submission
record is not bookkeeping — it is how a caller collects its reply. Both `send --wait`
(`main.js`) and the Telegram adapter poll `GET /v1/submissions/:id` until it reports a
terminal status. `pruneOperationalState()` is scheduled on `setImmediate` the moment a
turn finalizes, so at a small keep count the record can be deleted between finishing
and the next poll: a completed turn becomes a 404, output acknowledgement cannot re-read
the record, and a retained idempotency key no longer returns the prior result. An
earlier draft of this spec called `0` a legitimate answer. It is not, and the floor
alone is not enough either — with enough concurrent completions the newest records are
themselves the ones over the line — so no record is deleted until it has had the grace
window to be collected.

**Why the interval has an upper bound.** `setInterval` and `setTimeout` truncate their
delay to a signed 32-bit integer. A plausible "every 30 days" is 2.59e9 ms, past
2,147,483,647, and becomes an effective delay of 1 ms — a storm of full-tree walks
rather than a rare tick. Values outside `[60_000, 2_147_483_647]` fall back; `0` is
disabled and is not "out of range".

**What stays hardcoded, and why.** The 48-hour work-cluster rule is an algorithm, not a
number — exposing "48" without exposing the clustering would be a knob that does not
mean what it says. The two 7-day rules are about turn liveness, not retention: they
decide when an unfinished turn is presumed abandoned, and a deployment that tuned them
for disk would be changing what counts as a live turn. Both are refusals, not omissions.

**The installer carries all five.** `install.sh` rebuilds `runtime.env` from scratch on
every run and previously carried only the driver pins. A settings group that decides
what gets deleted, silently reset by an upgrade and then acted on, is the same class of
bug as a silently un-pinned driver — and worse, because it is destructive.

## 4. The maintenance tick

Inside the daemon, one chained timeout, default six hours:

1. Collect the distinct workspaces of every session the `SessionManager` knows,
   **excluding any with a turn in flight** — those are left to the prune that turn will
   schedule for itself. The workspace lock makes concurrent pruning safe against
   corruption, but not against a file floor configured shorter than the turn: the sweep
   expires files by age and does not consult retention, and staged inputs are files
   like any other.
2. `prune()` each one — through the existing path, so it takes `withWorkspaceLock()`
   and nothing new has to be invented to be safe beside a live turn.
3. `pruneOperationalState()` once.
4. Record the counts and any failures with `note()` — the non-awaited path this class
   already uses, so a hung event store cannot strand a run.

**Chained timeout, not `setInterval`.** The next delay is measured from the end of a
run rather than its start, so two can never be in flight. `runMaintenance()` is
additionally single-flight and deliberately not `async`: an async function wraps its
return value in a fresh promise, so two callers would get two objects for one run and
the guarantee would hold only by accident of timing.

**The first tick is at `min(interval, 5 minutes)`.** Not at boot, so a crash-looping
daemon does not walk every workspace on every start; not a full interval either, or a
daemon restarted more often than six hours never maintains anything — which is the gap
this exists to close.

Failures are per workspace: one bad workspace does not cost the others their prune, and
collecting the workspace list failing does not cost the operational prune its run. The
timer is `unref()`ed so it never holds the process open, and `stopMaintenance()` returns
whatever run is in flight so shutdown waits rather than exiting mid-delete.

## 5. What this does not do

It does not change any retention *semantics* except the grace window in §3, which only
ever retains more. Every rule keeps its meaning and its default; four of them can now be
set without editing code. If the owner wants the global record cap changed from a count
to an age, that is a policy decision with its own spec — and worth noting alongside it:
a count that is global across projects means a busy project evicts the operational
records of a quiet one.

## 6. Tests

Written to fail first:

1. `loadConfig()` reads each env var; unset leaves today's defaults.
2. A keep count below the floor — `0`, `50`, `-1`, `2.5` — falls back rather than being
   honoured; `100` is honoured.
3. An interval Node cannot represent (30 days) or that is too small (1 ms) falls back;
   `0` is disabled.
4. A record inside the grace window is never pruned however far down the list it is,
   and with the grace at zero the count decides.
5. **The gap:** a workspace with aged files and no turn since is pruned by the tick, and
   its `.qozyai/memory` is not.
6. A workspace with a turn in flight is skipped and reported, not silently dropped.
7. A workspace whose prune throws does not stop the operational prune.
8. A slow tick never has a second launched on top of it; a later call starts a fresh
   run; `0` never arms a clock; stopping waits for the run in flight.
9. **The floor does not follow a symlink that has replaced a swept root** — see §7.
10. The installer preserves all five settings across a rerun, including `interval=0`.

## 7. The regression this spec introduced, and fixed

Narrowing the sweep in `0015` from `walk(paths.root)` to `walk(paths.history)` and
`walk(paths.io)` turned two directories that had been *entries* into traversal **roots**.
The walker skips symlinks it meets as children, and `prune()` lstat-checks `.qozyai`
itself — so while traversal started at `.qozyai`, a symlinked `history` or `io` was
observed as an entry and skipped. As roots they were checked by nothing, and `readdir`
follows a symlinked directory: the floor could delete aged files anywhere on the disk.
The periodic tick made it reachable on a quiet workspace with no new turn to revalidate
the tree, and `archive-sweep` had faithfully copied the same flaw.

Every traversal root is now `lstat`-ed, in both implementations, and both suites carry a
fixture where the root itself — not merely a child — is a symlink.

## 8. What shipped

- `src/config.js` — the five values in §3, `boundedInteger`, the floor and the
  32-bit timer bound.
- `src/core/session-manager.js` — `operationalRecordKeep` and the grace window replace
  the literal `slice(1000)`; `maintenanceWorkspaces()`, `runMaintenance()`,
  `runMaintenanceOnce()`, `startMaintenance()`, `stopMaintenance()`.
- `src/core/workspace-state.js` — traversal roots validated (§7).
- `src/main.js` — the tick starts with the daemon and shutdown awaits it.
- `install.sh` — the five settings carried through an upgrade.
- `test/retention.test.js`, additions to `test/workspace-state.test.js` and
  `test/install.test.js`.
- `plugins/archive-sweep` — the same root validation and fixture, since it is kept as
  the equivalence tripwire.
