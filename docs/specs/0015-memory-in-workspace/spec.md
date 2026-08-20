# 0015 — The outer floor sweeps only what the runtime owns

**Status:** specced, test written to fail first, then built. See §5 for what shipped.

**Guarantee touched:** none of the eight. It changes what the runtime deletes on disk,
so it is a core change by the rule in `AGENTS.md` regardless: the diff is in `src/`.

**Implements the first decision of** `0014` §7 — memory moves into `<workspace>/.qozyai/`.
That move is unsafe until this lands, and §1 is the reason.

## 1. The move would have deleted the memory it was moving

`0014` decided that consolidated memory is per-project state and belongs beside the
project. The obvious implementation — point the memory store at
`<workspace>/.qozyai/memory` — walks straight into the outer age floor.

`sweepAgedFiles()` walks from `paths.root`, which is `.qozyai/` itself, and deletes
**every regular file** whose mtime is older than ninety days:

```js
await walk(paths.root);
```

Memory's daily sources are written once, on the day they describe, and then never
touched again. That is the definition of the files this sweep removes. Ninety days
after a memory move, `daily/2026-08-19/user.md` would be deleted — and a daily record
nobody has rewritten in three months is exactly the one worth keeping, not the one to
expire. `recent.md` would survive by being rebuilt, so the failure would present as
memory that silently stops going back more than a quarter, with no error anywhere.

The other deletion paths in `prune()` are safe: they enumerate named directories
(`history`, `active`, `inbox`, `outbox`, and the two archive roots) rather than
recursing. The whole hazard is the one `walk(paths.root)`.

## 2. The narrow fix and the general one

**Narrow:** exempt `.qozyai/memory` from the walk. Correct, and wrong in shape — it
puts the name of one outside tool inside the core, and the next outside tool to keep
state there finds out about this rule by losing data.

**General, and what this spec adopts:** the floor sweeps the subtrees the runtime
*writes*, not everything that happens to sit under the root.

> The runtime expires what it produced. State under `.qozyai/` that the runtime did
> not write is not the runtime's to delete.

Concretely: walk `paths.history` and `paths.io` instead of `paths.root`.

## 3. What changes, precisely

| Before | After |
|---|---|
| `walk(paths.root)` — every file under `.qozyai/` | `walk(paths.history)` and `walk(paths.io)` |
| loose files directly under `.qozyai/` expire | they are left alone |
| a future outside store under `.qozyai/` silently rots | it is safe by default |

Nothing writes loose files at `.qozyai/` root today: `ensure()` creates `root`,
`history`, `active`, `io`, `inbox`, `outbox` and the two archive roots, and every
writer targets one of the named subtrees. So the observable change on an existing
workspace is exactly zero until something outside starts storing state there — which
is the point.

The emptied-archive tidy-up that follows the walk is unchanged; it already names its
four roots explicitly.

## 4. The test that had to fail first

`test/workspace-state.test.js`, "the outer floor does not reach state the runtime does
not own": write `.qozyai/memory/daily/<date>/user.md`, backdate it a hundred days, run
`prune()`, and assert it survives — alongside an aged file inside `io/` in the same
run, asserting that one is still removed. Without the change the memory file is
deleted and the test fails on the first assertion; the second assertion is what stops
the fix from being "turn the floor off".

The existing test "the outer floor removes any aged file and keeps the structure"
stays green unmodified, because its aged file is under `io/history/outbox`.

## 5. What shipped

- `src/core/workspace-state.js`: `sweepAgedFiles()` walks the owned subtrees.
- `test/workspace-state.test.js`: the test in §4.
- `.claude/skills/memory/scripts/memory.mjs`: the store roots at
  `<workspace>/.qozyai/memory`, with `QOZYAI_MEMORY_STATE` retained as an override so
  a test run stays off the real store. This half is an outside change and needed no
  spec of its own; it is recorded here because it is the reason the core change exists.
- The existing store was migrated and the old location removed.

## 5a. What `0018` did to this

The narrowing in §2 is gone, because the sweep it narrowed is gone. `0018` removed
age-based deletion from the runtime altogether, which achieves this spec's goal more
completely than this spec did: memory is safe not because the floor was taught to avoid
it, but because the runtime no longer deletes anything for being old. The reasoning in
§1 stands as the record of why it mattered.

## 6. What is deliberately not here

Retention *for* memory. Nothing expires it now, and a memory store that grows without
bound is a real problem — just a different one, with a different owner, and it belongs
to whatever answers `0014` §7 question 3 about payload minimization. Saying "the
runtime does not delete this" is not the same as saying "this never needs deleting".
