# `nxc_lib` — Threat Model

Every resource addresses the sixteen threats in the project security standards, stating for each either
how it is handled or why it does not apply.

## What makes this resource unusual

`nxc_lib` **owns no domain, persists nothing, and exposes no network surface.** It cannot be attacked
directly: it has no event handler, no RPC endpoint, and no table.

That does not make it low risk. **Every resource depends on it**, so a defect in validation, redaction,
or rate limiting is a defect everywhere at once. Its exposure is indirect and wide rather than direct
and narrow, which is why its test coverage is disproportionate to its size.

---

## The sixteen threats

| Threat | Handling |
| --- | --- |
| **Event spoofing** | Not directly exposed — no handlers. Provides `Envelope.validate`, which is the single point where every received envelope is checked, so the assumption that network input is attacker-controlled is enforced once rather than per call site. |
| **Replay attacks** | Provides the idempotency key field in the envelope and correlation identity. Replay *detection* belongs to the owning resource, which holds the key store. |
| **Permission bypass** | `Permissions.has` **denies when no resolver is installed** and **denies unregistered capabilities**. A permission system that fails open is worse than none, and a typo in a capability name must not become an open door. |
| **Duplicate rewards** | `Errors.timeout` requires an explicit idempotency flag rather than defaulting one. The caller is the only party that knows whether a retry is safe, and defaulting would make the dangerous case the quiet one. |
| **Inventory duplication** | Not applicable — owns no items. Supplies the idempotency and result primitives the owning resource uses. |
| **Financial duplication** | Not applicable — owns no money. `Time.formatMoney` **rejects a fractional minor unit** rather than rounding, because a fraction means an arithmetic bug upstream. |
| **Vehicle cloning** | Not applicable. |
| **NUI callback replay** | Not applicable — ships no NUI. The envelope validation used by NUI-facing resources applies equally to callbacks. |
| **Malformed payloads** | The central concern. `Validate.against` checks presence, type, range, and shape; **rejects unknown keys** rather than ignoring them; and catches NaN and infinity explicitly, because NaN fails every comparison and would otherwise pass a range check. |
| **Unauthorized record access** | Not applicable — holds no records. |
| **Entity creation abuse** | Not applicable. |
| **Resource restart behaviour** | Holds no persistent state. Rate-limit buckets and cancellation tokens are in-memory and are correctly lost on restart — a lost bucket resets a limit, which is safe; a lost token is a cancelled operation, which callers already handle. |
| **Disconnect during transactions** | Cancellation tokens evaluate their deadline **on read** rather than by timer, so a token is correct without anything being scheduled. Cancelling is idempotent, because a cleanup path that runs twice releases twice. |
| **Race conditions** | Rate limiting is constant-time with no iteration over shared state. No shared mutable state crosses a boundary: results and errors are frozen. |
| **External service failures** | Provides timeout and cancellation primitives with bounded semantics. The logging sink is wrapped so a failing sink cannot take the caller down. |
| **Rate-limit abuse** | Token bucket rather than fixed window, so a caller cannot send a full window at the end of one and again at the start of the next. Buckets prune, so the table cannot grow without bound. |

---

## Specific decisions worth stating

### Redaction happens at the call site

`Serialize.redact` is applied where the log call is made, not at the sink.

A value that reaches the log pipeline has already left the process, and a downstream filter is one
misconfiguration away from failing. Redaction matches keys case-insensitively against a deliberately
broad list: **a false positive costs a redacted debug field, a false negative costs a rotation.**

Functions, userdata, and threads are never emitted — they can close over anything.

### Errors carry two views

`Errors.toPlayer` strips `details` and `resource`.

`details` is written for operators and may name internal fields, capabilities, and thresholds. Sending a
raw error to a client discloses all of it, so `Envelope.failure` uses the player view and there is no
path that sends the full error outward.

### Correlation identifiers arriving over the network are validated

An attacker-supplied correlation id reaches log records and audit trails. An unvalidated one can make a
later search return the wrong operation — which corrupts an investigation rather than the system, and is
harder to notice.

`Correlation.coerce` accepts a well-formed id for continuity and silently replaces a malformed one.

### The envelope ceiling is conservative and configurable

`Envelope.MAX_BYTES` is 32 KiB. ADR-0004 records that the practical network-event payload limit was
**not measured** before the decision was accepted.

Until it is measured, this bounds the surface rather than assuming a value. An oversized payload is
rejected at the boundary rather than handed to a transport that may truncate it silently — a truncated
payload that still parses is worse than a rejected one.

### Validation is not authorization

Stated because it is the mistake this module could most easily encourage. A well-formed request from an
actor without the capability is a **valid payload and a forbidden action**. Both checks are required, in
that order, and `Validate.against` performs only the first.

---

## What this resource does not defend against

Stated plainly, because a threat model that claims completeness is misleading:

- **A caller that ignores it.** Nothing here forces a resource to validate its input, check a capability,
  or propagate a correlation id. These are primitives, not enforcement.
- **A caller that logs a secret directly.** Redaction runs when `Nxc.Logger` is used. A resource calling
  `print` bypasses it entirely.
- **A caller that treats a client-supplied result as fact.** The library cannot know which values came
  from a client.
- **Anything requiring persistent state.** Replay detection, idempotency storage, and audit trails all
  need a store, which belongs to the owning resource.

The last point matters most: **`nxc_lib` supplies the shapes, and the owning resources supply the
enforcement.** A correct library with careless callers is an insecure system.
