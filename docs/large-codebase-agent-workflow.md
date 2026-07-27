# Human-agent investigation playbook

Use this playbook for long repository investigations with several work lanes, expensive validation, and possible public publication.

Sources from [#246](https://github.com/teamleaderleo/stensibly/issues/246):

- [Agent 1 — implementation and integration](https://github.com/teamleaderleo/stensibly/issues/246#issuecomment-5081855675)
- [Agent 2 — reproduction, acceptance, and validation](https://github.com/teamleaderleo/stensibly/issues/246#issuecomment-5081854767)
- [Agent 3 — independent review and coordination support](https://github.com/teamleaderleo/stensibly/issues/246#issuecomment-5081854691)
- [Agent 4 — history, privacy, related work, and publication](https://github.com/teamleaderleo/stensibly/issues/246#issuecomment-5081855098)

The source comments remain authoritative for lane-specific evidence and disagreement. This document keeps the reusable guidance. Current repository policy, especially `AGENTS.md`, takes precedence over source-era authority or merge assumptions.

## Two tracks

**Investigation track:** preserve negative proof, hypotheses, prototypes, decisions, exact commands and refs, lane reports, reviews, and unresolved claims.

**Clean-submission track:** build the smallest reviewable candidate from current upstream with focused code and tests, concise history, repository-native checks, bounded public claims, and privacy-reviewed copy.

Keep investigation files, logs, handoffs, and rejected prototypes out of the clean candidate. Plan both tracks before production implementation.

## Two completion gates

### Correctness-complete

- failure reproduced, or confidence explicitly weaker;
- source of truth, ownership, contract, and non-goals written;
- focused checks pass on an exact tested ref;
- failures, skips, and unrun broader suites classified separately;
- independent verdict names one exact comparison when the selected risk tier requires it;
- unresolved hypotheses remain outside the correctness claim.

### Submission-complete

- candidate based on current upstream and semantically equivalent to the reviewed result;
- repository-native checks run, with deviations approved;
- `tested_ref`, `published_ref`, and `reviewed_comparison` explicit;
- changed paths and final diff inspection recorded;
- related work refreshed for publication;
- the applicable risk-tier integration evidence exists;
- public issue/PR copy and publication sequence receive the approval required for their external effect.

Correctness can be complete while submission remains open.

## Artifact 1: investigation-start template

```yaml
project:
repository:
repository_visibility:
upstream_target:
baseline_sha:
working_directory:

problem_statement:
observed_evidence:
selected_contract:
non_goals:

claims:
  - claim:
    confidence: reproduced | validated_fix | static_mechanism | hypothesis | ruled_out | deferred
    evidence_ref:
    test_obligation:
    public_wording_allowed:

tracks:
  investigation_ref:
  clean_candidate_ref:
  clean_candidate_plan:

lanes:
  - owner:
    responsibility:
    file_fence:
    non_goals:
    mutation_authority:
    completion_trigger:

preflight:
  instruction_files:
  repository_commands:
  required_and_optional_tools:
  missing_capabilities:
  validation_environment:
  services_credentials_resources:
  approved_fallbacks:
  environment_mutations_requiring_authority:

risk:
  tier:
  integration_requirements:
  consequential_operations_requiring_human_approval:
    - deployment_or_enablement
    - credentials_or_permission_widening
    - destructive_or_irreversible_data_change
    - spending
    - external_publication
  privacy_decisions:
  destructive_cleanup:
```

Label feasibility prototypes as disposable. Preserve the smallest negative reproduction as immutable evidence.

## Contract-first acceptance

Write each case before assertions:

```yaml
case:
precondition_and_actor:
event_sequence:
source_of_truth:
observable_invariants:
explicit_non_requirements:
cleanup_postcondition:
allowed_skips:
```

Strict assertions should protect a user-visible, compatibility, ownership, or safety property. Avoid incidental wording, whitespace, timing, truncation excerpts, or generated IDs unless the contract requires them.

## Work lanes

For multi-worker work, use a small accountable set: implementation, acceptance/runtime validation, independent review, publication/history/privacy, and human coordination. Each lane gets a bounded file fence and owns its evidence.

For solo work, use timed role changes: investigate, write the contract, implement, test adversarially, pause or reset context, review one exact comparison, then prepare publication copy. Usually one research branch, one candidate branch, checkpoint commits, one decision log, and one validation record are enough.

## Current state versus evidence

Keep one current-state view containing active refs, owners, gate states, blockers, next actions, and requested human decisions.

Keep detailed evidence in lane-owned records. Avoid copying commands, SHAs, test-case lists, placeholders, and status prose across several files. Branch names alone never establish what was tested, published, or reviewed.

## Artifact 2: standard worker handoff

```yaml
lane:
owner:
scope:
non_goals:

repository:
base_sha:
starting_ref:
head_sha:
published_ref:
reviewed_comparison:
worktree_state:
changed_files:

commands_run:
results:
skips_flakes_retries:
infrastructure_events:
cleanup_result:

confirmed_findings:
unresolved_claims:
confidence_changes:
scope_or_contract_deviations:

risk_tier:
independent_review_state:
integration_decision:
next_owner:
next_action:
requested_human_decision:
canonical_status_updated_by:
```

Keep the handoff to one screen and link detailed evidence.

## Validation rules

Preflight must confirm checkout, repository instructions, exact refs, repository-native commands and target kinds, tool availability, platform/services/resources, mutation authority, publication capability, and approved fallbacks.

Workers should use the repository-declared toolchain and record missing capabilities. Routine repository-native formatting, linting, compilation, and tests within the agreed scope remain worker-owned.

System-wide or global installations, lockfile changes made to satisfy an environment, and bootstrap scripts that have not been reviewed require explicit authority.

A fallback is equivalent only when it preserves target kind, features, environment, serialisation, cleanup, and failure semantics. A test-name filter does not prove equivalent build scope.

Classify outcomes: implementation/assertion defect, acceptance-contract defect, formatter mutation, compile/link failure, resource failure, runner/service failure, platform skip, cleanup failure, publication failure, or broader validation unrun.

## Artifact 3: named-tree validation record

```yaml
record_id:
repository:
baseline_sha:
starting_ref:
tested_ref:
published_ref:
tree_before_mutation:
tree_after_mutation:
dirty_before:
dirty_after:

environment:
  platform_architecture:
  tool_versions:
  missing_capabilities:
  approved_deviations:
  resource_limits:

commands:
  - command:
    target_kind: library | named_integration | package | workspace | repository_profile
    selector_environment_concurrency:
    started_ended:
    exit_status_counts:
    skips_retries_flakes:
    failure_stage_and_class:
    claim_supported:

final_checks:
  changed_path_allowlist:
  status_short:
  diff_check:
  baseline_diff_summary:
  cleanup_result:

review:
  comparison:
  reviewer:
  verdict:
  invalidation_triggers:
```

Capture identity before and after every mutating formatter or fixer. A green local tree needs a durable ref before handoff. Review verdicts expire when their comparison changes.

## Artifact 4: branch and artifact manifest

```yaml
repository:
current_upstream_sha:
updated_at:

artifacts:
  - name:
    kind: reproduction | prototype | implementation | acceptance | candidate | validation | review | publication
    owner:
    branch_or_ref:
    head_sha:
    parent_or_baseline:
    purpose:
    owned_paths:
    visibility: local | public_fork | upstream
    audience: investigation | submission
    movement: immutable | owner_may_advance | policy_gated
    tested: yes | no | partial
    published: yes | no
    reviewed_comparison:
    sensitivity:
    stale_when:
```

A survey or integration pass should read this manifest instead of relying on a hard-coded branch list.

## Review and publication sequence

1. Before expensive validation, review contract alignment, ownership, isolation, output placement, cleanup, policy expansion, protocol changes, and file spread.
2. Validate an exact tree and publish or durably identify it.
3. Review the final baseline-to-head comparison at the depth required by the risk tier.
4. Build the clean candidate from current upstream and verify semantic equivalence.
5. Run repository-native submission checks.
6. Refresh related work and privacy-review public copy.
7. Satisfy the current repository integration policy.
8. Obtain contemporaneous human approval before Tier 3 external publication or another consequential operation.

Clean-candidate work can expose submission defects without reopening settled correctness review.

Treat public forks and research branches as public. “Unpublished upstream” describes publication state, not privacy.

Authority follows the current repository risk-tier policy. Routine repository-native validation and qualifying Tier 0–2 integration may be worker-owned after their required evidence exists. Human approval remains required for Tier 3 effects such as production deployment or enablement, credentials, permission widening, destructive data operations, spending, external publication, irreversible migration, and comparable real-world consequences. Environment-wide installation, lockfile mutation for environment setup, unreviewed bootstrap execution, material scope expansion, privacy decisions, and destructive cleanup also require the authority declared by current policy.

## Reconvene triggers

Reconvene when the contract changes; a test invalidates an assumption; a test contract is corrected; a fallback changes target scope; cleanup fails; tested and published refs differ; a reviewed comparison changes; the candidate is created or rebased; related work changes; public copy becomes ready; or correctness completes while submission remains open.

## Retrospective synthesis

### Repeated lessons

All four source lanes supported:

- exact SHAs and comparisons for tested, published, and reviewed artifacts;
- contract-first acceptance and immutable negative proof;
- separate investigation and clean-submission tracks;
- one current-state view plus durable lane evidence;
- early preflight and typed validation scope;
- risk-aware authority over costly, privileged, destructive, externally consequential, and material-scope actions;
- lighter solo records while preserving role changes and exact-comparison review.

### Source-era disagreements and competing recommendations

These bullets record the #246 retrospective rather than current repository policy:

- **Candidate commits:** Agent 1 preferred separate implementation and acceptance commits. The shared guidance allowed one or two logical commits. A current integration owner should choose using repository convention, review cost, and the applicable risk tier; human input is needed only when current policy or consequence requires it.
- **Patch 2 and Patch 3:** Agent 1 described them as labels for follow-up families. Agent 3 kept their original status unresolved pending confirmation from the discussion owner. Preserve both source statements unless a later canonical record resolves them.
- **Ceremony:** multi-worker work benefits from lane branches and explicit ownership; solo work benefits from fewer branches and timed role changes. The evidence gates remain comparable while review depth follows risk.
- **Automation:** every lane proposed richer records or triggers while warning against converting every observation into a feature.

### Unresolved source claims and confidence

| Claim | Confidence | Next step |
| --- | --- | --- |
| Delayed cross-turn dispatch can produce the suspected failure | High-confidence static mechanism; unreproduced | Separate executable reproduction and ownership contract |
| Patch 2 and Patch 3 were concrete original proposals | Disputed in #246 | Resolve only through the original owner or a newer canonical decision |
| Broad-validation linker deaths were OOM/resource failures | Strong inference; resource telemetry absent | Capture memory and target-scope telemetry in a future reproduction |
| Full workspace suite and full repository formatter passed | Unsupported in the source investigation | Run and record them on a clean candidate when required |
| A clean candidate is submission-ready | Separate submission question | Sync upstream, validate, inspect, and satisfy current integration/publication policy |

### Adopt, stop, simplify, separate

**Adopt:** two tracks and gates; contract-first acceptance; explicit artifact roles; named-tree validation; comparison-bound review; a branch/artifact manifest; independent retrospective comments before synthesis.

**Stop:** copied evidence; branch-name validation claims; undeclared generic fallbacks; promotion of static findings into reproduced claims; a lane for every small question.

**Simplify:** one current-state view; one-screen handoffs; a small lane set; fewer solo branches with explicit role checkpoints.

**Separate:** lifecycle, shutdown, wake-up, remote termination, hidden-subagent, stale-bookkeeping, and crash-recovery policy should remain distinct evidence-backed tracks rather than being inferred from this retrospective. Later canonical work may supersede the source-era recommendation to postpone them.

## Product follow-up bar

Create a Stensibly implementation issue only when it has retrospective evidence, a bounded problem and goal, explicit non-goals, testable acceptance criteria, an overlap check, an owner/file fence, and a validation plan.

Broad ideas here remain design inputs. Existing execution-trace and authority tracks already cover parts of claims, evidence, responsibility, and handoff modelling, so any new issue begins with an overlap check.
