# Turn State And File Exchange

The runtime keeps driver-neutral project continuity under the workspace:

```text
.qozyai/
  history/
    <session-hash>.jsonl
    active/
      <submission-id>.json
  io/
    inbox/
    outbox/
    history/
      inbox/
      outbox/
      events.jsonl
```

`.qozyai/` is added to the repository-local Git exclude file when the workspace
is a Git root. State files are private runtime data and are not project source.

## Deterministic V1

At submission acceptance, the runtime stages caller-provided regular files into
the live inbox and immutable input archive. Files are prefixed with a hash of the
stable caller `sessionKey`; driver switches do not change that hash. Audio may
have a caller-provided transcript sidecar, but the runtime does not invent or
silently transcribe audio.

While the turn is active, the provider artifact watcher updates
`history/active/<submission-id>.json`. The record contains:

- provider artifact cursor and opaque provider session ID
- latest three bounded plaintext reasoning chunks
- latest three bounded tool calls with call ID, arguments, status, and failure
  detail only when failed
- a deterministic status summary capped at 500 characters

Known credential shapes and values under secret-like argument keys are
redacted. Encrypted/hidden reasoning and successful tool output are excluded.
If a driver exposes no plaintext reasoning, its latest visible assistant
progress message is used as the summary fallback.
An event is emitted only when normalized progress changes.

On terminal completion, the runtime appends one normalized turn to the session
JSONL and removes the active snapshot. Output files must be direct regular files
in the live outbox and use the session prefix shown in the submission prompt.
They are copied into immutable output history and returned as pending delivery.
The live copy is deleted only after the caller acknowledges successful delivery.

History and linked I/O archives use QozyAI's active-work retention rule:

- a gap of at least six hours starts a new work cluster
- newest whole clusters are retained until their accumulated active duration
  reaches at least 48 hours
- idle gaps do not consume the 48-hour budget

## Future Interpreted Observer

The API deliberately leaves room for an optional cheap observer, but V1 does
not call another model. A future observer can run as an independent sibling
session, consume only the bounded provider JSONL diff after its persisted
cursor, and replace the deterministic summary with an interpreted one. It may
also maintain `<submission-id>_interpreted.json`.

That observer must remain advisory: it cannot submit input to the main driver,
decide completion, mutate conversation history, or block the main turn. The
active-turn file and progress event contracts remain stable so Telegram and
QozyAI do not need a second integration path.
