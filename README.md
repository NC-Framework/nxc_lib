# `nxc_lib`

Shared primitives for Nexus Core: result and error types, correlation, validation, logging, RPC envelopes, rate limiting.

> **Status: In development.** Phase 1 foundation resource. Contracts are unstable until version 1.0.0.
> This resource is not ready for production use.

| | |
| --- | --- |
| **Version** | 0.1.0 |
| **Phase** | 1 — Framework Foundation |
| **Owns** | Nothing. Shared primitives only. |
| **Licence** | **None selected.** No licence grant is offered or implied |

## Dependencies

None. This resource is the root of the dependency graph.

## Installation

Not yet installable. Nexus Core resources are installed as a compatibility set rather than
individually, and no set has been published.

## Configuration

Operational configuration is registered with `nxc_config` and edited in game. Static files carry only
bootstrap values, committed as blank placeholders for an operator to fill in on the server.

## Documentation

- Reference: <https://nxcframework.net>
- Governance, standards, and the development plan: `NC-Framework/nxc-core-governance`

## Development

Read the development plan and the definition of done in the governance repository before contributing.
Both are enforced.

```bash
npm install
npm test
```

## Project

- Homepage: <https://nxcframework.net>
- Development team: The Nexus Core Framework team

## Version compatibility

Below `1.0.0`, minor version increments may carry breaking changes. Pin an exact version.
