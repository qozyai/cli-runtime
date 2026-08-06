# Normalized Semantic History V2

## Status

Planned on 2026-08-05. Not implemented.

This specification replaces the lossy progress-shaped turn history with an
ordered semantic record of what the user, model, and tools did. It does not
change provider artifacts as the completion authority, the 48-active-hour
retention policy, or the user-facing progress API.

The measurements and provider-specific evidence behind the design are recorded
separately in [decisions.md](decisions.md).

## Product Requirement

Normalized history must be useful for continuity, auditing, and text search
without retaining the much larger provider artifact.

For every turn it must preserve, in observed order:

- the canonical user request, including transcript text and the contents hidden
  behind runtime prompt-file indirection
- every readable model reasoning block exposed by the provider
- every model commentary block
- every tool call, with bounded and redacted arguments
- every tool outcome
- the final model answer

Successful tool output is deliberately discarded. Failed tool output is
retained in bounded form because it is often the only actionable explanation of
the failure.

## Non-Goals

- Exact provider-artifact replay. Successful tool output may have influenced
  later model behavior but is intentionally absent.
- Recovering, decrypting, or copying opaque reasoning payloads or signatures.
- Storing binary input files in JSONL. Input files remain in the existing I/O
  archive and are represented in history by metadata and available transcript
  text.
- Extending the current retention window.
- Making normalized history safe to publish. It remains sensitive workspace
  data even after redaction.
- Changing provider completion detection or the Telegram progress presentation.

## Durable Layout

Keep the existing finalized session file and split active-turn state into a
small snapshot plus an append-only semantic journal:

```text
.qozyai/history/
  <session-hash>.jsonl
  active/
    <submission-id>.json
    <submission-id>.blocks.jsonl
```

`<submission-id>.json` remains the mutable recovery snapshot. It contains turn
status, provider session ID, artifact path and cursor, timestamps, and the last
durably journaled source position. It must not contain the expanding block
history.

`<submission-id>.blocks.jsonl` is append-only. Each record carries a stable
provider-derived event identity or source position so replay after a crash can
deduplicate an event already appended before its cursor update.

On terminal completion, finalization folds the journal into one version-2 turn
record, appends that record once to `<session-hash>.jsonl`, and only then removes
the active snapshot and journal. Existing idempotency by `submissionId` remains
mandatory.

## Finalized Turn Schema

The ordered `blocks` collection is authoritative:

```json
{
  "version": 2,
  "kind": "turn",
  "turnId": "submission-id",
  "submissionId": "submission-id",
  "sessionKey": "session-key",
  "driver": "codex",
  "providerSessionId": "provider-session-id",
  "status": "completed",
  "inboundAt": "2026-08-05T00:00:00.000Z",
  "startedAt": "2026-08-05T00:00:01.000Z",
  "completedAt": "2026-08-05T00:01:00.000Z",
  "blocks": [
    {
      "seq": 1,
      "kind": "user",
      "text": "complete canonical request",
      "inputs": []
    },
    {
      "seq": 2,
      "kind": "reasoning",
      "available": false,
      "format": "opaque"
    },
    {
      "seq": 3,
      "kind": "commentary",
      "text": "I am checking the implementation."
    },
    {
      "seq": 4,
      "kind": "tool_call",
      "callId": "call-1",
      "tool": "exec",
      "arguments": "{\"cmd\":\"npm test ...[truncated]\"}",
      "argumentsBytes": 8200,
      "truncated": true
    },
    {
      "seq": 5,
      "kind": "tool_result",
      "callId": "call-1",
      "status": "success",
      "exitCode": 0,
      "outputBytes": 24000
    },
    {
      "seq": 6,
      "kind": "final",
      "text": "The change is complete."
    }
  ],
  "failure": null,
  "outputs": [],
  "outputError": null
}
```

Version-2 writers may retain the existing top-level `user`, `reasoning`,
`tools`, and `assistant` fields as derived compatibility projections during
migration. Readers must treat `blocks` as authoritative when it is present and
must continue accepting version-1 turns. Existing version-1 records are never
rewritten solely to migrate them.

## Block Contract

Every block has a positive, contiguous `seq` in semantic observation order and
one of these `kind` values:

### `user`

- Exactly one canonical user block starts a normal turn.
- `text` is the complete request as known before terminal-delivery indirection.
  If the CLI receives an instruction to read a daemon-owned prompt file, history
  stores the file's original request content rather than that instruction.
- Voice transcript text is embedded directly for grepability.
- `inputs` preserves the existing input metadata. Binary file bytes remain in
  the I/O archive rather than being encoded into the history line.

### `reasoning`

- Each readable provider-exposed reasoning or thinking block is retained in
  order with `available: true` and `text`.
- Opaque reasoning is represented by a small `available: false` block and its
  format. Provider ciphertext, encrypted content, and Claude signatures are not
  copied.
- Token counts may be recorded only where the provider attributes them
  unambiguously to this turn or block. Cumulative counters must not be presented
  as a block-local measurement.
- The absence of readable reasoning is represented honestly; commentary must
  never be relabeled as private reasoning.

### `commentary`

- Preserve every visible assistant text block emitted before terminal
  completion.
- Codex's explicit commentary phase maps directly.
- For Claude, visible assistant text accompanying a `tool_use` continuation is
  commentary. Visible text in the terminal `end_turn` message is final.
- Repeated provider display events do not produce duplicate blocks.

### `tool_call`

- Preserve `callId`, normalized tool name, redacted serialized arguments,
  original serialized UTF-8 byte count, and truncation state.
- Redact before persistence and retain at most 4 KiB of serialized arguments.
- Truncated arguments are stored as text rather than malformed partial JSON.
- Missing provider call IDs receive a deterministic ID derived from driver,
  source artifact, and source position.

### `tool_result`

- Correlate the result with `callId` and preserve provider status, normalized
  `success | failure | interrupted | unknown` status, exit code when available,
  original output byte count, and truncation state.
- A successful result stores no output body.
- A failed, interrupted, or unknown result may retain up to 16 KiB of redacted
  error/output text.
- Provider duplicates of the same result are represented once. In particular,
  Claude's separate `toolUseResult` copy must not duplicate its `tool_result`
  block.
- A call with no observed result remains a call; no successful result may be
  inferred.

### `final`

- Preserve the terminal user-visible assistant answer as one final block.
- A failed or interrupted turn may have no final block or may retain the partial
  terminal text actually exposed by the provider.
- Provider display echoes do not create additional final blocks.

## Text Bounds And Redaction

The semantic sequence must be complete even when individual content is
truncated: retain the block and record its original byte count and truncation
state.

- Tool arguments: 4 KiB per call.
- Failed/interrupted/unknown tool output: 16 KiB per result.
- Successful tool output: zero bytes.
- User, reasoning, commentary, and final text: use the existing 40,000-character
  normalized-history text bound per block until measurements justify a separate
  limit.

Apply the shared history redactor before writing any argument, output, error, or
model/user text. Bounds and redaction are defenses against accidental growth and
known secret forms, not a security boundary.

## Parser And Ordering Requirements

Provider adapters emit one provider-neutral stream of semantic block events.
Completion/progress state is derived alongside that stream rather than from a
separate lossy last-N parser.

The implementation must:

1. Bind to the submitted turn marker before journaling provider events.
2. Preserve provider observation order across incremental artifact reads.
3. Give every source event a stable deduplication identity.
4. Keep all semantic events for the turn; do not retain only the latest 20.
5. Append commentary rather than overwriting the latest assistant message.
6. Correlate results to calls without mutating an earlier journal record.
7. Deduplicate Codex display-event echoes and Claude result mirrors using
   provider-specific rules backed by captured fixtures.
8. Preserve complete UTF-8 records across polling boundaries.
9. Resume from the durable source position after process restart without gaps
   or duplicate blocks.

## Retention

The existing 48-active-hour history rule remains unchanged:

- a gap of at least six hours starts another work cluster
- newest complete clusters are retained until their accumulated durations reach
  at least 48 hours
- gaps between clusters do not consume the budget
- unknown, malformed, or unclassifiable records are retained

Finalized version-2 turns are pruned as history records under that policy.
Active snapshots and block journals are bounded operational files and follow the
existing abandoned-active cleanup rules. I/O archives retain their existing
separate lifecycle and pending-delivery protection.

## Required Tests

- [ ] Codex fixture preserves user, opaque reasoning marker, all commentary,
      all calls/results, and final answer in exact semantic order.
- [ ] Claude fixture preserves thinking availability, commentary, calls/results,
      and terminal answer in exact semantic order.
- [ ] Codex display echoes do not duplicate user, commentary, or final blocks.
- [ ] Claude `tool_result` and `toolUseResult` copies produce one result block.
- [ ] More than 20 tool calls and more than three reasoning/commentary blocks
      survive finalization.
- [ ] Successful results contain status, exit code, and byte count but no output.
- [ ] Failed results retain redacted output up to 16 KiB and report truncation.
- [ ] Arguments retain redacted text up to 4 KiB and report original size and
      truncation.
- [ ] Opaque reasoning never copies ciphertext or signatures.
- [ ] A daemon-owned prompt-file request is embedded directly into the user
      block and remains searchable after the prompt file is pruned.
- [ ] Crash after journal append but before cursor update replays without a
      duplicate block.
- [ ] Crash after finalized-turn append but before active cleanup finalizes
      idempotently by `submissionId`.
- [ ] Version-1 and version-2 records coexist in one session JSONL and both are
      readable.
- [ ] Existing 48-active-hour retention and malformed-record preservation work
      unchanged with version-2 turns.
- [ ] History views and Telegram progress never expose reasoning merely because
      normalized history now retains it.

## Completion Gate

This work is complete when both real-provider fixture suites demonstrate a
lossless ordered semantic block sequence under the stated bounds, restart tests
prove journal/finalization idempotency, successful tool output is absent from
durable normalized history, and the measured normalized corpus remains at least
an order of magnitude smaller than its raw provider artifacts.
