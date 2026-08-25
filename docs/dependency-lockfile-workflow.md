# Dependency lockfile workflow

Stensibly commits `bun.lock` and validates dependency declarations against it in canonical CI.

## Ordinary validation

CI generates a candidate lock with `bun run lockfile:check`. When the candidate matches the committed file, validation installs with `bun install --frozen-lockfile`.

The candidate generator restores the committed `bun.lock` before returning. Tests and builds therefore consume only reviewed repository bytes.

## Adding or changing a dependency

1. Change `package.json` on a same-repository pull-request branch.
2. Push the branch and let canonical CI run.
3. The CI lock check independently generates the replacement. When the committed lock is stale, it publishes the bounded `bun-lock-candidate-<validated-revision>` evidence packet and fails before ordinary validation.
4. The permanent `Apply Bun lock candidate` workflow consumes only the completed CI run identity. It never uses artifact bytes as write input.
5. The writer requires one current open same-repository pull request whose branch and head SHA exactly equal the triggering workflow identity.
6. It checks out that exact feature head with persisted credentials disabled and independently runs `bun install --lockfile-only --ignore-scripts` from reviewed default-branch workflow code.
7. It proceeds only when `bun.lock` is the sole changed path, commits that file as `github-actions[bot]`, and pushes with a force-with-lease bound to the triggering head SHA.
8. It reads the remote branch back and requires the remote head to equal the generated commit.
9. That branch push triggers the ordinary canonical CI path once. The new run must see a clean lock candidate and complete the frozen repository gates before integration.

There is no second post-push workflow dispatch. Successful publication already creates the repository event that owns validation. This keeps one mutation followed by one canonical consequence and removes a failure point after the branch changed.

## Candidate artifact

The read-only CI artifact remains independent evidence and a manual recovery path. It contains:

- `bun.lock` — generated replacement;
- `bun.lock.committed` — repository input used by the run;
- `summary.json` — SHA-256 identities for both files and generator identity.

The writer regenerates independently and never trusts those bytes for publication.

## Writer authority and fences

The permanent writer receives only the permissions needed by its one effect:

- `actions: read`;
- `pull-requests: read`;
- `contents: write`, constrained by the workflow to one leased feature-branch push.

It accepts only a failed pull-request CI run whose head repository is this repository and whose head branch differs from the default branch. Before checkout, it requires exactly one open pull request for that source branch and requires the PR's current head SHA to equal the triggering workflow head SHA.

After checkout it verifies the same SHA and a clean worktree. Repository credentials and `GH_TOKEN` stay outside package resolution. Any generated path besides `bun.lock` aborts publication. The final push targets only the source branch and uses:

```text
--force-with-lease=refs/heads/<branch>:<triggering-head-sha>
```

The writer then verifies the remote head. The normal branch-push CI event owns subsequent validation.

A closed pull request, fork branch, default branch, advanced head, duplicate matching pull request, clean lockfile, unsupported generated path, or displaced generated commit causes no accepted write.

## Security and recovery

- Neither path uses repository/provider secrets for dependency generation.
- Read-only candidate generation performs zero repository mutation.
- The writer regenerates from package declarations and never copies artifact bytes.
- Package lifecycle scripts are disabled during lock generation.
- Repository credentials are unavailable during dependency resolution.
- Force-with-lease protects concurrent branch work.
- Remote readback proves which generated commit currently owns the branch.
- Canonical push-triggered CI validates the resulting commit through the ordinary repository gate.
- Revert or disable the writer workflow to stop automatic updates.

## Local/manual recovery

Run:

```bash
bun run lockfile:check
```

When declarations and the lock agree, the command reports `changed: false`. When they differ, it writes the candidate packet under `artifacts/bun-lock-candidate/` and restores the repository lock.

Copy a reviewed candidate into the repository explicitly only when the permanent writer is disabled or unavailable.

## Relationship to exact-ref validation

#602 delivered the reusable exact-ref validation path. Lock generation and frozen installation remain ordinary canonical CI inputs; exact-ref validation may verify an exact candidate without creating another lock publication mechanism.

— Kestrel
  Intention: make one fenced lock update cause one canonical validation path
