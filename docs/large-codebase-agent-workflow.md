# Large-codebase human-agent workflow

This playbook describes a practical way to coordinate human and agent work on investigations that span a large repository, long context, several branches, expensive validation, and public issue or pull-request preparation.

It is based on lessons from a real multi-agent code investigation, but it is intentionally general. The same structure can be used by one person switching roles over time or by several agents working in parallel.

The goal is not maximum process. The goal is to make the human coordinator increasingly hands-off without losing correctness, provenance, scope control, or editorial judgement.

## Core principle

Treat the investigation and the final submission as two different products.

### Investigation archive

The archive preserves how understanding developed:

- baseline and negative reproduction;
- intermediate branches and commits;
- rejected prototypes;
- decision and confidence logs;
- exact test commands and named trees;
- reviews and handoffs;
- unresolved hypotheses;
- retrospective observations.

This history is useful for later debugging, design questions, follow-up work, and workflow improvement.

### Clean submission

The final issue or pull request should contain only what its audience needs:

- the smallest coherent production change;
- focused tests;
- concise, reviewable history;
- bounded validation claims;
- clear problem and non-goals;
- no coordination notes, agent handoffs, private logs, or prototype ancestry.

Do not destroy useful investigation history merely to make the submission clean. Build a separate clean candidate from the reviewed net effect.

## Two definitions of done

Track these independently.

### Correctness done

- the failure is reproduced;
- the ownership and behavioural model is understood;
- the chosen contract and non-goals are explicit;
- the implementation is tested;
- the exact tested tree is identified;
- the final net diff has independent review;
- unsupported hypotheses remain labelled as such.

### Submission done

- the candidate is based on current upstream;
- investigation-only history and files are absent;
- repository-native formatting, linting, and agreed tests have run;
- final repository inspection is recorded;
- issue and pull-request wording has human review;
- related work is refreshed;
- publication sequencing is approved;
- public links are cross-referenced.

A project can be correctness-done while submission work remains open. Naming the distinction prevents premature publication.

## Phase 0: create the work map

Before parallel implementation starts, record:

```text
project:
problem_statement:
baseline_sha:
upstream_target:
repository_visibility:
confirmed_facts:
hypotheses:
selected_contract:
non_goals:
branch_map:
lane_owners:
required_tooling:
validation_plan:
clean_candidate_plan:
publication_gate:
```

In Stensibly, these should become durable project and item facts rather than remaining only in chat.

Recommended initial work items:

1. reproduce the failure;
2. investigate ownership and intended behaviour;
3. implement the narrow fix;
4. define and implement acceptance tests;
5. perform static review;
6. run named-tree validation;
7. prepare issue and pull-request drafts;
8. reconstruct the clean candidate;
9. perform final reconvene and publication review;
10. write the retrospective.

## Phase 1: preserve an immutable negative proof

Create the smallest safe reproduction that demonstrates the defect and cleans up after itself.

Prefer one dedicated commit or artifact whose purpose is only to prove baseline behaviour. Avoid rewriting it while positive acceptance tests evolve, unless the test never actually reproduced what it claimed.

Record:

- exact baseline SHA;
- platform and relevant constraints;
- exact command;
- result;
- cleanup behaviour;
- what the test proves;
- what it does not prove.

This prevents implementation work from erasing the original evidence.

## Phase 2: maintain a claims ledger

Every material statement should have an explicit confidence state.

Suggested states:

- `reproduced`;
- `validated_fix`;
- `statically_confirmed_mechanism`;
- `high_confidence_hypothesis`;
- `weak_hypothesis`;
- `ruled_out`;
- `deferred_product_decision`.

Suggested record:

```text
claim:
state:
evidence:
files_or_symbols:
owner:
test_obligation:
public_wording_allowed:
next_action:
```

Do not let a plausible static path silently become a public bug claim. A reproduced bug requires executable evidence of the claimed failure mode.

## Phase 3: write the contract before assertions

Before implementation or acceptance tests harden, write the expected behaviour in plain language.

A useful contract includes:

- source of truth;
- ownership identity;
- trigger boundary;
- filtering rules;
- ordering rules;
- output placement;
- compatibility requirements;
- explicit non-goals.

Tests should assert independent invariants rather than one brittle string or snapshot when several components have separate meaning.

Example:

- assert the completion line is first;
- assert each expected identifier appears once;
- assert identifiers are ordered;
- assert the timing line follows the inserted warning;
- assert unrelated identifiers are absent.

## Phase 4: separate implementation and acceptance ownership

The implementer should not be the only person defining, executing, and interpreting acceptance.

A useful lane split is:

- **implementation owner:** smallest compatible production change;
- **acceptance owner:** negative proof, adversarial cases, runtime execution;
- **review owner:** ownership model, net diff, scope control;
- **publication owner:** history, related work, privacy, issue and pull-request copy;
- **human coordinator:** authority, sequencing, escalation, publication, and final editorial judgement.

For solo work, use the same split as sequential hats rather than simultaneous roles:

1. investigator;
2. designer;
3. implementer;
4. adversarial tester;
5. reviewer;
6. release editor.

Do not wear all six hats in one uninterrupted pass.

## Phase 5: use one canonical status projection

A coordination board should contain current state and next actions only.

Other documents have different roles:

- **decision log:** durable design decisions and rejected alternatives;
- **per-lane report:** detailed evidence owned by one lane;
- **test log:** exact commands, trees, results, skips, and infrastructure events;
- **review file:** immutable verdict for one named comparison;
- **retrospective:** workflow learning after correctness is complete.

Avoid copying the same evidence into every file. Repetition creates stale-text risk.

Every meaningful handoff should name who updates the canonical status projection.

## Standard handoff schema

```text
lane:
branch_or_item:
base_sha:
head_sha:
worktree_state:
changed_files:
commands_run:
results:
skips_or_flakes:
confirmed_findings:
hypotheses:
open_risks:
next_owner:
next_action:
requested_decision:
```

A handoff is incomplete without a concrete next owner and next action.

## Phase 6: review before expensive validation

Perform a preliminary static review before long builds or platform-specific tests.

Check:

- contract alignment;
- ownership identity and source of truth;
- exact filtering and isolation;
- lifecycle-policy expansion;
- public schema or protocol changes;
- identifier coupling;
- output placement and truncation boundaries;
- unnecessary file spread;
- missing cleanup or race coverage.

Call this preliminary review, not final sign-off.

## Phase 7: validate a named tree

A passing command is not sufficient unless the tested tree is unambiguous.

Record before and after formatting or fixes:

```text
base_sha=
branch=
worktree_sha_before=
worktree_dirty_before=
tool_availability=
formatter_command=
worktree_sha_after=
worktree_dirty_after=
```

For every validation command, record:

```text
command:
selection_scope:
result:
duration:
skips:
flakes_or_retries:
infrastructure_events:
claim_supported:
```

Keep these categories separate:

- compile or typecheck;
- focused unit tests;
- integration or acceptance tests;
- repository-native lint and formatting;
- platform skips;
- infrastructure failure;
- broader workspace validation not run.

If formatting changes files, commit or otherwise identify the resulting tree before expensive validation.

## Environment capability check

Run this before validation becomes critical:

- repository wrapper commands available;
- language toolchains present;
- platform or sandbox constraints known;
- test runner and linker capacity adequate;
- required credentials or services available;
- branch and upstream state confirmed.

Install required tools early or explicitly record a deviation. Do not discover missing repository tooling only after correctness work is complete.

## Phase 8: publish or identify the exact tested tree

A local passing tree is not the final artifact.

After validation:

1. publish or uniquely identify the exact tested tree;
2. compare it with the pre-validation head;
3. verify formatting or fix-up commits are semantically narrow;
4. run final net-diff review against the baseline or upstream target;
5. record the verdict for that exact comparison.

## Phase 9: prepare public materials independently

The publication owner should verify:

- the issue describes the actual defect rather than intended behaviour;
- root-cause claims match their confidence state;
- validation claims are bounded;
- non-goals are explicit;
- related issues are current and accurately distinguished;
- private or machine-specific material is absent;
- the proposed pull request is one coherent stage;
- follow-up hypotheses are not bundled into the current patch.

“Unpublished upstream” does not mean private. Treat public forks and research branches as publicly accessible.

## Phase 10: reconstruct the clean candidate

Create a separate candidate from current upstream main.

The candidate should:

- preserve the reviewed semantic net effect;
- exclude research and coordination Markdown;
- exclude rejected prototypes and investigation merges;
- use one or two logical commits;
- record upstream divergence and conflict resolution;
- run repository-native checks;
- produce a final clean comparison;
- receive equivalence review against the tested investigation head.

Do not force-push the provenance archive merely to create this candidate.

## Final reconvene

Reconvene when correctness is complete and again when the clean candidate exists.

Each lane should answer the same questions:

1. Is the clean candidate semantically equivalent to the reviewed tree?
2. Is the scope still narrow, with no late policy expansion?
3. Which commands actually ran, and what passed, failed, skipped, flaked, or was not run?
4. Is the commit sequence concise and reviewable?
5. Does the issue describe the defect accurately?
6. Does the pull request explain implementation and behavioural boundaries without overselling validation?
7. Is public copy privacy-safe?
8. Are related issues and newer fixes still current?
9. Is the publication sequence still appropriate?
10. Which findings remain hypotheses or deferred product decisions?

## Reconvene triggers

Do not wait for confusion to accumulate. Reconvene when:

- the selected design changes;
- a test invalidates an assumption;
- the tested tree differs from the published tree;
- a new related issue or upstream fix appears;
- formatting or cleanup creates a new candidate tree;
- publication copy becomes ready;
- a rebase or reconstruction starts;
- correctness becomes complete while submission remains open.

## Retrospective protocol

At the end of a substantial project, each lane should independently report:

- what it owned;
- what it learned technically;
- what worked well;
- what created avoidable delay or ambiguity;
- which handoff or evidence was most useful;
- which claim remained uncertain;
- what tooling or Stensibly support would have helped;
- one process change to adopt next time;
- one practice to stop or simplify;
- one follow-up that should remain separate.

Collect these as separate comments or artifacts first. Synthesize only after independent contributions exist, so the coordinator does not bias everyone toward one narrative.

## How this maps to Stensibly

Stensibly should hold coordination facts and references, not copy source repositories or execution logs wholesale.

Recommended mapping:

- **project:** the investigation or feature;
- **items:** reproduction, design, implementation, acceptance, review, publication, cleanup, retrospective;
- **claims:** current responsibility and time-bounded authority;
- **events:** meaningful state transitions and validation results;
- **artifacts:** branch, commit, comparison, report, issue draft, test log, and review references;
- **dependencies:** implementation blocked by contract, publication blocked by clean candidate, and similar relationships;
- **handoffs:** summary plus explicit next action and next owner;
- **human approval:** publication, broad validation, consequential external effects, and scope expansion.

The board should be a projection of this durable ledger rather than the only copy of project state.

## Candidate Stensibly improvements

These ideas should be evaluated separately from any current feature patch.

### Branch and artifact manifest

Maintain one project-level manifest of:

- repository and upstream refs;
- archive branches;
- clean candidate branch;
- key commits and comparisons;
- sensitivity or publication status;
- branch-monitoring scope.

This can drive monitoring automatically instead of relying on a manually hard-coded branch list.

### Claims ledger

Represent important technical claims with confidence state, evidence, owner, and test obligation.

This would make the distinction between reproduced failures and high-confidence hypotheses visible on the board.

### Named-tree validation record

Provide a standard artifact or command that records:

- SHA and dirty state;
- tool availability;
- formatter and fixer effects;
- commands and selection scope;
- results and duration;
- skips, retries, and infrastructure events;
- final SHA and diff check.

### Canonical-status ownership

Every handoff should update one server-owned current-state projection or explicitly assign that update to another actor.

This reduces stale coordination documents.

### Retrospective workflow

Support one retrospective item with independent per-actor contributions, followed by a synthesis step and optional conversion of accepted ideas into new backlog items.

### Automatic reconvene suggestions

Suggest a reconvene when:

- several lanes complete;
- a tested artifact changes identity;
- the clean candidate is created;
- publication dependencies are nearly clear;
- conflicting claims or stale status are detected.

### Correctness and submission gates

Model these as separate project milestones so that a technically green patch is not treated as publication-ready.

## Minimal solo version

For smaller or solo work, keep the structure lightweight:

- `work-status.md` or one Stensibly project brief for current state;
- `decision-log.md` for durable reasoning;
- `test-log.md` for exact commands and trees;
- one retrospective item after completion;
- one clean candidate separate from the scratch branch.

The value comes from role separation and named evidence, not from document volume.
