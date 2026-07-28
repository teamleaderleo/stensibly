# Institutional memory

**Status:** dogfood  
**Tracking:** #406  
**Applies under:** `stensibly-agent-ops/0.2.0`

This directory turns the existing reusable-learning, survey, and external-audit rules into a concrete repository practice. It exists so lessons survive individual chats without making routine work produce ceremonial documents.

These records are descriptive evidence. They do not grant authority, approve a change, replace an exact issue or pull request, or silently modify product or operating policy.

## Start here

Read `index.md` first. Open only the records relevant to the subsystem, incident class, or operating question you are working on. Do not load the entire directory by default.

Before writing a new record, search this directory and linked issues for an existing lesson, postmortem, or audit that should be amended, superseded, or referenced.

## Record types

### After-action note

Use the smallest record for one non-obvious, reusable lesson supported by evidence.

Good triggers include:

- a failure mode or recovery technique likely to recur;
- a review finding that applies beyond one exact diff;
- a command, verification recipe, or decomposition pattern that saved substantial work;
- a repeated source of operator correction or integration churn;
- a surprising no-op, compatibility boundary, or observability gap.

Do not create a note for routine successful work, an isolated typo, an untested opinion, or information already stated clearly in canonical documentation.

### Postmortem

Use a postmortem for a material incident, outage, rollback, security or authority near miss, data-loss risk, repeated coordination failure, or failure that required substantial human intervention.

Postmortems are blameless. Analyse system conditions, assumptions, interfaces, incentives, missing evidence, and recovery behaviour. Do not use them to assign personal blame or infer private intent.

A postmortem may begin while recovery is ongoing, but mark uncertain facts and update them after the state is stable.

### Independent audit

Use an audit when another worker should examine a subsystem, deployment, evidence trail, operating practice, or cross-cutting risk without owning the implementation being assessed.

Independence is required when the audit is the sole acceptance signal for consequential implementation, authorization, privacy, durable-state, retention, deletion, or production-control boundaries. For lower-risk exploratory audits, disclose any overlap and limit the conclusion accordingly.

An audit records findings and recommendations. It does not itself approve production action, grant authority, or replace exact-head pull-request review.

## File layout and naming

Store one record per file to preserve provenance and reduce merge conflicts:

```text
docs/institutional-memory/
  notes/YYYY-MM-DD-short-slug.md
  postmortems/YYYY-MM-DD-short-slug.md
  audits/YYYY-MM-DD-short-slug.md
  templates/
```

Use the date the record was opened. Keep the slug stable when updating the same record. Do not overwrite an old record to describe a different event.

Every record must state:

- status: `active`, `superseded`, or `retired`;
- opened and last-updated dates in UTC;
- author or auditor callsign and source surface when useful;
- exact scope and affected version classes;
- linked evidence and source coverage;
- facts separately from interpretation;
- confidence and material uncertainty;
- sensitivity and omitted data;
- follow-up owner or eligibility, if action remains;
- review-by date or a concrete freshness condition.

## Writing and review flow

1. Search `index.md`, this directory, relevant issues, and recent pull requests.
2. Choose the smallest record type that captures the reusable value.
3. Copy the matching template and remove unused prompts.
4. Bind claims to exact issues, comments, commits, deployments, workflow runs, or reproduction evidence.
5. Keep secrets, credentials, raw tokens, unrestricted personal data, raw provider payloads, and unbounded transcripts out of the record.
6. Update `index.md` in the same pull request.
7. Select review depth from the underlying claim, not from the fact that the diff is Markdown.

A note about a harmless local command may be Tier 0. A postmortem or audit that changes shared operating instructions, security assumptions, retention policy, or production gates requires the corresponding higher review tier.

## Cadence without busywork

Consider a record:

- after a wave completes or materially stalls;
- after an incident, rollback, or consequential near miss;
- after repeated human correction or duplicated integration work;
- after an external audit or material review theme;
- when three or more related findings suggest a shared pattern;
- before a major protocol or architecture change when prior evidence should guide it.

Remain quiet when there is no durable lesson. A handoff, issue comment, test, or code fix may be sufficient.

## Promotion and retirement

Institutional-memory records do not become policy merely by existing.

Promote a lesson through the smallest durable mechanism that prevents recurrence:

- a regression test or invariant;
- a runbook or verification command;
- a product or protocol contract;
- an issue with an explicit owner and acceptance criteria;
- a reviewed change to `AGENTS.md`, the Project bootstrap, a wave, or a pod practice.

When a later change invalidates a record, mark it `superseded` or `retired`, link the replacement, update `index.md`, and preserve the original evidence. Do not silently edit history into appearing correct.

## Audit route

A worker or operator can open an audit using `.github/ISSUE_TEMPLATE/independent-audit.md` or copy `templates/audit.md` directly.

The audit request should name:

- the question and risk boundary;
- the exact versions or deployed revisions in scope;
- required independence or specialist knowledge;
- source access and known blind spots;
- expected output and re-audit condition.

The auditor should first reconcile current state, then record positive controls as well as defects. Findings belong on the relevant issue or pull request when an exact repair is actionable; the durable audit record should capture the cross-cutting conclusion, source coverage, and lessons that remain useful after the repair merges.
