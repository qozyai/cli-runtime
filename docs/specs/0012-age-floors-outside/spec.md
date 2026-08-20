# 0012 — Move the archive age floors outside the core

**Status:** **withdrawn, 2026-08-19.** Nothing was ever removed from `src/`, and now
nothing will be. `0017` §2 settles it the other way: only the runtime deletes.
`archive-sweep` was built, and what it proved was the argument against itself — `0015`
changed the runtime's sweep, the plugin was not updated, and its equivalence suite went
red within a day while carrying a rule that would have deleted memory. It stays
disabled as a tripwire.

The finding in §2 survives the withdrawal and is worth keeping: the file floor is
separable and the media floor is not. It is why "move half of it" was never the cheap
option it looked like.

**Guarantee touched:** none of the eight. This removes behaviour from `src/` rather
than changing what a turn does. It is a core change by the rule in `AGENTS.md`
regardless — the diff is in `src/` and it changes the shape of what the runtime does
on disk — so it gets a spec, then a failing-first test, then code.

**Supersedes the debt recorded in** `docs/refactor.md` §9 and spec
`0008-workspace-state-age-floors`, which added these rules inside `src/` because they
were small and no seam existed. One exists now: `/code/qozyai/plugins`.

## 1. What the runtime does today

Two age floors, both added by spec 0008, both in `src/core/workspace-state.js`:

| floor | constant | what it deletes |
|---|---|---|
| file | `WORKSPACE_FILE_MAX_AGE_MS`, 90 days | any regular file under `.qozyai/` whose mtime is older, then any archive directory left empty |
| media | `MEDIA_MAX_AGE_MS`, 30 days | an archived inbox/outbox directory whose *newest* file is older |

Neither is referenced anywhere else in `src/` or `test/`, so the blast radius is one
file.

## 2. Only one of them is movable, and the other is blocked by the same thing retention is

`refactor.md` §6 lists "Archive age floors" as a single Tier 2 row, described as
"pure file-age rules, no runtime state at all". That is true of the file floor. It is
**not** true of the media floor, and this spec exists partly to say so.

**The file floor is separable.** `sweepAgedFiles(paths, nowMs)` walks the tree, deletes
regular files past the age, skips symlinks, and tidies emptied archive directories. It
reads no session state, consults no history record, and takes no decision that depends
on a turn.

**The media floor is not.** It is evaluated inside `prune()`'s archive loop, as one
expression over one directory listing:

```js
const aged = archived && await newestFileAgeMs(entryPath, nowMs) > this.mediaMaxAgeMs;
if (!retainedIds.has(dir.name) || aged) { …remove… }
```

`retainedIds` comes from the history records. The retention decision and the age
decision are the same `if`, over the same entries, under the workspace lock.
Extracting the age half means either walking the archive a second time from another
process — racing the first walk over directories it is deleting — or both honouring a
**shared on-disk lock**. That lock is precisely the precondition §6 already places on
moving workspace retention, and it has not been built.

So the media floor moves *with* retention, not before it. §6's Tier 2 table should
carry two rows, not one.

## 3. What this spec proposes

**Move the file floor only.** A `periodic` plugin, `archive-sweep`, that deletes
regular files under a workspace's `.qozyai/` past a configured age and removes archive
directories it empties. It needs no capability at all — not `socket`, not `notices` —
because it operates on the workspace, not on runtime state. It reports what it removed
through its run record.

**Leave the media floor where it is,** with a comment naming this spec and the shared
lock as its precondition, so the next reader does not rediscover §2 the hard way.

## 4. Order, and why the removal is last

1. Build `archive-sweep` with tests that run the plugin and the runtime's own
   `sweepAgedFiles` over identical fixture trees and assert the same set of files
   survives. Equivalence is the claim; a test is the only way it is one.
2. Install it, enabled, and let it run.
3. Only then remove `sweepAgedFiles` and `WORKSPACE_FILE_MAX_AGE_MS` from `src/`,
   with a failing-first test asserting the runtime no longer deletes aged files.

Removing the runtime's copy before the plugin is enabled would leave nothing sweeping.
The files are age-based so a gap of days is harmless, but "harmless" is not a reason to
sequence it carelessly.

## 5. What was built, and what will not be

This section said "all of it" is unwritten. That was true when it was written and is
not now, and the difference is the point.

**Built:** `plugins/archive-sweep` — the plugin and its equivalence test against
`WorkspaceState.prototype.sweepAgedFiles`, over a shared fixture. Shipped disabled.

**Never built, and now withdrawn:** the removal from `src/`. `0015` changed the
runtime's sweep, `archive-sweep` was not updated, and the equivalence suite went red
within a day — carrying a rule that would by then have deleted the memory store. Had
the removal happened first, the runtime would have had no sweep and the plugin would
have had the wrong one.

`archive-sweep` was then deleted outright by `0018`, which removed the floors from the
runtime as well. What replaced both is `plugins/retention-sweep`: a marker-driven janitor
with **no** counterpart in `src/`, so there is nothing left to stay in sync.

The through-line across `0012`, `0017` and `0018` is worth stating once. The mistake was
never "outside" or "inside". It was building a *second* implementation of a rule and
expecting two copies to stay identical.
