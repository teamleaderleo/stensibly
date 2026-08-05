# Red-control CI lane

The `ci:red-control` label reserves a small, non-authorizing GitHub Actions lane for an intentionally failing child pull request. Use it only when a parent pull request will absorb both the control and its repair.

A red-control receipt proves that the repository recognized one exact draft child, one exact source revision, one exact merge base, one declared absorbing parent, and one exact changed-path fence. It records `expectedOutcome: red`, `authorizesMerge: false`, and `authorizesMutation: false`.

The receipt never proves integration eligibility. It never replaces browser evidence, repository tests, runtime parity, serial validation, or the canonical exact-ref receipt. Branch protection must continue to require the canonical context for merge candidates.

## Eligibility

A child enters the lane only when all of these conditions hold:

- the pull request is draft;
- a repository maintainer applies `ci:red-control`;
- the description contains `Merge independently: no`;
- the description contains one `Red-control parent: #<number>` line;
- the description contains one `Red-control fence SHA-256: <digest>` line;
- the changed-path fence is non-empty and matches that digest;
- the child changes no file below `.github/workflows/`.

Branch names carry no classification authority.

## Build the fence declaration

Compute the fence from the child pull request merge base to its exact head. The digest binds the sorted, newline-delimited changed paths produced by the canonical workflow.

```bash
base_sha=<pull-request-base-sha>
head_sha=<pull-request-head-sha>
git fetch --no-tags origin "$base_sha"
merge_base="$(git merge-base "$base_sha" "$head_sha")"
git diff --name-only --diff-filter=ACDMR "$merge_base" "$head_sha" \
  | LC_ALL=C sort > red-control-fence.txt
sha256sum red-control-fence.txt
```

Copy the 64-character digest into the pull request description. Review the path list before applying the label.

## Lifecycle

1. Open the child as a draft against its absorbing parent.
2. Add the three exact declaration lines and review the changed-path fence.
3. Apply `ci:red-control`.
4. Confirm the ordinary browser, repository, runtime, serial, and canonical-receipt jobs are absent from the classified run.
5. Inspect the `red-control-non-authorizing` receipt and preserve its exact run identity in the parent record.
6. Absorb the control and its repair into the parent.
7. Run the complete canonical topology on the parent's exact repaired head.
8. Remove the label or mark the child ready only when deliberately proving that ordinary full CI returns on the unchanged child head.
9. Close the child without merging it independently.

Opening, synchronizing, editing the description, labeling, unlabeling, changing draft state, and closing use one per-pull-request concurrency group. A newer transition cancels an obsolete queued or running profile.

## Failure and recovery

A classified child fails closed when its description, revision identity, merge base, fence digest, or workflow-file boundary differs from the declared packet. Remove the label to restore ordinary full CI. Close the child to cancel obsolete work. Revert the profile commit to remove the lane while preserving the existing canonical topology.
