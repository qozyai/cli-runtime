# Design Decisions

Rationale for [spec.md](spec.md). This document records the evidence and
tradeoffs; the specification remains authoritative for implementation.

## Why normalized history needs ordered blocks

Current normalized history was designed as a compact progress snapshot, not a
semantic turn log. The provider parser retains only the latest 20 reasoning and
tool events. Progress normalization then reduces this to the latest three
reasoning excerpts and one tool call, while intermediate assistant text is
overwritten by the next assistant message.

That is sufficient for a short status display but loses the sequence needed to
answer basic historical questions: what the model said before a command, which
arguments the command received, why it failed, and which message was the final
answer. The new `blocks` collection makes the sequence the durable unit rather
than attempting to reconstruct it later from projections.

The current limits can be seen in `src/artifact-parser.js` and
`src/progress.js`. Finalization then writes only those projections in
`src/workspace-state.js`.

## Evidence from real artifacts

Measured on 2026-08-05 against every provider session referenced by this
workspace's normalized history:

- six Codex sessions
- four Claude sessions
- Claude subagent artifacts excluded
- one Codex session still active, so its raw size was increasing during the
  measurement

The proposed estimate retained every user, commentary, final-answer, and
available reasoning block; bounded tool arguments to 4 KiB; discarded successful
tool output; and retained up to 16 KiB for failed output. Opaque reasoning kept
metadata only.

| Provider | Raw artifacts | Current normalized | Proposed semantic history |
|---|---:|---:|---:|
| Codex | ~26.7 MiB | ~155 KiB / 0.57% | ~1.21 MiB / 4.5% |
| Claude | ~3.39 MiB | ~100 KiB / 2.9% | ~404 KiB / 11.6% |
| Combined | ~30.1 MiB | ~255 KiB / 0.83% | ~1.61 MiB / 5.3% |

The semantic design is approximately 6.5 times larger than current normalized
history while remaining approximately 19 times smaller than the raw artifacts.
That is an acceptable exchange for preserving the full useful sequence.

These values describe the measured corpus, not a permanent compression
guarantee. The completion gate therefore asks only that the verified corpus
remain at least one order of magnitude smaller than its raw artifacts.

## Successful tool output is the dominant removable cost

Tool-output records accounted for:

- 74.2% of Codex artifact bytes
- 51.4% of Claude artifact bytes
- approximately 21.6 MiB of the combined 30.1 MiB sample

Claude additionally duplicated tool results in a separate `toolUseResult`
field. Keeping successful output would copy the largest provider-artifact cost
into normalized history, often for low-value logs such as dependency installs,
test progress, or file listings.

**Decision:** a successful result keeps identity, status, exit code, and output
size only. A failure keeps bounded redacted output because the output is itself
diagnostic evidence. This means normalized history is not an exact replay log;
that limitation is explicit rather than hidden.

## Both providers have reasoning structures, but neither sample exposed text

The initial assumption that Codex has commentary but no reasoning tokens was
incorrect.

Across the six Codex sessions the artifacts contained:

- 1,307 reasoning records
- 157 commentary blocks
- 74 final-answer blocks
- 1,046 tool calls

Codex also reported cumulative `reasoning_output_tokens`. However, all 1,307
reasoning records had empty plaintext summary/content; only encrypted content
was present.

Across the four Claude sessions the artifacts contained:

- 175 thinking blocks
- 23 visible text blocks inferred as commentary
- 24 final-answer blocks
- 286 tool calls

Claude structurally supports thinking blocks, but all 175 measured blocks had
empty plaintext and opaque signatures. Thus neither measured provider corpus
made raw reasoning text available for normalization.

**Decision:** preserve readable reasoning if a provider actually exposes it,
but represent opaque reasoning only as unavailable metadata. Do not copy Codex
encrypted content or Claude signatures. Commentary remains a distinct visible
category and must never be presented as hidden chain-of-thought.

This also explains why all 109 existing normalized turns in the measured
workspace had an empty `reasoning` array: parser support existed, but there was
no plaintext reasoning to capture.

## Active history is a journal, not an expanding snapshot

Rewriting one increasingly large JSON document on every progress update causes
write amplification and makes crash recovery depend on the latest replacement.
Appending blocks matches the provider artifact's own event shape and preserves
ordering naturally.

**Decision:** retain a small mutable active snapshot for lifecycle and cursor
state, and add an append-only block journal. Stable source identities make the
append-before-cursor crash window safe: a replayed provider event is recognized
and skipped. Finalization folds the journal into the one-record-per-turn session
JSONL format, so normal history reads do not need to join multiple files.

An append-only active journal does not make final history event-sourced. The
journal is temporary recovery state and is deleted only after the finalized turn
is durably appended.

## Canonical user text must precede terminal indirection

Large, multiline, or NUL-containing requests are placed in a daemon-owned
mode-0600 prompt file, and the interactive CLI receives a short instruction to
read it. That indirection is correct for reliable terminal delivery but poor
history: grepping later finds only an instruction and a transient filename.

**Decision:** the normalized user block comes from the canonical request held by
the runtime before terminal delivery. The prompt-file instruction is transport
metadata, not the user's semantic message. This also prevents history quality
from depending on whether the model happened to call a file-reading tool.

Voice input follows the same principle. Preserve the normalized user message
and automated transcript text directly; keep the original binary audio under
the existing I/O retention policy.

## Provider-specific deduplication is unavoidable but bounded

Codex repeats some user and assistant content through provider display events.
Claude can repeat a tool result in both the conversation content and a separate
`toolUseResult` field. Treating raw artifact records as normalized blocks would
therefore create false duplicate actions.

**Decision:** adapters own only the minimal mapping and deduplication peculiar to
their artifact format. They emit the same provider-neutral block schema. The
rules must be justified by sanitized real fixtures rather than broad text
similarity, which could collapse two legitimate identical messages or calls.

## Preserve V1 records rather than rewriting history

There is no value in fabricating missing blocks for old turns. The lost
commentary and tool sequence cannot be recovered from current normalized JSONL
after raw artifacts are gone.

**Decision:** readers support both versions; writers append version 2 after the
feature ships. Existing version-1 records stay byte-for-byte untouched unless a
separate repair operation is required by existing corruption rules. Temporary
top-level compatibility projections let older read paths migrate without making
them authoritative.

## Security and retention remain intentionally unchanged

Arguments and failed output have higher diagnostic value but also a higher
chance of containing credentials or private project data. Redaction reduces
obvious accidental exposure but cannot prove that arbitrary text is safe.

**Decision:** keep fixed byte bounds, redact before persistence, and continue to
treat the whole `.qozyai` history as sensitive. Opaque provider payloads are
never duplicated. The established 48-active-hour policy still bounds finalized
history, while pending output delivery continues to receive its existing
protection.

Richer semantics do not justify longer retention. They make the retained window
more useful at an estimated 5.3% of raw artifact storage for the measured
corpus.
