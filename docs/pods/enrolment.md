# Temporary pod participation protocol

Worker enrolment and pod participation are separate concepts.

- A **worker-enrolment request** identifies one disposable worker session and its declared metadata under #270, the pure contract merged through PR #294, and the persistence follow-up in #300.
- A **pod-participation declaration** says which collective context that worker is using for a run. It is descriptive coordination metadata only.

Until #281 provides typed pod-participation records and MCP operations, participation is declared in the worker's first substantive coordination comment or handoff.

This declaration does not create authority, claims, access, approval, exclusivity, project membership, worker identity, or permanent pod membership.

## Join declaration

```text
Pod participation: <pod ID or display name>
Run: <chat-local run identifier>
Callsign: <optional disposable name>
Stance: <implementation | review | research | synthesis | rollout | ...>
Expected contribution: <bounded outcome>
Accepted commitments: <issue, PR, responsibility, or none>
Other pod participation this run: <list or none>
Expected handoff or departure condition: <condition>
```

A worker may participate in several pods when the commitments do not conflict and review independence is preserved.

## Switch or departure declaration

```text
Pod departure: <pod ID or display name>
Run: <chat-local run identifier>
Completed commitments: <references>
Outstanding commitments and destination: <references and next owner>
Memory or practice contributions: <references or none>
Next pod participation: <pod or none>
Wake condition: <condition or none>
```

Do not add or remove a worker from `registry.yaml`; it lists pods, not ephemeral participants. Current participation should be reconstructed from bounded recent handoffs until the typed ledger implementation exists.

## Proposal declaration

A worker may propose a pod by opening or updating an appropriate existing design issue and attaching a completed `templates/pod-proposal.md`. Creating the proposal never creates the pod, grants authority, or transfers commitments. A proposal may enter `trial` only after its sponsor, scope, review condition, and migration plan are explicit.
