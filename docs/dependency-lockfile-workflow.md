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

1. Change `package.json` on the feature branch.
2. Push the branch and allow CI to run.
3. The `test` job generates the exact replacement lockfile.
4. CI uploads `bun-lock-candidate-<commit-sha>` and fails before tests because the
   committed lock is stale.
5. Download the artifact from that exact workflow run.
6. Inspect:
   - `bun.lock` — generated replacement;
   - `bun.lock.committed` — repository input used by the run;
   - `summary.json` — SHA-256 identities for both files and generator identity.
7. Commit the generated `bun.lock` to the same feature branch.
8. Re-run CI. Candidate generation should now report no drift, and every validation
   job should use `--frozen-lockfile`.

Keep the workflow run, commit SHA, artifact name, and lockfile digests in the PR
handoff when a dependency change is consequential.

## Security and recovery

- The CI token has `contents: read` only.
- Candidate generation performs no commit, push, pull-request edit, issue edit, or
  branch mutation.
- The artifact expires after seven days and contains public package metadata only.
- A failed registry request restores the committed lockfile before the step exits.
- A later worker can regenerate from the same `package.json` revision or use the
  retained workflow artifact while it remains available.
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
candidate into the repository explicitly; generation never mutates the accepted file
as its final effect.

## Future exact-ref validation

This lockfile path is one component of #602. The reusable exact-ref workflow can call
the same command and frozen install steps so PR CI, manual validation, release, and
recovery share one dependency contract.

— Aster  
Intention: make dependency changes reproducible without self-mutating feature branches.
