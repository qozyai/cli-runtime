# drivers

Provider invocation and the terminal underneath it: how a driver is launched,
version-checked, authenticated, navigated past its startup screens, and how its
transcript is turned into something provider-neutral.

Two providers are supported today. A third should land here and nowhere else — that
is the test of whether this boundary is doing its job.

## What may be imported

- `core/` — mostly `util` and `progress`
- other files in `drivers/`

**Never `surface/`.**

## The shape of a mistake here

Letting a provider's vocabulary escape. Above `artifact-parser.js` nothing knows
whether a turn came from one CLI or another, and every difference between them —
different record types, different completion signals, exit codes wrapped in output
text — is normalized here. If a provider-specific concept appears outside this
directory, it leaked.
