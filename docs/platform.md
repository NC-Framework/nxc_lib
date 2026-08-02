# Platform — nxc_lib

**Target:** FiveM for GTA V Enhanced, Enhanced Cfx Server runtime.

Required by Master Design Document v0.4 section 38.3 and
[`PLATFORM_STANDARDS.md`](https://github.com/NC-Framework/nxc-core-governance/blob/main/standards/PLATFORM_STANDARDS.md).
All eight items are answered. **`None` is written where it applies** — an empty section is a claim that
someone looked and found nothing, and an absent section is not.

`nxc_lib` is the shared foundation: results, errors, correlation identifiers, time, serialization, validation, RPC envelopes, rate limiting, cancellation, logging, locales, permissions, health, and configuration schema.

---

### 1. Enhanced natives and platform APIs used

**None.** Every module in `shared/` is pure Lua. This is verifiable rather than asserted: the whole resource loads and runs under `wasmoon`, which provides Lua 5.4 and nothing else — no `GetPlayerPed`, no `TriggerClientEvent`, no platform at all. A native anywhere in this resource would fail 109 tests immediately.

### 2. Deprecated or compatibility-only natives used

**None.**

### 3. Game assets, archetypes, metadata, or data files required

**None.** No streamed assets, archetypes, metadata, or data files.

### 4. Voice, networking, state bag, entity, and routing bucket assumptions

**None of its own.** `21_envelope.lua` defines the RPC envelope format but does not transmit it; transport belongs to the caller. Nothing here reads or writes a state bag, owns an entity, or allocates a routing bucket.

**Voice:** no involvement. Voice is `nxc_voice`, which does not exist yet.

### 5. Known Enhanced platform limitations

**None known.** With no platform surface there is nothing for a platform change to break. That is the point of keeping this resource native-free, and it is why the Enhanced decision cost this resource nothing.

### 6. Minimum supported Cfx Server build

**Not pinned.** No build has been named — OD-020, blocker B-11. The manifest declares `UNPINNED`, which
fails `check-manifests.mjs` deliberately rather than passing with a plausible-looking number.

### 7. Asset conversion or validation requirements

**None.**

### 8. Optional Legacy compatibility layer

**None.** Nothing here is platform-specific, so nothing here needs an adapter.
