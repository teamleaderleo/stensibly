# Guarded delegated GitHub read core

This document describes the provider-neutral admission and receipt boundary originally introduced for long-tail GitHub reads, plus the current hosted state built on that core.

## Admission order

A delegated read proceeds only after all of these checks pass:

1. the caller supplies the exact current curated catalogue fingerprint;
2. the requested capability exists, is searchable, read-only, repository-scoped, and delegated;
3. the capability belongs to the explicit contracted tool subset;
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

## Contracted subset

The currently contracted delegated-read surface includes:

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

Other catalogue entries remain discoverable according to their curation tier while delegated execution stays denied until each tool receives an exact input contract, permission profile, bounded provider adapter, and result verification.

## Adapter boundary

The adapter receives the exact tool, frozen contracted arguments, repository, connection and installation identity, protected credential reference, and catalogue fingerprint. The credential reference stays inside the provider boundary and is omitted from the returned receipt.

The production adapter injects the repository argument required by the selected downstream GitHub operation. Caller input cannot override it. It mints a short-lived installation credential narrowed to the accepted repository and required read permission profile.

Provider results still pass bounded structural admission and tool-specific repository/identity verification before receipt publication. The service retains only the content needed for the delegated read and bounded provider evidence; credential material remains outside receipts.

The native REST adapter's caller-input and raw response-intake seams are under additional hardening review. Test-only controls #1258 and #1261 pin canonical response metadata/bytes/JSON handling and closed descriptor-only caller admission. Those controls do not change the public delegated-read contract or grant additional provider access.

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

## Current hosted state

The provider-neutral core is no longer the outer edge of the implementation. Hosted GitHub App connection/binding state, installation-token minting, native read adapters, public delegated-read composition, and the contracted MCP read surface now exist in the repository.

PR #1168 changed activation policy for the two reviewed hosted read switches:

- `STENSIBLY_GITHUB_DELEGATED_READS_ENABLED` defaults on when hosted GitHub provider configuration is present;
- `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED` does the same for job-detail reads;
- exact `false` remains the independent recovery switch for each surface;
- empty configuration remains unconfigured;
- partial or malformed provider configuration still fails closed through provider admission.

This repository state is not the same as hosted acceptance. Issue #697 remains open until a governed deployment and authenticated product journey produce a bounded GitHub job step/log receipt with the expected project/repository/binding attribution. A merge, catalogue declaration, or default-on setting is not a substitute for that live receipt.

Hosted GitHub issue writes remain a separate exact-opt-in mutation surface and are not implied by delegated-read activation.
