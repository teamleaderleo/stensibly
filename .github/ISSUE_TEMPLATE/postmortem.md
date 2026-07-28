---
name: Postmortem
description: Record a blameless analysis of an incident, rollback, material failure, or consequential near miss
title: "Postmortem: "
labels: []
assignees: []
---

## Summary and current state

What happened, what was affected, and is the system now stable?

## Incident window and versions

- Start and end in UTC:
- Exact source revisions:
- Deployment identifiers:
- Systems, projects, or users affected:

## Impact

Describe availability, correctness, data, privacy, authority, compatibility, operator, and user impact. State what was not affected.

## Detection and recovery evidence

How was the problem detected? Link exact logs, workflow runs, issues, pull requests, verifier output, and rollback or recovery evidence. Do not paste secrets, tokens, raw provider payloads, unrestricted personal data, or unbounded logs.

## Initial timeline

| Time (UTC) | Event and evidence |
| --- | --- |
| YYYY-MM-DD HH:MM | <event> |

## Known and unknown

Separate confirmed facts, current hypotheses, and unavailable evidence.

## Follow-up record

Use `docs/institutional-memory/templates/postmortem.md` for the durable postmortem when the event has cross-cutting lessons or corrective actions that should survive this issue.

## Authority boundary

Opening or completing a postmortem does not approve a deployment, rollback, credential change, permission widening, destructive action, publication, spending, or other consequential effect.
