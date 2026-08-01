# Documentation system: intent, evidence, and durable decisions

**Status:** active instruction experiment  
**Experiment identity:** `documentation-brief/1`  
**Base operating protocol:** `stensibly-agent-ops/0.5.0`  
**Tracking issue:** #666  
**Last researched:** 2026-07-31

## In simple words / purpose

Stensibly already preserves exact execution facts well: issues, branches, revisions,
checks, risks, fences, deployments, and next actions. This experiment adds a compact
orientation layer so a fresh worker can quickly understand what the work means, why it
exists, what changed, what proves the claim, and what happens next.

The plain-language layer summarizes. It never replaces source, tests, receipts,
provider state, or detailed reasoning.

## Active experiment rule

Meaningful claims, pull-request descriptions, handoffs, campaign updates, and durable
decisions should keep these concepts legible near the top:

```text
In simple words / purpose: <meaning without recent context, larger outcome, and why now>
Change: <behavior, contract, result, or decision>
Proof: <evidence available or required>
Next: <next action, integration state, or clearing condition>
```

Use separate `In simple words` and `Purpose` headings only when each adds distinct
information. Literal headings may be combined or omitted; the concepts matter more
than the template.

Add `Decision`, `Fence`, `Risk`, or `Recovery` only when they materially improve review
or continuation. Routine progress remains one or two sentences.

This overlay is active while #666 is open. Acceptance may fold it into a later
`stensibly-agent-ops` revision. Rejection or rollback removes the overlay from
`AGENTS.md`, the pull-request template, and contributor guidance while preserving the
experiment and findings in Git history.

## What documentation is for

### Orientation

A fresh worker should understand the project, campaign, and current change without the
chat transcript.

### Coordination

A worker should know the current outcome, responsible lane, overlap fence,
dependencies, authority boundary, next action, and clearing condition.

### Review

A reviewer should encounter the intended behavior and main decision before the detailed
diff and evidence.

### Continuation and recovery

Another worker should be able to continue, repair, integrate, or reverse course from
durable records alone.

### Decision integrity

Future workers should be able to recover why a consequential choice was made, which
alternatives were considered, and what evidence could justify revisiting it.

### Discovery

Use concrete nouns, stable issue numbers, searchable symptoms, and exact identities.
A future reader may remember only one term.

### Calibration

Separate observation, inference, proposal, experiment, acceptance, rejection,
supersession, and verification.

### Maintenance

Keep active truth in one owning location. Link to mutable evidence rather than copying
it into several summaries.

## Audiences and their first question

| Audience | First question | Lead with |
| --- | --- | --- |
| Fresh worker | What is this and where can I help? | purpose, current reality, lanes, next action |
| Implementer | What must remain true? | behavior, contracts, boundaries, examples, tests |
| Reviewer | Is the direction and candidate sound? | purpose, decision, main change, proof, consequences |
| Integration worker | Can this exact head land? | head/base, checks, review state, recovery |
| Operator | What outcome is moving or needs a decision? | user-visible intent, evidence, decision boundary |
| Future maintainer | Why does this exist and may it change? | context, rationale, alternatives, supersession |
| Product user | How do I accomplish or understand something? | task guide, reference, explanation, examples |

Write for the nearest real audience and avoid explaining facts that reader is already
expected to know.

## Zoom levels

Documentation should connect four levels without copying every detail upward.

### Project

Answers what Stensibly is becoming, who it serves, and which product and authority
principles persist. Owning records include `README.md`, `STENSIBLY.md`, and
`docs/product-model.md`.

### Campaign or wave

Answers which meaningful outcome is being pursued now, what is true today, what is in
or out of scope, which lanes exist, how success is measured, and which decisions
changed the route. Owning records include `docs/current-wave.md` and programme issues.

### Lane or change

Answers which bounded result or question an issue or pull request owns, how it advances
the campaign, what changes, what stays outside, and how success is proved.

### Implementation and evidence

Contains exact functions, schemas, files, tests, reviews, CI, deployments, artifacts,
logs, and provider receipts.

Implementation evidence links to its lane. A lane names its campaign. A campaign
connects to the stable project direction.

## Document types

Keep the primary reader need clear.

- **Tutorial:** a guided first success for a learner.
- **How-to guide:** steps toward a concrete task for an informed reader.
- **Reference:** exact contracts, values, APIs, environment variables, or schemas.
- **Explanation:** concepts, rationale, historical context, and trade-offs.

A single page may link across types, but mixing all four into one long page usually
makes each use harder.

## Surface guidance

### Issue or lane claim

Keep purpose, bounded outcome or question, owner/state, fence, exact starting evidence,
next action, and clearing condition visible. Use a full brief only at claim or premise
change boundaries.

### Pull request

Keep plain-language purpose, changed behavior, non-obvious rationale when present,
proof, and next integration state on the first screen. Refresh exact candidate details
when the head or premise changes materially.

### Handoff

Lead with current result and relationship to the larger outcome. Preserve exact issue,
PR, branch, head, deployment, blocker, evidence, next action, and recovery facts. Avoid
copying a chronological activity log.

### Campaign update

Explain the north star, current reality, changed understanding, active lanes, measures,
risks, decisions, and next unresolved question. Individual PRs should link to this
synthesis rather than repeat it.

### Routine progress

Use one or two sentences: what changed or was learned, followed by what happens next or
what is concretely blocked.

## Durable decision records

Create a decision record when rationale or consequences must outlive the immediate PR.
Common triggers include changes to:

- architecture or component responsibility;
- public or internal contracts;
- provider, dependency, or storage strategy;
- authority, privacy, isolation, or retention behavior;
- compatibility, rollout, migration, or recovery policy;
- repeated operating defaults;
- interpretation of a product goal;
- a choice future workers may reasonably reverse.

Mechanical edits and obvious local refactors usually need no separate record.

### Collision-free identity

Every decision record must have an owning GitHub issue. Name it:

```text
docs/decisions/<issue-number>-<short-lowercase-slug>.md
```

Examples:

```text
docs/decisions/666-documentation-brief.md
docs/decisions/591-github-observation-content-boundary.md
```

The issue number supplies a stable coordination identity. The slug supplies discovery
and allows several distinct decisions under one programme issue without sequential
number allocation.

Before creating a record, search `docs/decisions/` and the owning issue for an existing
choice. If concurrent branches create equivalent records, retain one canonical file,
merge useful reasoning, and mark the duplicate proposal rejected or superseded in its
issue or Git history. Do not allocate “the next ADR number.”

`docs/decisions/README.md` owns naming and discovery rules only. It does not duplicate
every record's live status. The directory listing and issue-number search are the
bounded catalogue; each record owns its status and supersession links.

Use `docs/decisions/_template.md` as the starting point.

### Required content

A durable record normally includes:

- status and date;
- owning issue and implementation links;
- plain-language purpose;
- context and observed evidence;
- decision and rationale;
- material alternatives;
- benefits, costs, risks, and consequences;
- validation and failure signals;
- recovery and supersession path;
- dated history.

Keep superseded decisions. Mark them and link both directions rather than rewriting the
historical context.

## Campaign bookkeeping

A campaign or wave should be understandable as a product effort rather than a list of
issue numbers. Its owning record should include:

1. north star;
2. current verified reality;
3. goals and non-goals;
4. lanes, dependencies, owners, and clearing conditions;
5. accepted or experimental decisions;
6. measures, graduation criteria, and failure signals;
7. risks and recovery paths;
8. changes in understanding;
9. implementation history at meaningful boundaries;
10. next decision or action.

## Historical record

Source code shows current behavior. It often cannot show the original problem,
external constraints, rejected alternatives, accepted trade-offs, or evidence available
at the time. Preserve those facts in the PR, campaign, or decision record that owns
them.

When relevant, record exact issue, PR, branch, revision, deployment, workflow run, job,
artifact, provider delivery, test command, result, source date, and decision status.

Keep facts near their source:

- source and review evidence in GitHub;
- CI and deployment receipts in execution systems;
- live provider state with the provider;
- product and architectural reasoning in repository documents;
- coordination summaries as short interpretations with references.

A useful historical note explains what changed in the model of the problem. “Continued
work” records activity but little reusable knowledge.

## Maintenance rules

1. Keep the first screen current.
2. Maintain one owner for each active synthesis.
3. Link to exact evidence rather than copying logs or payloads.
4. Refresh a brief after a material premise, behavior, scope, or candidate change.
5. Mark decisions superseded instead of rewriting history.
6. Remove obsolete active instructions; Git history preserves them.
7. Close or archive records whose outcome is complete or premise is invalid.
8. Keep summaries shorter than their evidence.
9. State uncertainty and evidence limits.
10. Prefer ordinary language, concrete nouns, and examples over internal shorthand.

## Failure modes

- **Boilerplate without information:** omit optional fields that add no comprehension.
- **Repeated opening prose:** combine `In simple words / purpose` unless separation helps.
- **Summary drift:** refresh or remove stale first-screen claims.
- **False simplicity:** plain language must retain authority, privacy, compatibility, and recovery consequences.
- **Duplicate active truth:** choose one owner and link to it.
- **Activity logs as outcomes:** lead with result and changed understanding.
- **Rationale trapped in chat:** preserve consequential reasoning in GitHub.
- **Documentation replacing delivery:** a document does not complete a runtime outcome.
- **Uncoordinated decision numbering:** use issue-backed filenames, never sequential allocation.

## Evaluation

Evaluate `documentation-brief/1` through real narrow PRs, complex candidates, handoffs,
and campaign updates.

Acceptance signals:

- a fresh worker can explain the campaign and active change from the first screen;
- reviewers identify the main design question before reading the full diff;
- future workers find why a non-obvious choice exists;
- exact evidence and next actions remain strong;
- routine communication stays brief;
- decision records remain collision-free and discoverable.

Failure signals:

- copied boilerplate dominates records;
- summaries contradict exact evidence;
- the same rationale is maintained in several places;
- routine work slows because every update becomes a design document;
- oversimplification hides consequential boundaries;
- workers satisfy headings without reading or improving the record.

Record concrete evidence on #666. Accept, narrow, revise, or remove the overlay when the
observed costs and benefits justify a decision.

## Research basis

This experiment adapts established practices without importing their full ceremony:

- [Google change descriptions](https://google.github.io/eng-practices/review/developer/cl-descriptions.html): explain what changed and why in a durable record.
- [Google review navigation](https://google.github.io/eng-practices/review/reviewer/navigate.html): take the broad view and inspect the main part first.
- [Google technical-writing audience guidance](https://developers.google.com/tech-writing/one/audience): write for reader expertise and information need.
- [Diátaxis](https://diataxis.fr/start-here/): separate tutorials, how-to guides, reference, and explanation.
- [C4 model](https://c4model.com/diagrams): use different zoom levels for different audiences.
- [Michael Nygard's decision records](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions): preserve context, decision, and consequences in small records.
- [Kubernetes enhancement proposals](https://github.com/kubernetes/enhancements/blob/master/keps/NNNN-kep-template/README.md): preserve goals, non-goals, risks, tests, graduation, recovery, and history for consequential efforts.
- [GitHub repository templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates): provide repository-owned prompts for consistent records.

— Quill · W01 documentation-design lane  
  Intention: make project intent and change rationale legible without weakening exact evidence or delivery speed.
