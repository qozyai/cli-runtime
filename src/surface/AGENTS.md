# surface

Everything that exists because the runtime has a human-facing front door: the chat
adapter, transcription, and the state that only a conversational surface needs —
who the owner is, which route points at which project and driver, what projects
exist.

The test that defines this directory: **delete it and a working runtime remains** —
a socket API that accepts submissions and runs turns, with no chat on top. A second
surface should be addable without touching `core/` or `drivers/`.

## What may be imported

- `core/`, `drivers/`, and other files in `surface/`

Nothing imports *from* here except `main.js`, which wires everything.

## The shape of a mistake here

Putting something here that the core actually needs, or putting something in the
core that only this directory needs. The question to ask is whether a runtime with
no chat attached would still want it.

Also: only this directory holds the outbound credential. Anything outside the
runtime that needs to reach the owner writes a notice into the spool and lets the
adapter send it. That asymmetry is the seam; do not work around it.
