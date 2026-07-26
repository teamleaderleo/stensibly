# Foundry pod memory

This file contains compact reusable findings for fresh workers. Source issues,
commits, reviews, artifacts, and ledger records remain canonical.

Do not store secrets, credentials, private tokens, unrestricted personal data, or
full chat transcripts here. New entries should use
`docs/pods/templates/memory-entry.md` and be appended or explicitly superseded.

## M-001 — Read live work before creating more work

- **Status:** accepted
- **Claim:** Fresh workers should read the repository entry point, current wave,
  and relevant exact-head work before creating an issue or branch. Finishing,
  reviewing, repairing, integrating, and unblocking outrank adjacent exploration.
- **Scope:** Stensibly repository work
- **Sources:** `AGENTS.md`; `docs/current-wave.md`
- **Confidence:** high
- **Freshness:** review when either source changes materially
- **Sensitivity:** public
- **Supersedes:** none

## M-002 — Pod affiliation is never authority

- **Status:** accepted
- **Claim:** Pod names, enrolment declarations, callsigns, mantles, GitHub identity,
  and descriptive sign-offs are coordination metadata. They do not grant claims,
  credentials, approvals, permissions, or responsibility.
- **Scope:** all pod bootstrap use
- **Sources:** `AGENTS.md`; issues #272 and #281
- **Confidence:** high
- **Freshness:** stable invariant
- **Sensitivity:** public
- **Supersedes:** none

## M-003 — Begin broad and let pod boundaries emerge from evidence

- **Status:** provisional, adopted for dogfood
- **Claim:** Use one deliberately broad Foundry pod until multi-run evidence shows
  that a fork or sibling pod would reduce context cost, preserve independent
  review, or maintain a genuinely distinct recurring responsibility.
- **Scope:** initial pod topology
- **Sources:** issue #272 refinement comment; issue #278
- **Confidence:** medium
- **Freshness:** review after W01 retrospective
- **Sensitivity:** public
- **Supersedes:** none

## M-004 — Markdown is a temporary projection

- **Status:** accepted
- **Claim:** `docs/pods/` is readable bootstrap scaffolding only. Typed pod identity,
  enrolment, commitments, inboxes, knowledge provenance, and lifecycle state should
  move to the Stensibly ledger and MCP surfaces from #272, #281, #278, and #270.
- **Scope:** pod infrastructure
- **Sources:** `docs/pods/README.md`; issues #272, #278, #281, #270
- **Confidence:** high
- **Freshness:** supersede when typed pod records ship
- **Sensitivity:** public
- **Supersedes:** none
