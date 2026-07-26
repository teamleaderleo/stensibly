# Repository-local attachment contract

`STENSIBLY.md` is the versioned, human-readable static contract for attaching repository context to a Stensibly project. It declares bounded project policy and display context. It never acts as a credential, lease, approval, live authority grant, command queue, or arbitrary executable instruction source.

## Discovery

A later importer uses this order:

1. a path explicitly supplied by a human;
2. repository-root `STENSIBLY.md`;
3. no recursive search and no similarly named fallback.

The version 1 parser receives content and source metadata. It performs no file, GitHub, or network discovery.

## Version 1 format

The document begins on line one with a restricted YAML front matter block. Version 1 accepts the keys shown below and reserves no extension keys. Unknown keys fail closed. Lists use two spaces followed by `-`; `concurrency` uses two-space nested keys. YAML aliases, tags, block scalars, flow values, comments, single-quoted scalars, and duplicate keys are rejected.

```markdown
---
version: 1
project: example-project
repositories:
  - owner/repository
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
checks:
  - bun run typecheck
  - bun test
---

# Project contract

## Goal
...

## Boundaries
...

## Evidence and handoff expectations
...

## Escalation
...
```

## Validation rules

- `project` is a lowercase slug.
- `repositories` contains one or more canonical, credential-free `owner/repository` identifiers. URLs, `.git` suffixes, ambiguous paths, and duplicates after lowercase normalisation fail.
- `runner_profiles` contains bounded lowercase identifiers.
- project concurrency is 1–16, global concurrency is 1–64, and project concurrency cannot exceed global concurrency.
- action identifiers come from the exported version 1 allowlist.
- `merge`, `deploy`, `external_message`, `provider_change`, and `broad_permission_change` must remain approval-required.
- one action cannot be both autonomous and approval-required.
- checks are bounded single commands. Shell chaining, interpolation, redirection, environment assignment, continuations, and credential-shaped values fail.
- the complete document is bounded to 128 KB and rejects tabs, control characters, private keys, tokens, passwords, and other explicit secret-shaped content.
- invalid input returns errors and no partial contract.

The canonical projection sorts set-like lists and normalises newlines, identifiers, whitespace, and repository case. Check order remains semantically meaningful. The digest input is fixed-order JSON of the canonical contract; source path, repository, and revision metadata stay outside the content digest.

## Markdown body

Version 1 requires exactly four level-two sections in this order: Goal, Boundaries, Evidence and handoff expectations, and Escalation. Their bounded text is preserved for display. Prose never creates permissions, verification commands, approval records, or live authority.

## Dry-run comparison

`compareProjectAttachmentContracts` reports added and removed repositories, runner profiles, actions, approval requirements, and verification commands; concurrency increases and decreases; body-only changes; and version incompatibility.

Permission widening includes repository or runner expansion, autonomous-action additions, approval-requirement removals, verification-command removals, concurrency increases, project identity changes, and version changes. The comparison only reports widening. A later import flow must obtain confirmation and persist any approval separately.

## Out of scope

Version 1 parsing does not fetch repositories, discover files, import through CLI/REST/MCP, persist snapshots, migrate storage, re-import in the background, handle credentials, execute Markdown, or grant authority. Live holder, generation, expiry, approval, command, and execution state remain server-owned.
