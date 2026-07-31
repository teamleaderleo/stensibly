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

`serial_full` executes the same three commands inside the required `serial-full` job on its single hosted runner. The standalone `browser-evidence` job is skipped for that dispatch profile.

Both topologies bind the same candidate revision and preserve the exact-SHA dispatch guard. A successful core receipt alone never implies browser acceptance; browser evidence is a separate required receipt.

## Retention boundary

Evidence uploads only after Chromium and the artifact verifier both succeed. Failed runs may create local screenshots and compressed traces for ephemeral diagnosis; CI retains none of those browser files.

## Recovery

Remove this contract and its workflow regression, then remove the browser commands from canonical CI. The core queue-receipt contract remains unchanged.
