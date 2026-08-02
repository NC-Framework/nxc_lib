# Changelog

Entries are added only for genuinely user-visible or contract-relevant changes.

## Unreleased

Initial implementation of the shared foundation primitives.

### Added

- Structured result and error types, with a fixed project-wide error shape.
- Correlation identifier generation, derivation, and validation.
- Schema validation that rejects unknown keys and catches NaN and infinity.
- The RPC and event envelope, with a 32 KiB size ceiling enforced at the boundary.
- A token-bucket rate limiter with pruning.
- Cancellation tokens that evaluate their deadline on read rather than by timer.
- Safe serialization with call-site redaction of sensitive keys.
- Logging, localization, capability-check, and resource health interfaces.
- Time, duration, and integer-minor-unit money formatting.
- A configuration schema declaring seven fields, with an injectable registrar.
- 109 tests across 14 suites, running Lua 5.4 under WebAssembly.
- A performance budget and a threat model.

### Known limitations

- The envelope size ceiling is conservative rather than measured. ADR-0004 records
  the practical network-event payload limit as unresolved.
- Performance figures are estimates; no target environment exists to measure against.
