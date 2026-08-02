fx_version 'cerulean'
game 'gta5'

-- Platform target. MDD v0.4 section 38.3 requires every resource to declare its
-- Enhanced compatibility in its manifest; ADR-0016 records the decision.
--
-- These are first-party metadata keys rather than CitizenFX directives. An
-- arbitrary top-level key becomes resource metadata readable through
-- GetResourceMetadata, so the mechanism is supported; whether the platform
-- offers an official directive for this has not been verified, and is open as
-- OD-021 rather than assumed either way.
--
-- nxc_min_server_build is the Enhanced Cfx Server build this was first deployed
-- against, reported as `b106-ea` on 2026-08-02. OD-020 and blocker B-11 closed.
--
-- NOT expressed as a `/server:106` dependency constraint, which is the mechanism
-- the platform enforces. That constraint compares build numbers, and Legacy
-- numbers them far HIGHER — around 25770 — so `/server:106` passes trivially on
-- Legacy and guards nothing. It is added when a resource actually needs a
-- specific Enhanced build, where it would buy something.
nxc_platform 'gta5_enhanced'
nxc_min_server_build '106'
nxc_legacy_compatibility 'none'

author 'The Nexus Core Framework team'
description 'Shared primitives for Nexus Core: result and error types, correlation, validation, logging, RPC envelopes, rate limiting.'
version '0.1.0'

shared_scripts {
    'shared/*.lua',
}

files {
    'locales/*.json',
}
