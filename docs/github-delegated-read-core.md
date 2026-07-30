# Guarded delegated GitHub read core

This slice advances issue #585 with a provider-neutral admission and receipt boundary for long-tail GitHub reads.

## Admission order

A delegated read proceeds only after all of these checks pass:

1. the caller supplies the exact current curated catalogue fingerprint;
2. the requested capability exists, is searchable, read-only, repository-scoped, and delegated;
3. the project has an active binding for the canonical repository;
4. the binding resolves to an active Stensibly-owned GitHub provider connection;
5. the connection's repository snapshot includes the requested repository;
6. delegated-read authority allows the exact project, repository, tool, actor, client, and catalogue identity;
7. arguments fit bounded canonical JSON limits.

Every failure before step 7 keeps adapter dispatch at zero.

## Adapter boundary

The adapter receives the exact tool, canonical arguments, repository, connection and installation identity, protected credential reference, and catalogue fingerprint. The credential reference stays inside the provider boundary and is omitted from the returned receipt.

The returned provider value must be canonical JSON within the result bound. The service rejects malformed, non-finite, oversized, or excessively deep provider results.

## Receipt

A successful call returns a frozen receipt binding:

- project and repository;
- tool, actor, and client;
- connection, installation, binding, and accepted attachment identity;
- capability grant and approval identity when present;
- catalogue fingerprint;
- SHA-256 identities for canonical parameters and result;
- bounded provider request identity;
- the validated read result.

## Current fence

This core has no public MCP registration, durable receipt store, hosted connection persistence, credential creation, provider network adapter, write dispatch, deployment, or live-state change.

The next slice can mount a fake adapter in the provider conformance lab, then add a read-only `github_call_tool` action only after hosted connection and binding persistence expose this service through the production ledger.
