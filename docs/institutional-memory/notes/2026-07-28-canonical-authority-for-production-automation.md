# After-action note: use one canonical authority record for recurring production automation

- **Status:** active
- **Opened:** 2026-07-28 UTC
- **Last updated:** 2026-07-28 UTC
- **Author:** Forge · ChatGPT project session
- **Scope:** W01 OAuth rollout and recurring production-control workflows
- **Version coverage:** PRs #358, #365, #373, #375; issue #220 as observed on 2026-07-27 and 2026-07-28
- **Confidence:** high
- **Sensitivity:** public
- **Review by:** when production approvals and effect receipts become server-enforced records

## Situation

A recurring OAuth rollout workflow was added, contained, restored with interruption recovery, and contained again. The workflow and restoration pull request cited approval comments, while the canonical production-gate issue still described material evidence and sign-off as incomplete. Workers could not reliably retrieve and reconcile every cited comment through the available connector.

The repaired state machine itself was useful. The recurring execution authority was not represented by one directly inspectable canonical record.

## Reusable lesson

A recurring production-control workflow should depend on one canonical, directly retrievable authority record that binds the exact source revision, trigger cadence, target, role and project boundary, approval lifetime, prerequisite ordering, rollback scope, and stop conditions.

Do not make automation infer authority by combining an issue body, several comments, pull-request prose, and ambient operator intent.

## Why it was not obvious

Each individual source looked plausible:

- the issue body described the production gate;
- comments recorded later operator direction;
- pull requests explained the intended correction;
- workflow constants named an approval reference.

The contradiction appeared only when a later worker tried to prove that the unattended workflow still had current authority. The integration repair solved interruption recovery but could not solve ambiguous approval provenance.

## Evidence and source coverage

- Evidence reviewed: issue #220, rollout PR #358, containment PR #365, restoration PR #373, containment PR #375, exact workflow diffs and review records.
- Evidence not available: a connector-supported direct fetch of every individually cited approval comment during the authority reconciliation.
- Reproduction: repeated restore/contain decisions occurred while the implementation remained otherwise recoverable in Git history.

## Recommended use

For any scheduled, push-triggered, or automatically retried production mutation:

1. create or identify one canonical approval/effect proposal record;
2. bind the workflow to that exact record and approved revision;
3. make expiry and revocation machine-checkable;
4. keep implementation recovery separate from execution authority;
5. fail closed when the authority record cannot be retrieved or no longer matches.

## Limits and counterexamples

A one-time human-run command may use a contemporaneous approval comment when the operator can inspect it directly and the effect does not recur. Documentation-only workflows and read-only verification do not need a production-effect approval record merely because they run on a schedule.

The lesson does not require every decision to live in one file. It requires one canonical authority object or record to resolve the execution decision without interpretation across conflicting sources.

## Durable follow-up

- [ ] No further action; the note is sufficient.
- [ ] Add or strengthen a test.
- [ ] Update a runbook or command.
- [x] Open a product, contract, or protocol proposal.
- [ ] Request an independent audit.

Follow-up is tracked through #352 and related external-effect proposal and approval work. Future server-enforced approvals should include exact expiry, consumption, recovery, and receipt semantics.

## Omitted sensitive data

Credential values, Worker secrets, OAuth tokens, raw provider payloads, private chat content, and unrestricted operator data are excluded.
