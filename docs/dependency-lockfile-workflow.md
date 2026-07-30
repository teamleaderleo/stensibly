# Dependency lockfile workflow

Stensibly commits `bun.lock` and validates dependency declarations against it in
canonical CI.

## Ordinary validation

CI performs two separate steps:

1. `bun install --lockfile-only` generates a candidate lockfile through
   `bun run lockfile:check`;
2. when the candidate matches the committed file, both validation jobs install with
   `bun install --frozen-lockfile`.

The candidate generator always restores the committed `bun.lock` before returning.
Tests and builds therefore use only the reviewed repository file.

## Adding or changing a dependency

1. Change `package.json` on a same-repository pull-request branch.
2. Push the branch and allow CI to run.
3. The `test` job generates the exact replacement lockfile.
4. CI uploads `bun-lock-candidate-<workflow-sha>` and fails before tests because the
   committed lock is stale.
5. The permanent `Apply Bun lock candidate` workflow receives the completed CI run.
6. The writer verifies one open same-repository pull request at the exact triggering
   head, checks out that branch, and independently runs
   `bun install --lockfile-only --ignore-scripts` from reviewed default-branch
   workflow code.
7. The writer proceeds only when `bun.lock` is the sole changed path, commits that
   file as `github-actions[bot]`, and pushes with a force-with-lease bound to the
   triggering head SHA.
8. The writer verifies the remote branch equals the generated commit and explicitly
   dispatches canonical CI with that commit SHA as a required input.
9. Both CI jobs compare the dispatched `GITHUB_SHA` with the required SHA before
   installation or tests. Candidate generation should then report no drift, and every
   validation job should use `--frozen-lockfile`.
10. Inspect the final package and lock diff, exact CI run, bundle result, and runtime
    parity before integration.

Keep the triggering and successful workflow runs, pull-request head, generated bot
commit, artifact name, and lockfile digests in the PR handoff when a dependency
change is consequential.

## Candidate artifact

The read-only CI artifact remains independent evidence and a manual recovery path.
It contains:

- `bun.lock` — generated replacement;
- `bun.lock.committed` — repository input used by the run;
- `summary.json` — SHA-256 identities for both files and generator identity.

The artifact expires after seven days and contains public package metadata only.

## Writer authority and fences

The permanent writer uses default-branch workflow code and receives:

- `actions: write`, limited to dispatching canonical CI;
- `pull-requests: read`;
- `contents: write`, limited by the workflow to one leased feature-branch push.

It accepts only a failed pull-request CI run whose head repository is this repository
and whose head branch differs from the default branch. Before checkout, it requires
exactly one open pull request for the source branch and requires that PR's current
head SHA to equal the triggering workflow head SHA.

After checkout it verifies the same SHA and a clean worktree. Checkout credentials and
the GitHub token are absent during package resolution. It generates the lock directly
with `bun install --lockfile-only --ignore-scripts`; artifact bytes are never used as
write input. Any changed path besides `bun.lock` aborts publication. The final push
targets only the source branch and uses:

```text
--force-with-lease=refs/heads/<branch>:<triggering-head-sha>
```

The generated commit is then passed to `ci.yml` through a manual dispatch input. CI
fails before dependency installation when the dispatched revision differs from that
exact commit. The dispatched run cannot invoke the writer again because the writer
accepts only CI runs whose event was `pull_request`.

A closed pull request, fork branch, default branch, advanced head, duplicate matching
pull request, clean lockfile, unsupported generated path, displaced generated commit,
or mismatched dispatched revision produces no accepted validation result. Every
successful update remains an ordinary reviewable commit followed by the full frozen
CI gate.

## Security and recovery

- Neither workflow uses repository or provider secrets.
- Read-only candidate generation performs no commit, push, pull-request edit, issue
  edit, or branch mutation.
- The writer regenerates from package declarations and never copies artifact bytes.
- Lock generation resolves metadata without installing dependencies or executing
  package lifecycle scripts.
- Repository credentials are unavailable during dependency resolution.
- A failed registry request leaves the branch unchanged.
- Force-with-lease protects concurrent branch work.
- Exact-SHA dispatch validation detects a branch advance between publication and CI.
- Revert or disable the permanent writer workflow to stop automatic updates.
- A later worker can regenerate from the same `package.json` revision or use the
  retained CI artifact while it remains available.
- Dependency review still covers package purpose, source, version range, transitive
  footprint, runtime compatibility, licensing, maintenance, and removal path.

## Local use

Run:

```bash
bun run lockfile:check
```

When declarations and the lock agree, the command reports `changed: false` and
retains no artifact directory. When they differ, it writes the candidate packet to:

```text
artifacts/bun-lock-candidate/
```

The command restores the repository lockfile in either case. Copy the reviewed
candidate into the repository explicitly only when the permanent writer is disabled
or unavailable.

## Future exact-ref validation

This lockfile path is one component of #602. The broader reusable exact-ref workflow
can call the same generation and frozen-install steps so PR CI, manual validation,
release, and recovery share one dependency contract and machine-readable receipt.

— Aster  
Intention: make dependency changes reproducible without self-mutating feature branches.
