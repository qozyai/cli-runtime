# 0016 — A project has an identity, and copying it forks

**Status:** specced, not built. Nothing has changed under `src/`.

**Guarantee touched:** none directly, but §6 is honest about the one it will touch when
the second half lands: re-keying sessions changes what "the same conversation" means,
which is guarantee 5 territory. This spec deliberately stops short of that.

**Implements** `0014` `decisions.md` §3.

## 1. Why a project needs a name that is not its path

Today a project *is* its absolute path. `sessionKeyFor()` builds
`telegram:<routeKey>:<projectPath>` (`src/surface/telegram.js:276`), memory hashes
`memory:<absolutePath>`, and wake schedules embed the same string. The consequences are
all downstream of that one choice:

- rename a directory and its conversation is gone — a different key, a fresh session;
- copy a directory and two live trees answer to one name, so two sessions write one
  history and two schedules fire into one thread;
- nothing can say whether a folder found on another machine *is* the project it was
  copied from, or a second one.

`0014` decided the semantics: **a move preserves identity, a copy forks it.** This spec
is how the runtime tells them apart.

## 2. The manifest

`<workspace>/.qozyai/project.json`, written by the runtime on `ensure()`:

```json
{ "version": 1,
  "projectId": "prj_01J9...",
  "boundPath": "/code/qozyai",
  "createdAt": "2026-08-19T15:00:00.000Z",
  "forkedFrom": null }
```

`projectId` is opaque and never derived from the path — deriving it from the path is
the bug this spec exists to remove. `boundPath` is where the manifest was last seen,
and is the whole detection mechanism. `forkedFrom` records the parent id when this
project came into being as a copy, so a fork's ancestry is inspectable rather than lost.

## 3. The registry

`<state>/projects.json`, a map of `projectId -> { path, lastSeenAt }`. It is the
machine-global half, and it is what makes "is the original still there?" answerable
without scanning the filesystem. It is a cache with an authority: the manifest in the
directory wins, and the registry is rebuilt from manifests when they disagree.

## 4. The rule, on every `ensure()`

Let `here = path.resolve(workspace)`.

| Manifest state | Registry state | Conclusion |
|---|---|---|
| absent | — | new project. Mint an id, write the manifest, register it |
| `boundPath === here` | any | same project. Refresh `lastSeenAt` |
| `boundPath !== here`, and `boundPath` no longer holds a manifest with this id | — | **moved.** Rewrite `boundPath`, update the registry |
| `boundPath !== here`, and `boundPath` still holds a manifest with this id | — | **copied.** Mint a new id, set `forkedFrom` to the old one, write the manifest here, register the new id. The original is untouched |

The test is "does the original still exist and still claim this id", not "did the path
change" — because a move and a copy are indistinguishable from the destination alone.

**A known limit, stated rather than discovered.** Copy a project, then delete the
original before the copy is next used, and the copy is read as a move and inherits the
identity. That is the safe direction to fail: it preserves continuity that nobody else
is claiming. The unsafe direction — two live trees sharing an id — is the one the rule
prevents, and it prevents it whenever both exist, which is the case that matters.

## 5. What a fork means for the state it copied

A fork inherits files, not identity, and the two are stored differently:

- **`.qozyai/history/*.jsonl`** are named by `sessionHash(sessionKey)`. Until §6 lands
  the session key is still path-derived, so the copy's history files are already
  addressed by their new path and nothing is stale.
- **`.qozyai/memory/`** is copied wholesale and is now the fork's memory, which is
  correct: it is what the project knew at the moment it was forked.
- **Wake schedules** are *not* in the project (`0014` §5) and so are not copied. This
  is the concrete payoff of having left them global: a forked project does not arm a
  second timer into the original's Telegram thread.

## 6. What this spec does not do

It does not re-key sessions. Session keys stay path-derived, and identity is recorded
alongside rather than substituted in. Substituting it is a larger change — it migrates
every existing session key, every wake schedule's `sessionKey`, and memory's
`memory:<path>` — and it changes what counts as the same conversation, which needs its
own spec and its own failing test.

So after this spec, a move still forks the *conversation* while preserving the
*project*. That is a strange halfway state and it is deliberate: it makes the identity
mechanism observable and testable before anything depends on it for routing.

## 7. Tests that must fail first

1. A workspace with no manifest gets one, and an id that is not a function of its path.
2. Rename a workspace directory, `ensure()` again: same `projectId`, updated
   `boundPath`, registry follows.
3. Copy a workspace directory, `ensure()` the copy: a **different** `projectId`,
   `forkedFrom` naming the original, and the original's manifest byte-identical.
4. Copy, delete the original, `ensure()` the copy: identity inherited — the documented
   limit, asserted so that changing it is a deliberate act.
5. A registry that disagrees with a manifest is corrected from the manifest.

## 8. What is not built

All of it.
