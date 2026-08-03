# Changelog

Entries are added only for genuinely user-visible or contract-relevant changes.

## 0.3.0 — 2026-08-03

Contract version 3.

### Added

- `Nxc.plain`, a deep copy with real keys of its own, for values crossing a
  resource boundary.

  **A frozen table is raw-empty.** `Nxc.freeze` returns
  `setmetatable({}, { __index = t })`, so the contents are reachable only through
  the metatable: `pairs` sees them because of `__pairs`, `next` does not, and
  neither does any serialiser. Every `Result` is frozen, so every export
  returning one sent `{}` — the caller saw no `ok` field and reported failure
  while the producer logged success. Found on a real server, where nxc_config
  logged a registration as accepted in the same tick nxc_core logged it as
  refused.

  Nothing in-process needs this, which is why no test caught it: within one Lua
  state the metatable works perfectly.

### Fixed

- `Nxc.VERSION` is read from the manifest instead of being a second literal. The
  two had already drifted — the manifest said 0.2.0 and the namespace said
  0.1.0.

### Tests

- Six tests covering raw-emptiness and `Nxc.plain`, using `next` rather than
  `pairs` so they see what a serialiser sees. 119 total.

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
