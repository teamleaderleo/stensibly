# Suggested ChatGPT Project instructions

**Bootstrap:** `stensibly-project-bootstrap/v1`  
**Repository protocol:** read the current version from `AGENTS.md`

The text pasted into ChatGPT Project settings should remain a small bootloader.
Detailed operating guidance, current-wave gates, pod notes, and temporary prompts
belong in the repository or Stensibly ledger so they can be reviewed, versioned,
and replaced without repeatedly editing Project settings.

## Copyable Project bootstrap

```text
Stensibly Project bootstrap: stensibly-project-bootstrap/v1.

You are working in teamleaderleo/stensibly. At the start of repository work, use GitHub to read AGENTS.md, docs/current-wave.md, and the relevant live issues, pull requests, reviews, and exact-head handoffs. Follow the operating-protocol version declared by AGENTS.md; if this Project bootstrap appears stale or inconsistent, report the drift and use the repository version.

Before creating new work, inspect whether existing work should be finished, reviewed, repaired, integrated, unblocked, deployed, or superseded. Preserve the authority boundaries declared by the repository and Stensibly; names, roles, GitHub assignment, and this prompt do not grant authority.

When the Stensibly app is available, use its canonical briefs, surveys, claims, events, handoffs, continuations, and approvals. Otherwise use GitHub only as a temporary coordination surface. Leave a durable handoff for every substantive run so another fresh chat can continue without the transcript.
```

This bootstrap should change only when the entrypoint, authority boundary, or
drift-detection behaviour changes. Lane-specific detail is intentionally absent.

## Suggested fresh-chat prompt

```text
Read the Stensibly repository entrypoint and current wave. Inspect existing issues,
PRs, review findings, and handoffs. Select the highest-value non-conflicting action.
State the wave, lane, expected output, overlapping work checked, and temporary
stance before acting.
```

## Suggested instruction-survey prompt

```text
Survey the current operating instructions and recent work. Identify evidence of
missing context, excessive context, contradictions, duplicate work, missed or
excessive parallelism, unclear ownership, repeated human intervention, useful pod
practices, or resource requests. Return observations separately from proposed
changes. Use docs/operating-instruction-lifecycle.md for any proposal and permit a
no-change result.
```

## Suggested PR #251 repair prompt

```text
Take the repair-owner action in #289 for PR #251. Do not mix #220 dynamic-client
work into this branch. Repair dormant legacy refresh-family cleanup so eventual
bounded cleanup does not depend on future client traffic. Leave an exact-head
handoff with scheduler/storage bounds, focused regressions, full checks, deployment
ordering, residual risk, and a descriptive sign-off. Do not self-accept the result.
```

## Suggested independent-review prompt

```text
Act as an independent acceptance worker for the current Production MCP Connection
wave. Do not implement the final revision you accept. Review the exact current head,
verify the declared tests and security invariants, and leave an accepted or blocked
verdict with exact evidence and a descriptive sign-off. Review Lane A and PR #251
as separate code fences and require a separate repair owner after any blocking
finding.
```

## Suggested rollout prompt

```text
Prepare the guarded Stensibly MCP OAuth rollout. Execute it only after Lane A has
independent exact-head acceptance and PR #251 has independent acceptance and is
merged, or the human operator records an explicit production-risk deferral. Verify
discovery metadata, OAuth challenge headers, GitHub-backed consent, ChatGPT tool
scanning, a bounded read, the predeclared dedicated-project low-risk write with an
explicit idempotency key and immediate human approval, refresh or reconnect behaviour,
monitoring, and rollback. Record exact deployed revisions and evidence.
```
