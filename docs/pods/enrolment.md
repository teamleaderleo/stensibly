# Temporary pod participation protocol

Worker enrolment and pod participation are separate concepts.

- A **worker-enrolment request** identifies one disposable worker session and its
  declared metadata under #270, the pure contract merged through PR #294, and the
  persistence follow-up in #300.
- A **pod-participation declaration** says which collective context that worker is
  explicitly using for a run. It is descriptive coordination metadata only.

Reading a registry, charter, memory, practice, or history file does not create a
participation declaration. Until #281 provides typed records and MCP operations,
participation begins only when the worker publishes the explicit declaration below
in a substantive coordination comment or handoff.

This declaration does not create authority, claims, access, approval, exclusivity,
project membership, worker identity, permanent pod membership, or notification.

## Join declaration

```text
Pod participation: <pod ID or display name>
Run: <run ID or chat-local identifier>
Callsign: <stable callsign for this conversation>
Intention: <current bounded intention, if useful>
Expected contribution: <bounded outcome>
Accepted commitments: <issue, PR, responsibility, or none>
Other pod participation this run: <list or none>
Expected handoff or departure condition: <condition>
```

Do not render a default `Stance` field. A worker may participate in several pods
when commitments do not conflict and review independence is preserved.

## Quiet, dormant, and resumed participation

For human-started interactive chats, silence does not end the worker or its
participation automatically.

- Before the configured freshness threshold, the worker may be `quiet` unless it
  explicitly declared `paused`.
- After the current eight-hour dogfood threshold, treat it as `dormant`, not
  expired. Do not presume it is watching or received a GitHub comment.
- Dormancy removes assumptions of exclusive active execution and makes unfinished
  work recoverable or shareable while preserving the prior holder and evidence.
- The same conversation may resume under the same callsign after reconciling
  current issues, PRs, revisions, reviews, competing candidates, and authority.
- A different chat must use a distinct callsign or explicit sibling/succession
  wording and receives no inherited authority without transfer and fresh checks.

A resumed declaration may use:

```text
Pod participation resumed: <pod>
Callsign: <same callsign for the same conversation>
Previous checkpoint: <reference>
Current reconciliation: <continued | completed elsewhere | transferred | superseded | competing>
Accepted work now: <reference or none>
Next bounded action: <action>
```

Claims, leases, approvals, credentials, and capabilities expire or renew under
their own policies and are never extended by chat continuity.

## Switch or departure declaration

```text
Pod departure: <pod ID or display name>
Run: <run ID or chat-local identifier>
Callsign: <callsign>
Completed commitments: <references>
Outstanding commitments and destination: <references and next owner or recoverable queue>
Memory or practice contributions: <references or none>
Next pod participation: <pod or none>
Wake or reconvening condition: <condition or none>
```

Do not add or remove a worker from `registry.yaml`; it lists pods, not ephemeral
participants. Current participation should be reconstructed from bounded recent
declarations and handoffs until the typed ledger implementation exists.

## Proposal declaration

A worker may propose a pod by opening or updating an appropriate existing design
issue and attaching a completed `templates/pod-proposal.md`. Creating the proposal
never creates the pod, grants authority, records human sponsorship, or transfers
commitments. A proposal may enter `trial` only after its sponsor status, scope,
review condition, migration plan, and decision/reference are explicit.
