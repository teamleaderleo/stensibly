# Signed GitHub Actions CI receipt compiler

Tracking: #700 under reusable exact-ref validation owner #602.

## Purpose

Compile one compact `CiQueueReceiptV1` from content-minimised, signature-verified GitHub Actions observations. The compiler describes completed canonical CI runs; it schedules no work and grants no merge, retry, deployment, or mutation authority.

This first slice is pure source. A later mount may feed it completed `workflow_run` and `workflow_job` deliveries and publish the resulting receipt through the existing signed observation path.

## Evidence boundary

The input bundle binds:

- exact repository, workflow name, workflow path, run ID, attempt, event, and terminal outcome;
- candidate, base, and workflow-file revisions as independent identities;
- the active `full_parallel` or `serial_full` topology;
- exactly one record for `browser-evidence`, `test`, `runtime-parity`, and `serial-full`;
- each job's provider ID, run attempt, candidate revision, requested labels, creation, start, completion, terminal outcome, and bounded step summaries;
- diagnostics artifact identities bound to exact run, run attempt, failed canonical job ID, canonical artifact name, and lowercase SHA-256 digest;
- one trusted receipt time.

Job creation time from the signed `workflow_job` record becomes `queuedAt`. The compiler never derives queue duration from pull-request timestamps, log timestamps, or REST fields that omit queue admission.

For pull-request CI, candidate, base, and workflow-file revisions remain three independent identities. Push and manual exact-ref runs require the workflow revision to equal the candidate revision. A future mount must verify provider path and ref before normalising the configured path to `.github/workflows/ci.yml`.

## Canonical topology

The compiler imports `ci-browser-evidence-profile/v1` rather than copying browser command vocabulary.

- `full_parallel` binds the core six-command contract plus `browser-typecheck`, `browser-tests`, and `browser-artifacts`.
- Pull-request runs retain all four active jobs, including exact-head `serial-full` validation.
- Push runs retain `browser-evidence`, `test`, and `runtime-parity`, with `serial-full` skipped.
- `serial_full` is admitted only for `workflow_dispatch`; browser commands run inside `serial-full` while the three parallel jobs remain skipped.

A `failure`, `timed_out`, or `neutral` run requires a matching conclusion from an active-profile job. Browser-only failures therefore remain visible. All-skipped/no-start topology remains available only to terminal outcomes that genuinely permit zero execution.

A cancelled job may settle before runner assignment. Such a job retains `conclusion: cancelled`, `startedAt: null`, and unknown queue wait. Every job without start evidence must carry zero completed steps. A job whose conclusion is not `failure` cannot contain a failed step.

The pure Actions bundle records cancellation only. It always emits `supersededByRevision: null`; a later same-PR provider observation may append causality only after binding repository, pull-request number, prior head, current head, and observation time.

## Privacy and authority

The compiler retains bounded identifiers, timestamps, closed outcomes, requested labels, one failed-step label, and diagnostics digests. It excludes logs, artifact bytes, runner names, provider bodies, URLs, credentials, and arbitrary diagnostics.

Credential detection uses delimiter-aware realistic token lengths. Ordinary names such as `task-sk-proj-research`, `runner-sk-proj-review`, and `Run sk-proj-review checks` remain valid, while realistic GitHub, Stensibly, OpenAI, Slack, bearer, JWT, `env://`, and `secret://` forms fail with fixed diagnostics.

Every output remains deeply frozen with:

- `supersededByRevision: null`;
- `queuePosition: unknown`;
- `authorizesMerge: false`;
- `authorizesMutation: false`.

## Mount sequence

A later slice may collect the signed run and four matching jobs, verify exact workflow and artifact identities through a read-only provider boundary, compile once with trusted time, and retain only the compact receipt plus external diagnostics digests. Scheduling, runner admission, retries, required-check policy, and same-PR supersession remain independent.

## Recovery

Revert the additive compiler commit. Any later mount or durable sink can be disabled independently while previously accepted receipts remain historical evidence.
