# Issue intake and label taxonomy

This document defines a provisional navigation and triage layer for GitHub issues.
It does not replace canonical work, review, responsibility, authority, or current-state
records.

## Boundaries

Labels answer broad discovery questions such as what kind of record this is, which
areas, product mode, and external systems it touches, and whether it is ready for
triage. They do not prove that:

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
- `type:investigation` — observation or question requiring bounded investigation first;
- `type:roadmap` — parent plan or index coordinating several related work lanes;
- `type:incident` — active failure cluster, degraded service, or recovery record;
- `type:decision` — bounded product, policy, or contract choice requiring a durable verdict;
- `type:research` — planned evidence gathering, comparison, standards study, or upstream inquiry;
- `type:programme` — active multi-lane delivery programme coordinating sustained execution;
- `type:tracker` — living current-state record, queue, register, or operational index.

An investigation may later be promoted to another type. Preserve the original
evidence and link the promoted record instead of rewriting uncertainty out of
history.

Use `type:roadmap` for coordinating plans and indexes. Use `type:programme` when
the record coordinates active delivery across several lanes and successive workers.
Use `type:tracker` for a living canonical queue, register, or state summary whose
content changes as reality changes. Use `type:incident` while a concrete failure or
degraded journey remains active. Use `type:decision` when the main deliverable is a
recorded choice and its evidence. Use `type:research` when the deliverable is a
reusable finding, comparison, or external report.

### Area

Use zero to two area labels when they make discovery easier:

- `area:product`;
- `area:runtime`;
- `area:oauth`;
- `area:coordination`;
- `area:ci`;
- `area:docs`;
- `area:operations`;
- `area:api`;
- `area:mcp`;
- `area:github`;
- `area:providers`;
- `area:data`;
- `area:dashboard`;
- `area:frontend`;
- `area:workers`;
- `area:identity`;
- `area:authorization`;
- `area:scheduling`;
- `area:messaging`;
- `area:knowledge`.

Area labels describe affected surfaces, not permanent teams or worker roles.
Choose the narrowest useful pair.

Use `area:identity` for accounts, actors, principals, memberships, sessions, and
credential identity. Use `area:oauth` for OAuth protocol and token-lifecycle work.
Use `area:authorization` for scopes, grants, approvals, revocation, and enforcement.
Use `area:scheduling` for queues, dispatch, wake conditions, fairness, and capacity
reservation. Use `area:messaging` for delivery, inbox/outbox, acknowledgements,
notifications, and response threads. Use `area:knowledge` for context packs, memory,
captures, traces, evaluation, and reusable learning.

For example, a GitHub provider executor may use `area:github` and `area:runtime`;
an MCP release-verification issue may use `area:mcp` and `area:operations`; a client
grant issue may use `area:identity` and `area:authorization`.

### Integration

Use zero to three integration labels when behaviour materially depends on a named
external system, runtime, or platform:

- `integration:github`;
- `integration:chatgpt`;
- `integration:openai`;
- `integration:cloudflare`;
- `integration:convex`;
- `integration:vercel`;
- `integration:coderabbit`;
- `integration:bun`.

Integration labels identify an external dependency or interoperability boundary.
They do not imply ownership by that provider, and they should be omitted when a
provider is mentioned only as an example.

Use `integration:chatgpt` for ChatGPT apps, connectors, actions, conversations, and
host behaviour. Use `integration:openai` for OpenAI APIs, SDKs, models, and platform
services. Apply both only when both surfaces materially affect the issue.

### Mode

Use at most one mode label when local-versus-hosted scope changes the implementation,
verification, or compatibility contract:

- `mode:hosted` — specific to the hosted Convex, Worker, and deployed service path;
- `mode:local` — specific to the local SQLite or self-hosted compatibility path;
- `mode:cross-mode` — requires aligned behaviour across both modes.

Omit a mode label when the distinction adds no filtering value. Use
`mode:cross-mode` instead of applying both hosted and local labels.

### Concern

Add concern labels only when the concern materially affects review or design:

- `concern:security`;
- `concern:privacy`;
- `concern:compatibility`;
- `concern:performance`;
- `concern:tech-debt`;
- `concern:creative-experiment`;
- `concern:reliability`;
- `concern:observability`;
- `concern:usability`;
- `concern:accessibility`;
- `concern:cost`;
- `concern:data-integrity`;
- `concern:isolation`;
- `concern:provenance`;
- `concern:developer-experience`.

Several concerns may apply. Do not add every plausible concern merely to increase
visibility. Prefer `concern:data-integrity` for idempotency, concurrency, ordering,
and invariant correctness; use `concern:reliability` for recovery, stale state,
availability, and retry safety.

Use `concern:isolation` when workspace, project, tenant, resource, credential, or
cross-scope separation drives the design. Use `concern:provenance` when attribution,
source identity, exact revision, lineage, evidence identity, or causal references
must remain explicit. Use `concern:developer-experience` for contributor setup, SDK
ergonomics, debugging, local tooling, and repository workflow; keep
`concern:usability` focused on the product experience.

### Triage

Use at most one triage label:

- `triage:needed` — overlap, evidence, scope, and promotion path still need review;
- `triage:ready` — scoped enough for an eligible worker to select; not assigned;
- `triage:waiting` — waiting on a named dependency, decision, review, or condition;
- `triage:superseded` — retained history replaced by a named current record.

Do not add an `active` label. Live worker state changes too quickly and belongs in
the canonical coordination projection, exact work record, or future typed ledger.

## Intake and triage flow

1. Choose the closest issue form. Blank issues remain available for advanced
   records that do not fit the provisional taxonomy.
2. The form applies one common type label and `triage:needed`. Triage may replace
   the type with `roadmap`, `incident`, `decision`, `research`, `programme`, or
   `tracker` when that better describes the durable record.
3. Triage checks evidence, related work, authority boundaries, scope, desired output,
   and stop or promotion condition.
4. Add up to two area labels, up to three material integration labels, at most one
   mode label, and only material concern labels.
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

When touching an older issue, prefer the smallest useful label set: one type, one or
two areas, named integrations only when material, one mode when useful, and the few
concerns that change review or design.

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

- whether roadmap, programme, tracker, incident, decision, and research records are
  easier to distinguish;
- whether identity, authorization, scheduling, messaging, and knowledge work can be
  found without broad full-text searches;
- whether hosted, local, and cross-mode work can be separated cleanly;
- whether narrow areas and named integrations improve backlog filtering;
- whether new findings are easier to discover;
- whether investigations avoid premature issue or branch proliferation;
- whether `type:improvement` captures concrete technical debt instead of vague cleanup;
- whether creative proposals receive bounded experiments and evidence;
- whether labels become stale or are mistaken for current work state;
- which categories are unused, overloaded, missing, or should be retired;
- whether issue forms improve issue quality enough to justify their maintenance cost.

A no-change, simplification, merge, rename, or retirement result is acceptable.
