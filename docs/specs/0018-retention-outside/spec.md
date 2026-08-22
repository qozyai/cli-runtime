# 0018 — Age-based deletion leaves the core

**Status:** specced, test written to fail first, then built. §7 records what shipped.

**Guarantee touched:** none of the eight. It is a core change by the rule in `AGENTS.md`
because the diff is in `src/` and it changes what the runtime does on disk. The diff is
almost entirely deletions.

**Supersedes** `0017` §3–§4 (the env policy block and the maintenance tick) and closes
`0012`. **Retains** `0017`'s record-keep floor and grace window, which fix a different
bug.

## 1. The rule

> **The runtime deletes by meaning. A janitor deletes by age.**

The runtime knows which records are still referenced, which turn is live, and which
history belongs to the last window of work. Nothing outside can know that, which is why
three attempts to move retention out failed. It does *not* know, and has no reason to
care, how long a `.ogg` should be kept. That is a preference, and it has no business
being compiled into the thing that carries messages to a model.

So the split is not by directory and not by cardinality. It is by whether the decision
needs a record.

## 2. What leaves

| Removed | Was |
|---|---|
| `WORKSPACE_FILE_MAX_AGE_MS`, `sweepAgedFiles()` | delete any file under `history/` or `io/` older than 90 days |
| `MEDIA_MAX_AGE_MS` and the `aged` disjunct in the archive loop | delete an archived directory whose newest file is older than 30 days |
| `workspaceMediaMaxAgeMs`, `workspaceFileMaxAgeMs`, `maintenanceIntervalMs` | `0017` config |
| `runMaintenance()`, `startMaintenance()`, `stopMaintenance()`, `maintenanceWorkspaces()` | `0017`'s periodic tick |
| `workspace.aged_state_removed` | the event those emitted |

Removing the tick also removes three findings rather than fixing them: the live-workspace
snapshot race, the shutdown hang on a stalled event append, and the traversal-root
symlink hazard — the last because there is no longer a traversal to protect.

## 3. What stays, and why it could never leave

| Kept | Why it needs a record |
|---|---|
| work-cluster history retention (`selectRecentTurns`, 48h) | rewrites records *inside* a live `.jsonl`; an mtime says nothing about which turns to keep, and an idle file would be deleted whole |
| I/O ledger compaction and quarantine | correlates `events.jsonl` entries against retained submission ids |
| archive deletion by `retainedIds` | an output archived but not yet delivered must survive regardless of age |
| the two 7-day rules | turn *liveness*, not retention: when is an unfinished turn presumed abandoned |
| `pruneOperationalState()` | a terminal record is the reply-collection surface. `admitSubmission()` resolves an idempotency key *through* it and creates a **second turn** when it is missing, so deleting by age causes duplicate execution, not a 404. Stays count-based, with `0017`'s floor and grace |

## 4. Why a plugin is allowed to do this, when three attempts were not

`plugins/AGENTS.md` forbids a state capability because *a plugin that reads runtime
records makes their shapes a public contract*. `retention-sweep` reads no records. It
reads a marker format it owns and file mtimes.

The test that settles it: **if every record format in this runtime changed tomorrow,
would the plugin need an edit?** No. It is not coupled; it is merely pointed.

And the failure mode inverts. `archive-sweep` deleted wherever it was aimed, so a wrong
root was destructive. `retention-sweep` deletes only where it finds a marker, so a wrong
root does nothing at all.

**And a marker names the directory it governs.** Without that, the file works wherever it
lands — and trees get copied, restored to a different path, cloned to a scratch directory.
The declared path is compared against where the file actually sits (`realpath` on both
sides, so a symlinked route still matches), which makes a travelling marker inert and
leaves the original working. The mismatch is a reported failure, not a silent skip: a tree
that stopped being swept because it moved should be visible in `runner.mjs status` rather
than discovered when the disk fills. The cost is that moving a project means editing its
markers, which is the deliberateness being bought.

## 5. The interim, stated rather than discovered

**Correction, made the same night.** This section first said the plugin runner had no
service unit and that four jobs were waiting on one. That was wrong: `qozyai-plugins.service`
is installed, enabled and has been resident for sixteen hours, and `queue-janitor` has been
running every minute throughout. The claim came from `plugins/AGENTS.md`, which still said
"there is no service unit yet" — true when written, stale by the time it was quoted here.

So the gap is shorter than stated but real: between this change landing and
`retention-sweep` being enabled **with a marker written**, nothing expires media at all,
and `.qozyai/io/history/` only grows. That is accepted deliberately — the alternative is
keeping the floors in `src/` beside a plugin that also has them, which is the exact
arrangement that produced `0015`'s silent divergence.

The runner already lists `retention-sweep` as `disabled`. Enabling it is a deployment
decision, and it is not this spec's to take.

**Taken, 2026-08-20.** The gap above is closed and this paragraph is history rather than
a warning. `.qozyai/io/history/retention.json` carries the media rules from
`retention.json.example` — 30 days, `base: "newest"` — and the manifest is `enabled`,
reloaded into the resident runner by `SIGHUP`. Nothing became eligible: 207 media files,
217 MB, and the oldest is 17 days old, so the first deletion cannot happen before
2026-09-03 — the day *after* the oldest crosses 30 days, because of eligible-twice.

No marker is created by this change. A tree with no marker is a tree nothing deletes
from, so opting in is a deliberate act and the default is to keep everything.

## 6. Tests that must fail first

1. An aged file under `io/history/outbox/<id>/` **survives** a `prune()` — the runtime no
   longer deletes by age.
2. An archived directory whose newest file is a year old survives, while one whose
   submission is no longer retained is still removed. Retention still deletes; age does
   not.
3. `loadConfig()` no longer carries the three removed settings, and still carries the
   record keep floor and grace.
4. A `SessionManager` has no maintenance timer to start.

## 7. What shipped

- `src/core/workspace-state.js`, `src/core/session-manager.js`, `src/config.js`,
  `src/main.js`, `install.sh` — the removals in §2.
- `test/workspace-state.test.js`, `test/retention.test.js`, `test/install.test.js`.
- `plugins/retention-sweep/` — the janitor. `plugins/archive-sweep/` deleted: it was the
  90-day floor as a plugin, and this replaces it.

Deployed the same day: `release_20260820T144321Z_139d4e7`, daemon and adapter both,
live at 2026-08-20T14:45Z, three minutes after the commit. The coexistence this
paragraph originally described (the diff not deployed, the old floors still resident
in the live release) lasted those three minutes; the text saying so outlived it by
two days and was corrected 2026-08-22.
