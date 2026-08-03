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
version '0.3.1'

-- Scripts are ENUMERATED, in load order, rather than globbed.
--
-- The numeric filename prefixes that used to encode this order are gone: they
-- are not how FiveM resources are normally written, and they put load order in
-- the filesystem where it is easy to break and impossible to comment. The order
-- lives here instead, where it can be read and reasoned about.
--
-- A glob would sort alphabetically, which is not dependency order.
shared_scripts {
    'shared/namespace.lua',
    'shared/result.lua',
    'shared/errors.lua',
    'shared/correlation.lua',
    'shared/time.lua',
    'shared/serialize.lua',
    'shared/validate.lua',
    'shared/envelope.lua',
    'shared/ratelimit.lua',
    'shared/cancel.lua',
    'shared/logger.lua',
    'shared/locale.lua',
    'shared/permissions.lua',
    'shared/health.lua',
    'shared/persistence.lua',
    'shared/migrations.lua',
    'shared/config_schema.lua',
}

files {
    'locales/*.json',
}
