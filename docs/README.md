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
| [`0002-telegram-project-routing`](specs/0002-telegram-project-routing/spec.md) | Planned, not implemented. Ships as two independent releases with separate gates. [Decisions](specs/0002-telegram-project-routing/decisions.md). |

Each spec carries its own `## Status` block; that block is the authority, this
table is the index. Number the next spec `0003-` and give it a slug describing
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
