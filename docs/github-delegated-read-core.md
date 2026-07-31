# Guarded delegated GitHub read core

This slice advances issue #585 with a provider-neutral admission and receipt boundary for long-tail GitHub reads.

## Admission order

A delegated read proceeds only after all of these checks pass:

1. the caller supplies the exact current curated catalogue fingerprint;
2. the requested capability exists, is searchable, read-only, repository-scoped, and delegated;
3. the capability belongs to the explicit initial contracted tool subset;
4. the exact caller-supplied tool bytes and arguments pass that tool's closed contract;
5. caller arguments contain no repository selector because the repository comes from Stensibly authority;
6. `fetch_file` carries one full 40-hex commit identity, never an omitted or mutable ref;
7. the project has a current accepted project attachment that declares the canonical repository;
8. the project has an active binding for that repository;
9. the binding's project, repository, attachment ID, and attachment snapshot digest match the current accepted attachment;
10. the binding resolves to an active Stensibly-owned GitHub provider connection with the exact connection identity;
11. the connection's canonical repository selection includes the requested repository;
12. delegated-read authority allows the exact project, repository, tool, actor, client, and catalogue identity.

Every admission failure keeps adapter dispatch at zero.

## Initial contracted subset

The first provider-neutral contract release enables only:

- `get_repo`;
- `fetch_file`;
- `get_pr_info`;
- `get_pr_diff`;
- `list_pull_request_review_threads`;
- `get_commit_combined_status`;
- `fetch_commit_workflow_runs`;
- `fetch_workflow_run_jobs`;
- `fetch_workflow_job_steps`;
- `fetch_workflow_job_logs`.

Other catalogue entries remain discoverable according to their curation tier while delegated execution stays denied until each tool receives an exact input contract and provider-result verification.

## Adapter boundary

The adapter receives the exact tool, frozen contracted arguments, repository, connection and installation identity, protected credential reference, and catalogue fingerprint. The credential reference stays inside the provider boundary and is omitted from the returned receipt.

The production adapter must inject the repository argument required by the selected downstream GitHub tool. Caller input cannot override it. The adapter must mint a short-lived installation credential narrowed to the accepted repository and required permission profile.

The returned provider value passes a descriptor-based JSON admission walk before hashing or receipt publication. The service accepts only plain objects and default-prototype dense arrays with own enumerable data properties, rejects accessors without invocation, rejects hidden, symbolic, inherited, decorated, non-finite, oversized, or excessively deep values, and deeply freezes the admitted result graph. Tool-specific result and repository-identity checks remain required in the hosted adapter slice.

## Receipt

A successful call returns a frozen receipt binding:

- project and repository;
- tool, actor, and client;
- connection, installation, binding, and current accepted attachment identity;
- capability grant and approval identity when present;
- catalogue fingerprint;
- SHA-256 identities for canonical parameters and result;
- bounded provider request identity;
- the deeply frozen validated read result.

## Current fence

This core has no public MCP registration, durable receipt store, hosted connection persistence, credential creation, provider network adapter, write dispatch, deployment, or live-state change. `delegatedDispatchEnabled` remains false.

The next slice can mount a production read adapter only after the typed GitHub App provider path lands. Public `github_call_tool` registration follows exact adapter conformance, result verification, credential redaction, and deployed smoke tests for the initial subset.
