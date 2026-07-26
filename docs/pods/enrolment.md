# Temporary pod enrolment protocol

Until #281 and #270 provide typed enrolment records and MCP operations, pod
participation is declared in the worker's first substantive coordination comment
or handoff.

This declaration is descriptive metadata only. It does not create authority,
claims, access, approval, exclusivity, or permanent identity.

## Join declaration

```text
Pod enrolment: <pod ID or display name>
Run: <chat-local run identifier>
Callsign: <optional disposable name>
Stance: <implementation | review | research | synthesis | rollout | ...>
Expected contribution: <bounded outcome>
Accepted commitments: <issue, PR, responsibility, or none>
Other pod affiliations this run: <list or none>
Expected handoff or departure condition: <condition>
```

A worker may enrol in several pods when the commitments do not conflict and
review independence is preserved.

## Switch or departure declaration

```text
Pod departure: <pod ID or display name>
Run: <chat-local run identifier>
Completed commitments: <references>
Outstanding commitments and destination: <references and next owner>
Memory or practice contributions: <references or none>
Next pod affiliation: <pod or none>
Wake condition: <condition or none>
```

Do not add or remove a worker from `registry.yaml`; it lists pods, not ephemeral
participants. Current participation should be reconstructed from bounded recent
handoffs until the ledger implementation exists.

## Proposal declaration

A worker may propose a pod by opening or updating an appropriate existing design
issue and attaching a completed `templates/pod-proposal.md`. Creating the proposal
never creates the pod, grants authority, or transfers commitments. A proposal may
enter `trial` only after its sponsor, scope, review condition, and migration plan
are explicit.
