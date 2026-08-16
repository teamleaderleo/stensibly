# CI browser evidence profile

Issue: #667  
Related pull request: #669  
Version: `ci-browser-evidence-profile/v1`

## Purpose

The browser evidence profile owns the browser-specific acceptance commands without changing the six-command `ci-validation-profile/v1` core receipt.

The exact ordered browser commands are:

1. `browser-typecheck` — strict TypeScript validation for the Playwright configuration, tests, server, launcher, and artifact verifier;
2. `browser-tests` — one-worker, zero-retry Chromium execution against loopback fixture routes;
3. `browser-artifacts` — success-only verification of path-backed PNG and JSON evidence before retention.

## Reviewed topologies

`full_parallel` executes the three browser commands in the required `browser-evidence` adjunct job beside the core `test` and `runtime-parity` jobs.

For pull requests, those three jobs independently validate the exact head, and the repository-test job attests its Git tree. The required `serial-full` job checks the synthetic merge revision. It skips the duplicate command set only when that exact-head tree is byte-identical to the synthetic merge tree; otherwise it runs the full serial suite against the merge revision. The exact-head browser artifact remains the retained browser evidence on the reuse path.

`serial_full` executes the same three commands inside the required `serial-full` job on its single hosted runner. The standalone `browser-evidence` job is skipped for that dispatch profile.

Both topologies bind the same candidate revision and preserve the exact-SHA dispatch guard. A successful core receipt alone never implies browser acceptance; browser evidence is a separate required receipt.

## Measured pull-request cutover

On 2026-08-16, 149 recent completed non-main pull-request CI runs yielded 138 complete four-job cohorts. In all 58 cohorts where the three parallel jobs succeeded, `serial-full` also succeeded; no serial-only failure was observed. Median successful job durations were 58 seconds for browser evidence, 65 seconds for repository tests, 15 seconds for runtime parity, and 115 seconds for the duplicate serial job.

That observation supports the byte-identical reuse path above. It does not declare serial and parallel execution universally equivalent: missing or invalid attestations and a different synthetic-merge tree still run the complete serial gate, and the manually requested `serial_full` profile remains unchanged.

## Retention boundary

Evidence uploads only after Chromium and the artifact verifier both succeed. Failed runs may create local screenshots and compressed traces for ephemeral diagnosis; CI retains none of those browser files.

## Recovery

Remove this contract and its workflow regression, then remove the browser commands from canonical CI. The core queue-receipt contract remains unchanged.
