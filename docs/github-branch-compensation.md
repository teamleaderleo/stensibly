# Exact-SHA GitHub branch compensation

Issue: #1549, child of #154.

This lane gives durable GitHub publication workflows one bounded forward-compensation path for candidate branches they created. It does not add mutation to `github_branch_tidy`, close pull requests, restore repository files, or expose a public mutation surface.

## Source identity

A compensation command names the originating `github_publish_change` workflow, repository, full `refs/heads/...` ref, and recorded candidate SHA. Admission re-reads the durable source workflow and its provider receipts.

The recorded SHA is the branch creation SHA when no later repository-file step settled. When the publication workflow verified a repository-file write, the write receipt's `verified.nextExpectedParentSha` is the candidate head. An unresolved repository-file step blocks compensation because the current durable evidence cannot establish the branch head produced by the originating operation.

The original publication workflow remains unchanged. Delete and restore are new `github_branch_compensation` workflows with their own idempotency identities and receipt history.

## Runner Git CAS

REST branch deletion is outside this path. Ref mutation is delegated to an authenticated runner and uses explicit Git leases:

```text
delete:
  git push --porcelain \
    --force-with-lease=refs/heads/<branch>:<exact-recorded-sha> \
    origin :refs/heads/<branch>

restore:
  git push --porcelain \
    --force-with-lease=refs/heads/<branch>: \
    origin <exact-recorded-sha>:refs/heads/<branch>
```

The delete lease accepts the mutation only while the remote ref still equals the exact recorded SHA. The restore lease's empty expected value requires that the remote ref be absent. A concurrent advance or recreation therefore fails at the remote update itself even if a read-only admission observation races.

The runner returns only a closed receipt: attempt ID, outcome class, and bounded code. stdout, stderr, credentials, and arbitrary provider prose stay runner-local.

## Admission and exclusions

Before runner dispatch, the service requires:

- exact repository identity and a canonical `refs/heads/...` target;
- exact originating workflow and verified branch-creation receipt;
- exact final recorded candidate SHA from durable publication evidence;
- active caller authority;
- current default-branch identity and branch-protection evidence;
- deletion: current ref present at the exact recorded SHA;
- restoration: current ref absent and a successful durable delete-compensation identity for the same source/ref/SHA.

Default branches, protected refs, explicitly excluded refs, moved delete targets, and occupied restore targets fail closed before runner mutation.

## Replay and ambiguous outcomes

The existing operation-workflow store is the durable command ledger. Its stable request fingerprint makes an exact replay deterministic and makes altered reuse of one idempotency key a conflict.

Once runner dispatch is reserved, a lost or ambiguous result is reconciled by bounded read-only GitHub evidence before another mutation is considered:

- delete settles only when the target ref is absent;
- restore settles only when the target ref is present at the exact recorded SHA;
- any other evidence leaves the workflow in `waiting_reconciliation` with `reconcile_current_step` recovery.

A replay of that waiting workflow performs observation only; it never redispatches the branch mutation. This keeps one ambiguous attempt from becoming two branch writes.

## Durable evidence

The workflow stores stable identities, request/command digests, closed error codes, runner attempt references, and digests of before/after verification evidence. It stores no Git credentials and no arbitrary provider error text.
