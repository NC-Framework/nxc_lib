# Changelog

Entries are added only for genuinely user-visible or contract-relevant changes.

## 0.4.0 - 2026-08-03

### Fixed

- Shared code no longer requires `os`, which DOES NOT EXIST ON THE FIVEM CLIENT.

  CitizenFX gives the client a reduced standard library. `Nxc.Time` called
  `os.time` and `os.date`, and `Nxc.Correlation` seeded from `os.time`, so all
  three worked on the server and crashed on the client with `attempt to index a
  nil value (global 'os')`.

  It failed twice over in deployment: a UI surface crashed reaching for the
  clock, and the log line reporting that crash crashed as well, inside the
  logger's own timestamp. A diagnostic that cannot report its own failure is
  worse than none.

  No test could have caught it. wasmoon is plain Lua 5.4 with the whole standard
  library, so the test runtime was more capable than the target and certified
  code the target cannot run.

### Changed

- `Time.iso8601` computes the date itself rather than calling `os.date`. One
  implementation that runs on both sides beats a branch only ever exercised on
  one - the untaken branch is where the defect lived.

- The clock is anchored once against `GetGameTimer`, so wall-clock time has
  millisecond resolution instead of jumping whole seconds. A clock that is flat
  between jumps makes every duration measured against it wrong by up to a
  second, which for a rate limiter is the difference between a bound and a
  suggestion.

### Added

- `Time.HAS_WALL_CLOCK`, so a caller needing a real date can ask rather than
  discovering from a timestamp in 1970.

- A client-runtime test mode: `os` and `io` are removed, and shared code is run
  against what the client actually has. Seven tests, verified by reintroducing
  both defects.

## 0.3.1 — 2026-08-03

### Fixed

- The default log sink renders an empty list as `[]` rather than `{...}`, and a
  map as its sorted keys rather than `{...}`.

  `{...}` reads as "there is something here I am not showing you". The first
  deployment where the configuration handshake succeeded logged
  `removedKeys={...}` on a first registration, where nothing had been removed —
  anyone reading it would reasonably conclude fields had vanished from the
  schema. A map now shows its keys and not its values, because the keys are the
  useful part and a value may be something that has no business in a log line.

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
