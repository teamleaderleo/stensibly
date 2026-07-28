# Postmortem: <incident or failure title>

- **Status:** active | superseded | retired
- **Opened:** YYYY-MM-DD UTC
- **Last updated:** YYYY-MM-DD UTC
- **Incident window:** <start and end, or ongoing>
- **Authors:** <callsigns and attributable operators>
- **Scope:** <systems, users, projects, or workflows affected>
- **Version coverage:** <exact source and deployment identifiers>
- **Severity:** low | medium | high | critical
- **Confidence:** low | medium | high
- **Sensitivity:** public | internal | restricted
- **Review by:** <date or concrete freshness condition>

## Summary

Describe what happened, the effect, and the current state in a few sentences.

## Impact

- User or operator impact:
- Data, authority, privacy, availability, or compatibility impact:
- Duration and scope:
- What was not affected:

## Detection and response

How was the problem detected? Which signals were missing, delayed, misleading, or useful? Record the recovery and rollback sequence with exact evidence.

## Timeline

| Time (UTC) | Event and evidence |
| --- | --- |
| YYYY-MM-DD HH:MM | <event> |

## What happened

Explain the technical and coordination sequence. Separate confirmed facts from hypotheses.

## Contributing conditions

Focus on system conditions rather than blame. Consider:

- design or implementation defects;
- stale or contradictory instructions;
- missing bounds, observability, tests, or ownership;
- unsafe defaults or unclear authority;
- review or integration gaps;
- environmental or provider behaviour;
- recovery paths that were unavailable or unverified.

## What worked

Record controls, people, tools, tests, rollbacks, and coordination practices that reduced impact or sped recovery.

## What did not work

Record failed assumptions, noisy signals, ineffective procedures, and attempted fixes that increased risk or delay.

## Root and proximate causes

State the proximate trigger and the deeper conditions that made the incident possible. Avoid forcing a single root cause when the evidence supports a chain or interaction.

## Corrective actions

| Action | Type | Owner or eligible worker | Priority | Acceptance evidence | Status |
| --- | --- | --- | --- | --- | --- |
| <action> | test | <owner> | high | <evidence> | open |

Prefer actions that create executable safeguards: tests, invariants, bounds, alerts, runbooks, contracts, or server-enforced records. Documentation alone is not sufficient when code can prevent recurrence.

## Lessons and promotion candidates

Which lessons belong in an after-action note, test, runbook, product contract, or reviewed operating-protocol proposal?

## Independent review and re-audit

- Reviewer or auditor:
- Independence boundary:
- Open uncertainty:
- Re-audit trigger:

## Omitted sensitive data

List categories deliberately excluded. Never include credentials, raw tokens, unrestricted personal data, raw provider payloads, or unbounded transcripts.
