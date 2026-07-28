# Independent audit: <scope and question>

- **Status:** active | superseded | retired
- **Opened:** YYYY-MM-DD UTC
- **Last updated:** YYYY-MM-DD UTC
- **Auditor:** <callsign and source surface>
- **Requested by:** <issue, operator, worker, or standing cadence>
- **Independence:** <no implementation overlap, disclosed overlap, or specialist-only review>
- **Scope:** <subsystem, deployment, evidence trail, practice, or contract>
- **Version coverage:** <exact commits, deployments, protocol, wave, and contract versions>
- **Severity model:** <definitions or linked standard>
- **Sensitivity:** public | internal | restricted
- **Review by:** <date or concrete freshness condition>

## Audit question

State the exact question, decision, or risk boundary this audit is meant to illuminate.

## Source coverage

- Repositories, files, issues, pull requests, and reviews:
- Runtime or deployment evidence:
- Tests and reproduction:
- Interviews or operator statements:
- Sources unavailable or intentionally excluded:

## Method

Describe the bounded audit method, sampling, assumptions, and stopping condition. Separate source inspection from inference.

## Existing controls that worked

Record positive controls and verified protections, not only defects.

## Findings

### Finding A: <title>

- **Severity:** informational | low | medium | high | critical
- **Confidence:** low | medium | high
- **Affected boundary:** <correctness, authority, privacy, data, retention, compatibility, operations, or coordination>
- **Evidence:** <exact references>
- **Observation:** <fact>
- **Interpretation:** <why it matters>
- **Recommended repair:** <smallest useful repair>
- **Alternatives and trade-offs:**
- **Acceptance evidence:** <test, review, deployment check, or decision>

Repeat as needed. Do not inflate the finding count with duplicate symptoms.

## Cross-cutting lessons

What remains useful after individual repairs merge? Link or propose after-action notes when appropriate.

## Blind spots and residual uncertainty

State what the audit could not prove and which conclusions depend on assumptions.

## Verdict

Choose one descriptive result:

- `ACCEPT` — no material blocker within the declared scope;
- `REPAIR` — one or more concrete repairs are required;
- `HOLD` — a named missing source, decision, or prerequisite prevents a safe conclusion;
- `NO_CHANGE` — the audit found no justified change or follow-up.

This verdict is not production approval and does not replace exact-head pull-request review where that review is required.

## Follow-up and re-audit

- Findings routed to:
- Owner or eligible worker:
- Re-audit trigger:
- Expiry or freshness condition:

## Omitted sensitive data

List categories deliberately excluded. Never include credentials, raw tokens, unrestricted personal data, raw provider payloads, or unbounded transcripts.
