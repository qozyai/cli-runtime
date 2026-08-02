# Roadmap

## Interpreted Progress Observer

A future optional observer may consume bounded provider-artifact deltas in an
independent session and produce a richer progress summary. It must remain
advisory: it cannot submit input, decide completion, mutate normalized history,
or block the main driver. This is not part of the current runtime contract.
