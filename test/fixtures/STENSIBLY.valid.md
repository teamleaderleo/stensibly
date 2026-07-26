---
version: 1
project: example-project
repositories:
  - Example-Owner/Example-Repository
runner_profiles:
  - codex-default
concurrency:
  project: 1
  global: 1
autonomous_actions:
  - inspect
  - propose
  - create_draft_pr
approval_required:
  - merge
  - deploy
  - external_message
  - provider_change
  - broad_permission_change
  - credential_change
  - destructive_cleanup
  - spend
checks:
  - typecheck
  - unit-tests
---

# Project contract

## Goal

Deliver a bounded repository change with reviewable evidence.

## Boundaries

Keep live authority, credentials, approvals, and execution state server-owned.

## Evidence and handoff expectations

Record the exact head, changed files, verification profiles, results, and requested decision.

## Escalation

Escalate permission widening, ambiguous scope, missing capabilities, and consequential actions.
