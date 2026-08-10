# Guarded delegated GitHub read core

This document describes the provider-neutral admission and receipt boundary for long-tail GitHub reads and the hosted native GitHub App composition currently built on that core.

## Admission order

A delegated read proceeds only after all of these checks pass:

1. the caller supplies the exact current curated catalogue fingerprint;
2. the requested capability exists, is searchable, read-only, repository-scoped, and delegated;
3. the capability belongs to the explicit contracted tool subset;
4. the exact caller-supplied tool and arguments pass that tool's closed contract;
5. caller arguments contain no repository selector because repository identity comes from Stensibly authority;
6. immutable reads carry the exact immutable identity required by their contract;
7. the project has a current accepted project attachment that declares the canonical repository;
8. the project has an active binding for that repository;
9. the binding's project, repository, attachment ID, and attachment snapshot digest match the current accepted attachment;
10. the binding resolves to an active Stensibly-owned GitHub provider connection with the exact connection identity;
11. the connection's canonical repository selection includes the requested repository;
12. delegated-read authority allows the exact project, repository, tool, actor, client, and catalogue identity.

Every admission failure keeps adapter dispatch at zero.

## Contracted read surface

The current delegated-read contract contains ten operations:

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

The hosted composition declares the first eight as the core read set. When job-detail reads are enabled, the declaration extends to all ten and mounts `GitHubRestActionsJobDetailAdapter` for steps and logs. Other catalogue entries may remain discoverable while delegated execution stays denied until each operation has an exact contract, minimum permission profile, bounded provider adapter, and result verification.

## Hosted activation

`STENSIBLY_GITHUB_DELEGATED_READS_ENABLED` and `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED` use the shared exact-boolean environment contract.

When either flag is omitted or empty, it defaults on once hosted GitHub provider configuration is present. Exact `false` remains the recovery switch. Empty provider configuration remains unconfigured, while partial or malformed configuration reaches the provider admission boundary and fails closed.

Public MCP discovery and dispatch remain separate from private provider mounting. A configured GitHub App or mounted adapter grants no caller authority by itself.

## Adapter boundary

The adapter receives the exact admitted tool and frozen arguments plus repository, connection, installation, protected credential reference, and catalogue identity. Repository identity is injected from the accepted Stensibly binding and cannot be overridden by caller arguments.

The hosted path mints a short-lived installation credential narrowed to the accepted repository and the permission profile required by the selected read. Repository, pull-request, commit, workflow, run, job, and provider-request identities are re-admitted according to the specific operation before a result can settle.

Provider responses remain bounded by operation-specific byte, line, pagination, redirect, encoding, and result ceilings. Fixed diagnostics replace unrestricted provider prose. Tokens, authorization headers, credential locators, private target URLs, and unrelated provider content stay outside returned results and receipts.

## Receipt

A successful delegated read returns a bounded receipt binding:

- project and repository;
- tool, actor, and client;
- connection, installation, binding, and current accepted attachment identity;
- capability grant and approval identity when present;
- catalogue fingerprint;
- SHA-256 identities for canonical parameters and result;
- bounded provider request identity;
- the validated retained read result.

The receipt records evidence for the completed read. It grants no later provider authority.

## Current completion gate

The repository contains native adapters and hosted composition for the ten contracted reads. Issue #697 remains the live completion record for the hosted job-detail journey: source capability alone does not prove a deployed authenticated step/log read.

Completion therefore still requires the governed deployment and one attributable hosted `fetch_workflow_job_steps` or `fetch_workflow_job_logs` receipt through the expected project, repository, attachment, connection, and binding. The public dispatch surface stays read-only throughout that proof.
