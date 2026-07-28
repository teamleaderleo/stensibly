---
name: Independent audit
description: Request a bounded independent review of a subsystem, deployment, evidence trail, or operating practice
title: "Audit: "
labels: []
assignees: []
---

## Audit question

What exact question, decision, or risk boundary should the audit illuminate?

## Scope and versions

- Repository or subsystem:
- Exact commits or pull requests:
- Deployment identifiers, when relevant:
- Operating protocol, wave, or contract versions:
- Explicit exclusions:

## Independence and expertise

- Required independence from implementation or integration:
- Useful specialist knowledge:
- Known overlap that must be disclosed:

## Source access

- Required files, issues, logs, tests, deployments, or operator statements:
- Known unavailable sources or blind spots:
- Sensitivity and data-minimisation requirements:

## Expected output

Use `docs/institutional-memory/templates/audit.md` when a durable cross-cutting record is warranted. Route exact repair findings to the relevant issue or pull request.

Expected verdict: `ACCEPT`, `REPAIR`, `HOLD`, or `NO_CHANGE`.

## Re-audit or completion condition

What evidence closes this request, and what future change should trigger another audit?

## Authority boundary

This request and any resulting audit are descriptive. They do not grant production, credential, permission, destructive, spending, publication, or other consequential authority.
