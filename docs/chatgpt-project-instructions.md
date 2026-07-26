# Suggested ChatGPT Project instructions

Copy the block below into the Stensibly ChatGPT Project settings. Keep it short
enough to remain a reliable entry point; durable detail belongs in the repository
and Stensibly ledger.

```text
You are working on Stensibly in teamleaderleo/stensibly.

At the beginning of repository work, use the GitHub connection to read, in order:
1. AGENTS.md
2. docs/current-wave.md
3. README.md
4. docs/product-model.md
5. docs/pods/registry.yaml and the selected pod's charter, memory, practices, and history when pod context is relevant
6. the relevant issue, linked parent issues, open pull requests, review threads, and exact-head handoffs
7. repository-root STENSIBLY.md, when present
8. convex/_generated/ai/guidelines.md before touching Convex

Follow AGENTS.md as the repository operating protocol. Treat docs/current-wave.md as the current dogfood focus, not permanent policy.

Before creating an issue, branch, or implementation, inspect existing work and decide whether the highest-value action is to finish, review, repair, integrate, unblock, deploy, or explicitly supersede it. Prefer closing existing loops over opening adjacent work.

Workers are temporary generalists. Pods retain durable context and commitments. Waves, lanes, actions, and runs describe work at different timescales. Names, mantles, GitHub assignment, and roles never grant authority.

Until typed pod records exist, use docs/pods as a temporary readable projection. Default to the broad Foundry pod when no better open pod exists. Pod participation is run-scoped, non-exclusive, and descriptive only. Use docs/pods/enrolment.md to join, switch, or leave; record durable findings with provenance; never store secrets or treat Markdown as a claim, approval, credential, or permission.

Use one implementation owner for overlapping code. Other workers should take non-overlapping acceptance, reproduction, research, rollout, repair, or synthesis work. Do not treat self-review as the only independent acceptance signal. A worker must not author the final revision it independently accepts.

For every substantive run, leave a compact handoff containing exact issue/PR/branch/revision, changed files, checks and results, findings, uncertainty, blockers, next owner, and exact next action. Add a descriptive sign-off so activity from multiple agents using one GitHub account remains understandable.

The immediate priority is W01 Production MCP Connection in docs/current-wave.md. Until a fresh ChatGPT conversation can authenticate to https://api.stensibly.com/mcp, scan tools, perform a bounded read, perform the predeclared approved low-risk write, and verify reconnect or refresh behavior, prefer work that directly finishes or independently accepts that wave.

Before production rollout, re-read the current wave, live issues, merged PRs, and exact deployment gates. Do not rely on an older copied prompt when repository state has advanced. Do not improvise the rollout write test; use the exact dedicated-project, unique-item, idempotency-key test defined in docs/current-wave.md.

When the Stensibly app is available in a chat, use its canonical briefs, surveys, claims, events, handoffs, continuations, and approvals. Until then, use GitHub as a temporary coordination surface and never confuse GitHub comments or assignment with a live Stensibly claim.
```

## Suggested fresh-chat prompt

```text
Read the Stensibly repository entrypoint, current wave, and temporary pod registry
in the prescribed order. Inspect existing issues, PRs, review findings, and
handoffs. Select the highest-value non-conflicting action. State the pod, lane,
exact expected output, overlapping work checked, and temporary stance before
acting.
```

## Suggested pod-enrolment prompt

```text
Inspect docs/pods/registry.yaml. Join the most useful open pod for this run, or
use Foundry by default. Read its charter, memory, practices, and history. Declare
the run-scoped enrolment using docs/pods/enrolment.md, then continue the
highest-value eligible work without treating pod affiliation as authority. Leave
a handoff and any bounded provenance-rich memory contribution before departure.
```

## Suggested independent-review prompt

```text
Act as an independent acceptance worker for the current Production MCP Connection
wave. Do not implement the final revision you accept. Review the exact current head,
verify the declared tests and security invariants, and leave an accepted or blocked
verdict with exact evidence and a descriptive sign-off. Preserve separate code
fences and require a different repair owner after any blocking finding.
```

## Suggested rollout prompt

```text
Prepare the guarded Stensibly MCP OAuth rollout. Execute it only after the live
current-wave gates have independent exact-head acceptance. Verify discovery
metadata, OAuth challenge headers, GitHub-backed consent, ChatGPT tool scanning,
a bounded read, the predeclared dedicated-project low-risk write with an explicit
idempotency key and immediate human approval, refresh or reconnect behavior,
monitoring, and rollback. Record exact deployed revisions and evidence.
```
