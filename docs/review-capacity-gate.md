# Review capacity gate

CodeRabbit review capacity is scarce. The default is **do not request an AI review**.

A review is a risk-reduction tool, not a completion badge, merge ritual, or substitute for reading the diff and running the checks.

## Never eligible

Do not request CodeRabbit review for:

- execution-only or one-use pull requests;
- deployment, promotion, observation, recovery, or diagnostic trigger branches that are meant to close unmerged;
- temporary applicators, source-generation workflows, or branch-local scaffolding;
- exact-blob replays, current-main refreshes, merge-tree refreshes, or metadata-only handoffs when the accepted content is unchanged;
- formatting, spelling, generated refreshes, narrow fixtures, mechanical configuration, or repository housekeeping;
- documentation-only changes unless the document itself grants or changes material runtime, security, privacy, financial, legal, or operational authority;
- test-only changes that do not change a public contract or expose meaningful uncertainty in the implementation;
- incremental follow-up heads whose only purpose is to satisfy stale, cosmetic, or already-resolved review comments;
- a head that already received a useful review unless a material change invalidated that review.

Execution-only PRs must use all of these safeguards even though automatic review is disabled:

1. create the PR as a draft;
2. prefix the title with `[execution][skip review]`;
3. apply `review-exempt` when the label is available;
4. state that the PR will close unmerged;
5. never mark it ready for review;
6. close it promptly after bounded evidence is recorded.

## Eligibility test

A product or integration PR may spend one CodeRabbit review only when **all** of these are true:

1. The exact head is stable enough to review and the relevant repository checks have passed.
2. The author or integration worker has already inspected the complete diff and performed a concrete self-review.
3. A residual risk is named precisely, such as authentication, authorisation, privacy, durable-state migration, retention, cross-project isolation, concurrency, recovery, or broad compatibility.
4. Another review is reasonably likely to find a defect that would change the merge, deployment, or recovery decision.
5. The same risk is not already covered by an independent human or agent review.
6. The change is not in the never-eligible list above.
7. The PR body records why this review is worth spending before the request is made.

A large diff is not automatically eligible. A small diff is not automatically trivial. Spend according to consequence and uncertainty, not line count.

## Required review-spend record

Before manually requesting CodeRabbit review, add a short block to the PR body or conversation:

```text
Review spend
- Exact head: <sha>
- Residual risk: <specific failure mode>
- Why self-review is insufficient: <specific uncertainty>
- Decision this review can change: <merge/deploy/repair/hold>
- Existing coverage: <none or exact reviews already considered>
```

Do not use vague reasons such as “extra confidence”, “best practice”, “another set of eyes”, “because Tier 1/2”, or “to satisfy the process”.

## Invocation and follow-up

- Automatic CodeRabbit review remains disabled in `.coderabbit.yaml`.
- Request at most one review on the stable exact head after the eligibility test passes.
- Do not request incremental review for cosmetic, metadata, test-wording, branch-replay, or execution-scaffolding changes.
- When the head moves, decide whether the change materially invalidated the useful review. Do not re-request by default.
- Automated findings are evidence, not acceptance authority. The integration worker still decides whether each finding is valid and material.
- Independent human or agent review should be preferred when it can answer the named risk without consuming provider quota.

## Examples

Eligible examples:

- a new hosted authentication boundary where token, session, and workspace isolation interact;
- a durable schema migration with non-obvious replay or rollback behavior;
- a cross-backend contract change where SQLite and Convex could diverge;
- a privacy-sensitive public projection with uncertain redaction behavior.

Ineligible examples:

- a PR that only triggers a one-time Vercel or Worker deployment;
- a temporary workflow that applies already-reviewed source to another branch;
- a byte-identical replay onto current main;
- a typo fix, generated refresh, narrow assertion update, or cleanup commit;
- a PR that exists only to capture bounded execution evidence and then close unmerged.

— Rook · Stensibly dogfood
  Intention: spend scarce review capacity only where it can change a consequential decision
