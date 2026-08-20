# 0014 — Where state lives, and the third root nobody counted

**Status:** answered. `decisions.md` records what the owner decided on 2026-08-19;
§7 states the questions it answers. Two of the four are built (`0015`, and `0017` for
the fourth), one is specced only (`0016-project-identity`). The fourth was decided
twice the same day — option (b), then (c) once (b) was built and produced the evidence
against itself; `decisions.md` §4 and `0013` §3 carry that. The finding in §2 is still
the substance of this spec: the question was asked under an incomplete premise, and
correcting the premise changes the answer.

**Guarantee touched:** none of the eight as written. §5 records which ones a
relocation *would* touch if one were attempted, because moving a record that
something outside already reads is a core change under `AGENTS.md` regardless of
which directory the file lands in.

**Defers to, and is deferred to by,** `0013` §3. The plugin-capability choice there is
this boundary question wearing different clothes; §7 argues it should be answered
after this one rather than before.

## 1. The question

The owner's stated intent, verbatim in substance: *the project folder should be
self-contained, including the state of the conversation; nothing belonging to a
project should live in `~/.local/state`.*

Taken literally that is a directory-layout question. It is not. The layout is
downstream of three decisions nobody has made, listed in §7.

## 2. There are three roots, not two

Measured 2026-08-19 on the dev box:

| Root | Size | Owned by | Holds |
|---|---|---|---|
| `<project>/.qozyai/` | 246 MB for `/code/qozyai` | this runtime | `history/*.jsonl` (1.3 MB), `io/` (245 MB, of which `io/history` is 243 MB of archived attachments) |
| `~/.local/state/qozyai-*` | 21 MB, **all projects combined** | this runtime and its outside tools | `sessions/`, `submissions/` (782), `sessions/*/prompts/` (783 files, 3.4 MB), `events.jsonl`, `telegram/`, `deployments/`, socket and locks; plus `qozyai-wake/`, `qozyai-memory/`, `qozyai-plugins/` |
| `~/.claude/projects`, `~/.codex/sessions` | **114 MB + 1.7 GB** | the driver CLIs | the actual provider transcripts |

The third root is the one the question did not account for, and it is two orders of
magnitude larger than the one the question objected to. `artifactRoot()` in
`src/drivers/drivers.js:137` resolves it:

```js
return driver === "claude"
  ? path.join(selected.homeDir, ".claude", "projects")
  : path.join(selected.homeDir, ".codex", "sessions");
```

It is not ours to relocate. Guarantee 3 — the provider decides the outcome — is the
reason it exists: the runtime reads success from the provider's own artifact, so the
provider's artifact store is a dependency, not an implementation detail.

A note on the 246 MB: it is not evidence that the project folder already holds the
conversation. 243 MB of it is `io/history`, archived voice notes and attachments. The
normalized record of what was actually said is 1.3 MB across 8 session files.

## 3. A copied project is not a resumable conversation

Three independent reasons, none of which a file move fixes:

1. **The resume target is not in the project.** `session.json` stores a
   `providerSessionId`; the runtime resumes by handing that id to the driver CLI,
   which finds the transcript under its own home (§2). Nothing replays
   `.qozyai/history` into a fresh provider session.
2. **Identity embeds the absolute path.** `sessionKeyFor()` in
   `src/surface/telegram.js:276` builds `telegram:<routeKey>:<projectPath>`. Moving or
   renaming a directory produces a different session key and therefore a different
   conversation. That is deliberate, not incidental — see `0002` Path safety `R1`,
   where a renamed-away workspace surfaces `WORKSPACE_MISSING`, leaves the filesystem
   untouched, and **leaves rename-back working**.
3. **The normalized history is deliberately lossy.** `0003` §"Successful tool output
   is deliberately discarded", and its non-goals explicitly exclude exact
   provider-artifact replay and any recovery of opaque reasoning payloads.

So `.qozyai/history` is a portable, readable, retention-bounded *archive*. It was
never the live conversation and does not become the live conversation by having
`session.json` moved next to it.

## 4. What is actually misplaced, and it is one thing

`~/.local/state/qozyai-memory/qozyai-56bc4704/`. The suffix is
`sha256(resolve(workspace)).slice(0,8)` — `.claude/skills/memory/scripts/memory.mjs:86`.
A directory named after a hash of a project path, sitting in a machine-global root, is
per-project state in the wrong place. This is the owner's instinct landing exactly on
target, and it is the only clean instance of it. **Moved on 2026-08-19** to
`<workspace>/.qozyai/memory/`; the old location no longer exists.

**It is not free to move.** The memory pass chose the global root partly because
`.git/info/exclude` is repository-local and uncommitted, so a project-local memory
store is protected by a mechanism that does not travel with a clone. Moving it means
answering that, not just changing a path. It also depends on the sanctioned
`<workspace>/.qozyai/history` seam from `AGENTS.md`, so its own storage moving into
`.qozyai/` puts reader and store under the same root — which is tidier, and which
§7 argues is the point.

## 5. What is correctly global, and why

| State | Why it cannot be per-project |
|---|---|
| `telegram/offset.json` | one `getUpdates` cursor per **bot**. Per-project copies would each advance it and consume each other's updates. Correctness, not preference. |
| `telegram/{owner,routes}.json`, `queue/`, `notices/` | bot-level identity and the guarantee-8 spool. One adapter, one spool. |
| `runtime.sock`, `runtime.lock`, `deploy.lock` | one daemon. A socket path also carries a ~104-byte limit and project roots can be deep or on network mounts. |
| `deployments/release_*` | releases of the runtime itself. Not a project's state. |
| `events.jsonl` | one append-only log with a monotonic `sequence` and a 16 MB tail replay (`src/core/event-store.js`). Cross-project ordering is the point of it. |
| `sessions/`, `submissions/`, `sessions/*/prompts/` | `SessionManager.init()` enumerates one global directory for restart recovery; `GET /v1/submissions/:id` is globally keyed; and per §3.2 session identity must remain readable *while the workspace is missing*, or `WORKSPACE_MISSING` and "no such session" become indistinguishable and rename-back stops working. |
| wake `schedules/*.json` | the objection is not daemon scanning, it is **activation authority**. A project-local schedule copied to a second machine would silently arm a second timer firing into the original Telegram route, at real model cost. |

The last two are the ones most likely to be proposed for relocation on the grounds
that each record names exactly one project. That grounds is insufficient: placement
follows authority, recovery and failure domain, not cardinality.

## 6. Two claims that did not survive checking

Recorded so they are not re-derived:

- **`<state>/auth/{claude,codex}` do not hold credentials.** They are empty, and are
  used as working directories for interactive authentication terminals —
  `src/drivers/auth-manager.js:153` sets `workspace = path.join(this.authDir, driver)`
  for the tmux session. Real credentials live in the configured driver home. Any
  argument about credential blast radius must be aimed there.
- **`.qozyai/` is already git-excluded automatically.** `ensureGitExclude()`
  (`src/core/workspace-state.js:331`, called at `:325`) appends it to
  `.git/info/exclude` on every workspace init. Of `/code/{qozyai,hermes,pet,maintenance}`
  only `hermes` is currently a git worktree, which is the whole explanation for the
  observed difference. A self-ignoring `.qozyai/.gitignore` would still help a later
  `git init` or a folder transfer, but it is a change under `src/` and therefore a
  core change — not the free independent fix it first appears to be.

## 7. Recommendation — answered, see `decisions.md`

Adopt a promise, not a directory rule:

> **Moving or archiving a project carries everything needed to understand and
> reconstruct its work — and nothing that could log in as you, and nothing that
> coordinates the machine that happened to run it.**

That is the owner's taste, made precise enough to implement, and it keeps the project
folder something that can be handed to someone else. "All state in the project" does
not survive §2 and §5; "locality by cardinality" was the first replacement considered
and is rejected in §5.

Three questions must be answered before any file moves:

1. **Archive, or live resume?** Only the first is achievable without the driver CLIs'
   cooperation (§3). If live resume is wanted it needs an explicit quiesced
   export/import that rebinds paths and routes, not a rearrangement of active files
   while the daemon is writing to them.
2. **Does copying a folder preserve identity or fork it?** Move and copy cannot mean
   the same thing. Two live copies presenting one identity must be rejected or
   explicitly cloned. This needs a stable project id in a versioned `.qozyai`
   manifest plus a global `projectId -> current path` registry — which is also the
   prerequisite for anything in §5's last two rows ever moving.
3. **Must conversation payload exist *only* in the project?** It currently does not:
   submission records carry full `reply` text, `sessions/*/prompts/` holds exact
   assembled prompts, and `events.jsonl` carries reply-bearing events. Exclusive
   locality means payload-minimizing the global plane — retaining ids, status and
   timestamps, dropping or rapidly expiring text. That is a larger change than
   relocation and touches guarantee 4.

**Order of work, if the answers point at doing anything:** define project identity
(2) before moving memory (§4), and answer `0013` §3 after this rather than before —
because a named locality rule makes that choice fall out. Today's plugin exceptions
already straddle both roots (`<state>/telegram/queue` for `queue-janitor`,
`<workspace>/.qozyai/history` for memory), and `0013` §2 is right that three
exceptions is a capability nobody has admitted to designing. A rule that says which
root a given chore belongs to turns that from a judgement call into a lookup.

## 8. What is and is not built

| §7 item | State |
|---|---|
| the promise | adopted; it is the rule placement arguments are settled against |
| memory into `.qozyai/` | **built**, with `0015-memory-in-workspace` as the core change that made it safe |
| copy forks, move preserves | **specced only** — `0016-project-identity`. No manifest, no registry, no test |
| `0013` §3 → option (b), then (c) | **settled and built.** `runtime-janitor` was built under (b) and deleted under (c); retention stays in the runtime and gained policy and a clock in `0017` |

Payload minimization (§7 question 3) is not started and has no spec.
