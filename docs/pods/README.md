# Pod bootstrap

This directory is a temporary, repository-readable projection of pod context until typed pod identity, participation, knowledge, and lifecycle records exist in the Stensibly ledger.

It is useful coordination scaffolding. It is **not** a source of authority, credentials, claims, approvals, leases, or permission. GitHub identity, pod names, Markdown edits, and descriptive sign-offs never grant access or responsibility.

Worker enrolment and pod participation remain separate:

- worker enrolment identifies one disposable worker session and canonicalises its declared metadata under #270, PR #294, and #300;
- pod participation identifies which collective context that worker is using for a run and remains descriptive until #281 adds typed records.

## Start here

1. Read [`registry.yaml`](registry.yaml).
2. Select an open pod whose current charter fits the run. The default is the broad [`Foundry`](foundry/charter.md) pod while evidence for additional pods develops.
3. Read that pod's charter, memory, practices, and history.
4. Follow [`enrolment.md`](enrolment.md) to declare temporary pod participation.
5. Accept work only through the applicable issue, claim, responsibility, approval, or other current authority record.

A worker may participate in several pods for one run. Participation is run-scoped, non-exclusive, and descriptive. It creates only the obligations the worker explicitly accepts.

## Join, switch, or leave

To join a pod:

- confirm its registry status is `active` or `trial` and participation is open;
- state the pod, run, stance, expected contribution, and accepted commitments in the first substantive handoff or coordination comment;
- use the pod name in the descriptive sign-off when helpful;
- contribute durable findings using the pod's memory format.

To switch pods or leave:

- checkpoint or hand off every accepted commitment;
- name the destination for unresolved work and reusable knowledge;
- record the departure in a substantive handoff rather than maintaining a permanent roster here;
- join the next pod through the same run-scoped declaration.

The bootstrap deliberately avoids a long-lived Markdown membership list. Current workers disappear too quickly for such a list to remain reliable. The future ledger implementation in #281 should own typed pod participation, departure, invitations, and requests.

## Propose a pod

Do not create a department taxonomy in advance. Copy [`templates/pod-proposal.md`](templates/pod-proposal.md) when repeated work, context, or operating practices appear to deserve separate continuity.

A useful proposal identifies:

- observed recurring work across more than one run;
- the context or commitments that should remain distinct;
- an initial sponsor and approved scope;
- expected coordination benefit and switching cost;
- a trial duration or review condition;
- migration, merge, dormancy, and dissolution paths;
- any consequential authority or credential change requiring human approval.

Lifecycle states are:

```text
proposed -> trial -> active -> dormant -> dissolved
```

Fork and merge proposals are governed by the same evidence, migration, and review requirements. Issue #278 remains the design track for typed lifecycle operations.

## Pod memory

Pod memory contains compact reusable findings, not copies of entire chats or source systems. Every entry must include:

- stable entry ID and concise claim;
- source references and provenance;
- scope and sensitivity;
- confidence and freshness or review condition;
- status such as provisional, accepted, superseded, or rejected;
- explicit supersession rather than silent rewriting.

Never store secrets, credentials, private tokens, unrestricted personal data, or unbounded transcripts. Source issues, commits, reviews, artifacts, and ledger records remain canonical. Use [`templates/memory-entry.md`](templates/memory-entry.md) for new entries.

## Migration target

This bootstrap is intended to be replaced by typed Stensibly records and MCP tools:

- #272 — durable pod identity and cross-repository working memory;
- #278 — fork, merge, charter change, dormancy, and dissolution;
- #281 — fluid pod participation, pod inboxes, and inter-pod communication;
- #270 — MCP worker enrolment and continue-useful-work protocol.

When those surfaces exist, these files should become generated, reviewable projections rather than mutable sources of live coordination state.
