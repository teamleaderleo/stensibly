# Issue intake and label taxonomy

This document defines a provisional navigation and triage layer for GitHub issues.
It does not replace canonical work, review, responsibility, authority, or current-state
records.

## Boundaries

Labels answer broad discovery questions such as what kind of record this is, which
areas it touches, and whether it is ready for triage. They do not prove that:

- a worker accepted responsibility;
- an issue has priority over the current wave;
- a GitHub comment or assignment notified anyone;
- a claim, approval, capability, lease, or production authority exists;
- a review verdict or implementation candidate is current;
- the labelled issue is the canonical live projection for its scope.

Use the current roster or state bundle, exact issues and pull requests, signed
handoffs, reviews, CI, and Stensibly ledger records when available for those facts.

## Label dimensions

### Type

Use exactly one type label:

- `type:bug` — demonstrated incorrect behaviour, regression, or broken contract;
- `type:improvement` — bounded improvement to existing behaviour, maintenance, or workflow;
- `type:proposal` — new product, workflow, policy, or experiment proposal;
- `type:investigation` — observation or question requiring bounded investigation first.

An investigation may later be promoted to another type. Preserve the original
evidence and link the promoted record rather than rewriting uncertainty out of
history.

### Area

Use zero to two area labels when they make discovery easier:

- `area:product`;
- `area:runtime`;
- `area:oauth`;
- `area:coordination`;
- `area:ci`;
- `area:docs`;
- `area:operations`.

Area labels describe affected surfaces, not permanent teams or worker roles.

### Concern

Add concern labels only when the concern materially affects review or design:

- `concern:security`;
- `concern:privacy`;
- `concern:compatibility`;
- `concern:performance`;
- `concern:tech-debt`;
- `concern:creative-experiment`.

Several concerns may apply. Do not add every plausible concern merely to increase
visibility.

### Triage

Use at most one triage label:

- `triage:needed` — overlap, evidence, scope, and promotion path still need review;
- `triage:ready` — scoped enough for an eligible worker to select; not assigned;
- `triage:waiting` — waiting on a named dependency, decision, review, or condition;
- `triage:superseded` — retained history replaced by a named current record.

Do not add an `active` label. Live worker state changes too quickly and belongs in
the canonical coordination projection, exact work record, or future typed ledger.

## Intake and triage flow

1. Choose the closest structured issue form. Blank issues remain available for
   advanced records that do not fit the provisional taxonomy.
2. The form applies one type label and `triage:needed`.
3. Triage checks evidence, related work, authority boundaries, scope, desired output,
   and stop or promotion condition.
4. Add up to two area labels and only material concern labels.
5. Replace `triage:needed` with `triage:ready`, `triage:waiting`, or
   `triage:superseded` when the evidence supports that state.
6. Responsibility begins only through an explicit accepted work record or current
   dogfood equivalent. Label changes alone never place work on a worker's plate.

A valid triage result may be no action, consolidation into an existing record,
promotion into pod memory, or a reversible experiment instead of implementation.

## Historical issues

Do not mass-retag old issues solely to make the label counts look complete. Apply
this taxonomy when an issue is created, materially updated, recovered, or selected
for work. Preserve old titles and discussion when changing them would damage source
provenance.

## Label synchronisation

`.github/labels.json` is the reviewed repository manifest for this provisional
label set. `.github/workflows/sync-issue-labels.yml` creates missing labels and
updates declared colours or descriptions after a change reaches `main`, or through
an explicit manual workflow run.

The workflow deliberately does not:

- delete undeclared labels;
- rename or migrate historical labels automatically;
- apply labels to issues or pull requests;
- create assignments, notifications, claims, reviews, approvals, or authority.

Removing or renaming a label requires a separate reviewed migration plan when live
issues use it. Prefer compatible additions and evidence-backed consolidation while
the taxonomy is still being dogfooded.

## Evaluation

During the next retrospective or practice survey, inspect:

- whether new findings are easier to discover;
- whether investigations avoid premature issue or branch proliferation;
- whether `type:improvement` captures concrete technical debt rather than vague cleanup;
- whether creative proposals receive bounded experiments and evidence;
- whether labels become stale or are mistaken for current work state;
- which categories are unused, overloaded, missing, or should be retired;
- whether structured forms improve issue quality enough to justify their maintenance cost.

A no-change, simplification, merge, rename, or retirement result is acceptable.
