# Dependency lockfile workflow

Stensibly commits `bun.lock` and validates dependency declarations against it in
canonical CI.

## Ordinary validation

CI performs two separate steps:

1. `bun install --lockfile-only` generates a candidate lockfile through
   `bun run lockfile:check` on the exact pull-request checkout;
2. when the candidate matches the committed file, both validation jobs install with
   `bun install --frozen-lockfile`.

The candidate generator restores the committed `bun.lock` before returning. Tests and
builds therefore use only repository bytes from the exact checkout.

## Adding or changing a dependency

1. Change `package.json` on a same-repository pull-request branch targeting the
   repository default branch.
2. Push the branch and allow CI to run.
3. The `test` job generates the replacement lockfile on GitHub's exact pull-request
   candidate checkout. For pull-request runs this may be a synthetic merge commit.
4. CI uploads `bun-lock-candidate-<pull-request-candidate-sha>` and fails before tests
   because the committed lock is stale.
5. The default-branch `Apply Bun lock candidate` workflow receives the completed run.
6. The writer lists artifacts for that exact run and requires one live candidate name.
   The name supplies the exact pull-request candidate SHA; artifact bytes remain
   unused.
7. The writer asks GitHub for the pull request associated with the exact run and
   requires one result.
8. It fetches the candidate commit and requires the ordinary two-parent pull-request
   merge form: parent one is the validated base and parent two is the feature-head
   lease from `workflow_run.head_sha`.
9. It requires the associated and current PR to remain open on the same repository and
   source branch, target the repository default branch, retain the exact base and head
   parents, and expose the same canonical merge candidate.
10. The writer checks out the exact failed candidate and independently runs
    `bun install --lockfile-only --ignore-scripts` with repository credentials absent.
11. It proceeds only when `bun.lock` is the sole changed path, stores those generated
    bytes in runner-temporary storage, restores the candidate tree, and switches to a
    clean exact feature-head checkout.
12. It copies only the generated `bun.lock` onto the feature head. A candidate already
    identical to the feature-head lock cannot be repaired by another lock-only commit;
    that case requires a PR restack.
13. Immediately before publication, the writer fetches the PR again and repeats the
    open, repository, source/default-base branch, exact base, exact merge candidate, and
    exact feature-head checks.
14. It commits only `bun.lock` as `github-actions[bot]` and pushes with a
    force-with-lease bound to the original feature head.
15. The writer verifies the remote branch equals the generated commit and explicitly
    dispatches canonical CI with that commit SHA as a required input.
16. Both CI jobs compare dispatched `GITHUB_SHA` with the required SHA before
    installation or tests. Candidate generation should report no drift, and every
    validation job uses `--frozen-lockfile`.
17. Inspect the final package/lock diff, exact CI run, bundle result, and runtime parity
    before integration.

Keep the triggering run, failed candidate SHA, validated base, feature-head lease,
generated bot commit, artifact name, lock digests, and dispatched CI run in the PR
handoff when a dependency change is consequential.

## Candidate artifact

The read-only CI artifact remains independent evidence and a manual recovery path. It
contains:

- `bun.lock` — generated replacement;
- `bun.lock.committed` — repository input used by the run;
- `summary.json` — SHA-256 identities for both files and generator identity.

The artifact expires after seven days and contains public package metadata only. The
writer reads only artifact metadata to recover the trusted candidate name. It
independently regenerates the lock and never consumes artifact file bytes as write
input.

## Writer authority and fences

The permanent writer uses default-branch workflow code and receives:

- `actions: write`, limited to dispatching canonical CI;
- `pull-requests: read`;
- `contents: write`, limited by the workflow to one leased feature-branch push.

It accepts only a failed pull-request CI run whose head repository is this repository
and whose source branch differs from the default branch. GitHub may expose a synthetic
merge commit as the PR job's checked-out `GITHUB_SHA`; the workflow-run object's
`head_sha` remains the feature-head identity.

These identities serve separate purposes:

- **triggering run ID** selects the exact failed execution and its artifact catalogue;
- **failed candidate SHA** identifies the exact checkout where CI regenerated the
  stale lock;
- **validated base SHA** is parent one of that candidate;
- **feature-head lease SHA** is parent two and equals `workflow_run.head_sha`;
- **generated commit SHA** is the writer-created child of the feature head;
- **dispatched SHA** must equal the generated commit.

Before regeneration, the writer requires:

- exactly one live artifact named
  `bun-lock-candidate-<40-lowercase-hex-candidate-sha>` for the triggering run;
- exactly one associated pull request;
- an exact candidate commit with two parents;
- candidate parent two equal to the workflow-run feature head;
- associated/current head repository, branch, and SHA equal to the workflow-run
  identity;
- associated/current base repository and branch equal to this repository's default
  branch;
- associated/current base SHA equal to candidate parent one;
- current `merge_commit_sha` equal to the failed candidate SHA.

The candidate checkout receives no persisted Git credentials. Lock generation uses
`bun install --lockfile-only --ignore-scripts`. Any changed path besides `bun.lock`
aborts. The candidate bytes move only through runner-temporary storage before the
workflow checks out the exact feature head and applies that one file.

Because registry resolution can take time, the publication step re-fetches the PR and
requires the same open state, head/base repository identity, source/default-base
branches, candidate base, canonical merge candidate, and exact feature-head lease.
Closing, retargeting, renaming, transferring, advancing, or rebasing the PR during
generation invalidates publication.

The final push targets only the source branch and uses:

```text
--force-with-lease=refs/heads/<branch>:<feature-head-sha>
```

The generated commit is passed to `ci.yml` through a manual dispatch input. CI fails
before dependency installation when the dispatched revision differs from that exact
commit. The dispatched run cannot invoke the writer because the writer accepts only CI
runs whose event was `pull_request`.

A missing or duplicate candidate artifact, zero or multiple associated PRs, malformed
candidate commit, stale base, changed canonical merge, closed PR, fork head/base,
renamed source branch, non-default base, stale feature head, clean candidate lock,
unsupported generated path, candidate already identical to the feature lock, displaced
generated commit, or mismatched dispatched revision produces no accepted publication.

## Security and recovery

- Neither workflow uses repository or provider secrets.
- Read-only candidate generation performs no commit, push, PR edit, issue edit, or
  branch mutation.
- Artifact bytes never become writer input.
- Lock generation resolves metadata without lifecycle scripts.
- Repository credentials are unavailable during dependency resolution.
- Exact run/artifact/commit association prevents unrelated CI failures from
  authorizing a write.
- Exact base and canonical-merge checks prevent obsolete pull-request generations from
  publishing after `main` advances.
- Exact feature-head equality and force-with-lease protect concurrent branch work.
- Publication-time PR revalidation closes slow-registry races.
- Exact-SHA dispatch validation detects branch movement between publication and CI.
- Revert or disable the permanent writer workflow to stop automatic updates.
- A later worker can regenerate from the same candidate revision or use the retained
  CI artifact while it remains available.
- Dependency review still covers package purpose, source, version range, transitive
  footprint, runtime compatibility, licensing, maintenance, and removal path.

## Local use

Run:

```bash
bun run lockfile:check
```

When declarations and the lock agree, the command reports `changed: false` and retains
no artifact directory. When they differ, it writes the candidate packet to:

```text
artifacts/bun-lock-candidate/
```

The command restores the repository lockfile in either case. Copy the reviewed
candidate into the repository explicitly only when the permanent writer is disabled or
unavailable.

## Future exact-ref validation

This lockfile path is one component of #602. A broader reusable exact-ref workflow can
call the same candidate generation and frozen-install steps so PR CI, manual
validation, release, and recovery share one dependency contract and machine-readable
receipt.

— Kestrel · lock-writer repair
  Intention: bind generated lock bytes to the exact failed pull-request candidate while
  preserving a separate feature-head write lease.
