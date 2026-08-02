# `nxc_lib` — Performance Budget

Every resource declares a budget before it is considered complete.

> **These figures are estimates, not measurements.** No target server build, OneSync mode, concurrent
> player count, or development environment has been identified, so nothing here has been measured
> against a real server. Recording an estimate as a measurement would be worse than recording nothing.
>
> Recalibration is required once an environment exists.

---

## The ten dimensions

| Dimension | Budget | Basis |
| --- | --- | --- |
| **Idle client CPU** | **0.00 ms/frame** | `nxc_lib` registers no thread, no tick, and no event handler. It is a library, not a running system. This one is not an estimate — there is nothing to run. |
| **Active client CPU** | Attributed to the caller | Its cost is whatever a caller does with it. The hot paths are serialization and validation, both bounded below. |
| **Server tick impact** | **0.00 ms/tick** | Same reason: no thread, no tick. |
| **Maximum event frequency** | n/a | Emits no events. Defines envelope shapes; transport belongs to the resources using them. |
| **Maximum payload size** | **32 KiB** per envelope | `Envelope.MAX_BYTES`, configurable between 4 KiB and 128 KiB. Enforced at the boundary before a transport sees it. |
| **Queries per action** | **0** | Persists nothing and owns no tables. |
| **Cache policy** | None | Holds no cache. Rate-limit buckets are state, not cache, and are pruned. |
| **NUI memory** | n/a | Ships no NUI. |
| **Entity-scan scope** | None | Scans no entities. |
| **Degraded mode** | See below | |

## Where the cost actually is

Three call paths do real work and are worth knowing about.

### Validation — `Nxc.Validate.against`

Walks the payload once per field plus once per key for the unknown-key check. Bounded by:

| Bound | Value |
| --- | --- |
| Maximum nesting depth | 8 |
| Maximum string length | 4096 characters |
| Maximum table keys | 256 |

Cost is proportional to payload size, and payload size is bounded by the envelope ceiling. **A deeply
nested or oversized payload is rejected rather than walked**, which is what stops an attacker choosing
the cost.

### Serialization — `Nxc.Serialize.redact` and `approximateSize`

Both walk the value once, depth-limited to 8. `redact` allocates a copy, so it is the more expensive of
the two and is called only on the logging path.

`approximateSize` deliberately estimates rather than serializing, because computing an exact length would
mean serializing twice to enforce a ceiling.

### Rate limiting — `Limiter:allow`

Constant time: one table lookup and one arithmetic refill. No iteration.

**The growth risk is the bucket table**, not the call. One entry per key that has ever called the
operation, which on a long-running server means one per actor forever.

Mitigated by `Limiter:forget(key)` on disconnect and `Limiter:prune(idleMs)`, which drops idle buckets
that have refilled to capacity. **A resource that calls neither has a slow leak**, not an obvious
failure — which is the kind that survives to production.

## Degraded-mode behaviour

`nxc_lib` has no dependencies and cannot itself be degraded. What it does under pressure:

| Condition | Behaviour |
| --- | --- |
| Oversized envelope | Rejected at the boundary with `NXC_LIB_PAYLOAD_TOO_LARGE`. Never truncated and forwarded. |
| Malformed envelope | Rejected with `NXC_LIB_MALFORMED_ENVELOPE`. |
| Rate limit exceeded | Structured error with a retry-after hint. **Never a silent drop** — a caller that cannot distinguish denial from loss retries forever. |
| Logging sink failing | Caught. A log failure degrades diagnosis; it does not fail the operation. |
| Configuration not yet registered | Runs on declared defaults, which are part of the schema. Defined behaviour, not a fallback. |

## Measured so far

| Measurement | Value | Conditions |
| --- | --- | --- |
| Full test suite | ~330 ms | 109 tests, 14 suites, `wasmoon` under Node 24 |
| Engine startup | milliseconds | WASM instantiation per test file |

This is a test-harness figure and says nothing about in-game cost. It is recorded because it is real,
and because it is the only performance number this resource currently has.

## What must be measured before this budget is trustworthy

1. **Actual network-event payload limit.** ADR-0004 records this as unresolved. The 32 KiB ceiling is
   conservative, not derived — it must be measured during Phase 1.
2. **Validation cost against representative payloads** on a real server.
3. **Rate-limit bucket growth** at expected concurrency, to size the prune interval.
4. **Redaction cost on the logging path** at production log volume.

Until then, every figure above is an estimate that says so.
