# Documentation

Three kinds of document, kept apart because they are read for different reasons.

- **`specs/`** — what to build and the gate that decides it is done. One numbered
  directory per body of work, holding the specification and, alongside it, the
  rationale and the implementation review that share its lifecycle. A spec is
  authoritative for implementation; its `decisions.md` is not required reading.
- **`guides/`** — the operator contract for behavior that exists. Written for
  someone running the thing, not building it.
- **`roadmap.md`** — deliberately deferred work, with the reason.

`README.md` at the repository root stays the entry point for install and API.

## Specs

| Spec | Status |
|---|---|
| [`0001-cli-runtime-hardening`](specs/0001-cli-runtime-hardening/spec.md) | Implemented, release-gated 2026-08-02. [Review](specs/0001-cli-runtime-hardening/review.md). |
| [`0002-telegram-project-routing`](specs/0002-telegram-project-routing/spec.md) | Implemented. Shipped as two independent releases with separate gates. [Decisions](specs/0002-telegram-project-routing/decisions.md). |
| [`0003-normalized-semantic-history`](specs/0003-normalized-semantic-history/spec.md) | Partially implemented 2026-08-18. Preserves ordered user, model, and tool blocks with bounded tool data. [Decisions](specs/0003-normalized-semantic-history/decisions.md). |
| [`0004-turn-lifetime`](specs/0004-turn-lifetime/spec.md) | Implemented. Replaces the wall-clock turn deadline with stall detection and a defined aftermath. [Decisions](specs/0004-turn-lifetime/decisions.md). |
| [`0005-restart-announcements`](specs/0005-restart-announcements/spec.md) | Implemented. Notice spool for planned restarts, plus self-reported unexpected ones. [Decisions](specs/0005-restart-announcements/decisions.md). |
| [`0006-peripheral-failure-isolation`](specs/0006-peripheral-failure-isolation/spec.md) | Implemented. Project-wide invariant: observability, history, and enrichment failures never fail a turn. [Decisions](specs/0006-peripheral-failure-isolation/decisions.md). |
| [`0007-burst-joining`](specs/0007-burst-joining/spec.md) | Implemented. Messages arriving together are debounced into one turn. |
| [`0008-workspace-state-age-floors`](specs/0008-workspace-state-age-floors/spec.md) | Implemented, then superseded by `0018`: the floors left `src/`. |
| [`0009-owner-measured-work-window`](specs/0009-owner-measured-work-window/spec.md) | Implemented. Retention is measured by owner turns, not scheduled ones. |
| [`0010-driver-version-pinning`](specs/0010-driver-version-pinning/spec.md) | Implemented. Driver versions pinned per release and verified at startup. |
| [`0011-source-layout`](specs/0011-source-layout/spec.md) | Implemented. `src/` split into core, drivers, surface, with an enforcement test. |
| [`0012-age-floors-outside`](specs/0012-age-floors-outside/spec.md) | Withdrawn; its own §5 records the reversal that `0018` then completed. |
| [`0013-operational-prune-outside`](specs/0013-operational-prune-outside/spec.md) | Answered (c): the prune stays in the runtime, deliberately. |
| [`0014-state-locality`](specs/0014-state-locality/spec.md) | Answered. State lives in the workspace; [decisions](specs/0014-state-locality/decisions.md) records the choices. |
| [`0015-memory-in-workspace`](specs/0015-memory-in-workspace/spec.md) | Implemented. The memory store moved into the workspace, out of the sweep's reach. |
| [`0016-project-identity`](specs/0016-project-identity/spec.md) | Specced, not built. |
| [`0017-retention-policy-and-maintenance`](specs/0017-retention-policy-and-maintenance/spec.md) | Implemented, then superseded in part by `0018` the same day; the record floor and grace survive. |
| [`0018-retention-outside`](specs/0018-retention-outside/spec.md) | Implemented and deployed. The runtime deletes by meaning; a janitor deletes by age. |
| [`0019-adapter-reply-delivery`](specs/0019-adapter-reply-delivery/spec.md) | Implemented. The adapter can no longer lose a reply it already asked for. |
| [`0020-review-remainders`](specs/0020-review-remainders/spec.md) | Implemented. The driver seam restored, plus the review's remaining correctness holes, each behind its missing test. |
| [`0021-module-homes`](specs/0021-module-homes/spec.md) | Implemented. Notices moved to the surface, the navigator's backend to drivers, client.js stays by decision. |
| [`0022-learning-auth-navigation`](specs/0022-learning-auth-navigation/spec.md) | Implemented. The navigator learns each screen it is consulted about; lessons commit only on a successful authentication. |
| [`0023-chat-delivered-reauth`](specs/0023-chat-delivered-reauth/spec.md) | Implemented. The login URL and code arrive in chat, the code comes back or completion is detected, and the blocked message resumes. |

Each spec carries its own `## Status` block; that block is the authority, this
table is the index. Number the next spec `0024-` and give it a slug describing
the work, not the release.

## Guides

- [`guides/turn-state.md`](guides/turn-state.md) — workspace state, file
  exchange, and retention.
- [`guides/telegram-projects.md`](guides/telegram-projects.md) — projects root,
  topic bindings, and the trust boundary. Describes spec `0002`, so it is
  completed and verified as part of that work.

## Local-only fixtures

`docs/dev-fixtures.md` holds the live VM and Telegram fixtures that spec `0002`
requires for items marked **[live]**. It is not in this repository and will not
appear in `git status`: it names an internal jump host, a private address, and
lab paths, and `qozyai/cli-runtime` is public. The file is excluded through
`.git/info/exclude`, which is local to each clone and is itself never published.

A clone made elsewhere therefore has neither the file nor the exclude rule.
Copy both across by hand, or the next `git add -A` in that clone publishes the
fixture. Anything in it that would be needed to run the automated suite belongs
in the spec instead — only the **[live]** tier depends on it.
