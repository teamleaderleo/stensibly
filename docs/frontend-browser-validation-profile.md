# Frontend browser validation profile

**Owner:** #667  
**Related:** #618, #669, `ci-validation-profile/v1`

## Identity

The browser evidence adjunct is `browser-evidence/v1`.

Its exact merge-critical command identities are:

1. `browser-typecheck` — `bun run typecheck:browser`;
2. `browser-tests` — `bun run test:browser`;
3. `browser-artifacts` — `bun run verify:browser-artifacts`.

`scripts/browser-evidence-validation-profile.ts` owns this identity and command order. The existing `ci-validation-profile/v1` receipt continues to own the six core repository commands.

## Full-parallel topology

Pull requests, pushes, and exact-SHA `full_parallel` dispatches execute `browser-evidence/v1` in the dedicated `browser-evidence` job. That job installs the committed dependencies and exact Chromium revision, runs browser TypeScript, executes Playwright with one worker and zero retries, applies the artifact privacy fence, and uploads evidence only after both browser execution and artifact verification succeed.

## Serial-full topology

An exact-SHA `serial_full` dispatch skips the parallel `browser-evidence`, `test`, and `runtime-parity` jobs. The single `serial-full` runner installs committed dependencies and Chromium once, then runs the six core gates plus all three `browser-evidence/v1` commands through the failure-aggregating gate function.

The serial upload executes only after every core and browser gate succeeds. Failure diagnostics retain browser typecheck, browser execution, and artifact-verifier text while Playwright result bytes remain ephemeral.

## Evidence boundary

Both topologies use the same package lock, Playwright 1.62.0, Chromium revision, fixture server, planner cases, network and worker denial, browser-error fence, successful PNG/JSON receipts, and artifact verifier. Retained evidence is fictional, content-minimised, credential-free, and inspectable for seven days.

## Acceptance receipt

A merge candidate requires one unchanged exact head with:

- a green full-parallel browser adjunct;
- a green exact-SHA `serial_full` run containing the same three adjunct command identities;
- CodeRabbit success and empty review threads;
- verified artifact bytes and job duration recorded in the pull request and lane issues.

## Recovery

Remove `browser-evidence/v1`, its workflow gates, focused regression, and this document. The six-command core validation profile remains independently owned.
