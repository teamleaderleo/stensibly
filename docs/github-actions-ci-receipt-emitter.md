# Signed GitHub Actions CI receipt compiler

Tracking: #700 under reusable exact-ref validation owner #602.

## Purpose

Compile one compact `CiQueueReceiptV1` from content-minimised, signature-verified GitHub Actions observations. The compiler describes completed canonical CI runs; it schedules no work and grants no merge, retry, deployment, or mutation authority.

This first slice is pure source. A later mount may feed it completed `workflow_run` and `workflow_job` deliveries and publish the resulting receipt through the existing signed observation path.

## Evidence boundary

The input bundle binds:

- exact repository, workflow name, workflow path, run ID, attempt, event, and terminal outcome;
- candidate, base, and workflow-file revisions;
- the actual `full_parallel` or `serial_full` job topology;
- exactly one record for each canonical `test`, `runtime-parity`, and `serial-full` job;
- each job's provider ID, run attempt, candidate revision, requested labels, creation, start, completion, terminal outcome, and bounded step summaries;
- optional diagnostics artifact identities bound to exact run, run attempt, failed job ID, canonical artifact name, and lowercase SHA-256 digest;
- one trusted receipt time.

Job creation time comes from the signed `workflow_job` observation and becomes `queuedAt`. The compiler never derives queue duration from pull-request timestamps, log timestamps, or REST fields that omit queue admission.

For pull-request CI, candidate, base, and workflow-file revisions remain three independent identities. The candidate is the exact pull-request head, the base is the exact pull-request base, and the workflow revision is the provider's exact workflow-file SHA. Push and manual exact-ref runs require the workflow revision to equal the candidate revision. A future mount must verify the provider path and ref before normalising the configured path to `.github/workflows/ci.yml`.

## Canonical topology

`full_parallel` requires `test` and `runtime-parity`; `serial-full` remains skipped. `serial_full` is admitted only for `workflow_dispatch`, requires `serial-full`, and keeps both parallel jobs skipped. All profiles carry the same ordered six-command contract.

A cancelled job may settle before runner assignment. Such a job retains `conclusion: cancelled`, `startedAt: null`, and unknown queue wait. Every job without start evidence must carry zero completed steps. Skipped, action-required, stale, and startup-failure jobs remain no-start-only. A job whose conclusion is not `failure` cannot contain a failed step, so contradictory step evidence never disappears during projection.

The pure Actions bundle records cancellation only. It cannot claim which later revision caused cancellation. A later same-PR provider observation may append that relation after binding repository, pull-request number, prior head, current head, and observation time.

## Privacy and authority

The compiler retains bounded identifiers, timestamps, closed outcomes, requested labels, one failed-step label, and diagnostics digests. It excludes logs, artifact bytes, runner names, provider bodies, URLs, credentials, and arbitrary diagnostics. Credential detection uses bounded real-token forms so ordinary names such as `task-sk-research`, `runner-sk-review`, and `Run sk-review checks` remain valid. Descriptor-bearing, sparse, decorated, symbolic, credential-shaped, cross-run, cross-attempt, cross-job, or contradictory input fails before receipt publication.

Every output remains deeply frozen with:

- `supersededByRevision: null`;
- `queuePosition: unknown`;
- `authorizesMerge: false`;
- `authorizesMutation: false`.

## Mount sequence

The next slice may:

1. collect one completed `workflow_run` and the three matching completed `workflow_job` observations behind the existing signed webhook route;
2. verify exact delivery/run/attempt identities and obtain the exact workflow-file SHA and artifact identities through a read-only provider boundary;
3. call this compiler once with the trusted webhook receipt time;
4. append or upload only the compact canonical receipt and retain external diagnostics by digest;
5. correlate a later same-PR head separately when exact provider evidence proves supersession.

Scheduling, runner admission, retries, and required-check policy remain independent.

## Recovery

Revert the additive compiler commit. Any later mount or durable sink can be disabled independently while previously accepted receipts remain available as historical evidence.
