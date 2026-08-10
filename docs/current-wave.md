# Current dogfood wave: durable agent operations

**Status:** active P0 rollout
**Last reconciled:** 2026-08-10
**Exact source base before this revision:** `4f79434ab130a4591fcb04b6dab73f2d4c61a51a`
**Sustained-use incident:** #490
**Programme:** #491
**Canonical queue:** #301
**Operation model:** #154
**Operating protocol:** `stensibly-agent-ops/0.5.0` plus `stensibly-internal-dogfood/v2`

## In simple words / purpose

Stensibly is moving from “another MCP server with GitHub tools” to a durable
agent-operations layer. Raw GitHub reads and writes remain available, but the
product should increasingly expose bounded outcomes such as publishing a
change, landing a pull request, diagnosing CI, tidying branches, and reversing
an operation from its receipt.

The durable layer owns authority, exact preconditions, provider selection,
idempotency, reconciliation, compensation, telemetry, and continuation across
temporary chats and runner processes. GitHub remains the independent source and
recovery record.

## Current verified foundation

### MCP and the ChatGPT surface

PR #1308 directly integrated the self-describing MCP `2026-07-28` transport
alongside the existing Streamable HTTP flow. The modern path supports direct
discovery, list/call, pagination, task polling, protocol headers, and the same
authenticated capability policy.

The current source surface contains 50 public hosted tool names. This revision
stages ChatGPT snapshot v12 with four outcome-oriented GitHub operations:
`github_repo_health`, plan-only `github_branch_tidy`, `github_ci_diagnose`, and
durable head-fenced `github_land_pr`. The names-only fingerprint is:

```text
sha256:bf607cf4d13eb4fcff7af26fb9764c2b2e0ebfc599a7a421677798cbe629ac2a
```

The staged full tool-contract fingerprint is:

```text
sha256:65d6097f8fc33bd67654f9b20359f672d312f87b0de60ceb4f4d09b415582e42
```

These v12 source fingerprints become hosted evidence only after the Worker
release verification passes. The existing ChatGPT app must then be refreshed
or rescanned before v12 dogfood.

### GitHub execution provider

The merged provider stack now has:

- accepted-attachment-derived multi-repository routing under one configured
  GitHub installation/account;
- exact repository and permission token minting;
- governed issue create/update/comment with durable receipts;
- guarded delegated GitHub reads;
- typed create-branch and create-pull-request operations;
- exact-parent create/update-file publication with durable CAS receipts;
- independent branch/pull-request readback reconciliation merged in #1326;
- hosted publication-readback composition merged in #1328;
- protected Convex and Worker deployment workflows with exact-candidate
  verification and recovery.

Raw primitives remain useful and are the implementation pieces for higher-level
operations. They are not the final product boundary.

### Project attachment onboarding

Dogfood on #334 exposed a concrete onboarding gap: ordinary GitHub context could
identify `teamleaderleo/scrapbook` while project `scrapbook` had no accepted
attachment, so guarded repository work stopped at the correct authority fence.

The v11 candidate turns that missing state into a read-only continuation. With
no repository facts, `get_project_attachment` requests the bounded context it
needs. With already-observed GitHub facts, it returns an advisory setup plan
containing the canonical repository/default branch, explicit runner/work
profile, explicit checks, the `STENSIBLY.md` source path, the existing
admin-acceptance step, and a guarded verification recipe. The plan authorizes no
provider effect and first attachment acceptance remains explicit authority
widening.

### Runner adapters

The OpenAI Agents SDK adapter (#945), Vercel AI SDK adapter (#1295), shared
runner host (#1303), and hosted Convex runner parity are merged. These are
alternative model/runtime adapters under the same runner authority and durable
ledger contracts; neither SDK is a second product direction.

The current host slice is deliberately model-free and bounded. It proves exact
capability binding, lease authority, atomic dispatch reservation, checkpoint
privacy, observation limits, and no blind redispatch. A durable command inbox,
full restartable continuation, and live model/provider mounting remain follow-up
work.

## Current composite operation

`github_publish_change` composes three existing provider services under one
durable operation:

```text
exact source commit
  → create/replay branch
  → create or update one file at the exact parent
  → verify the resulting commit
  → open/replay a draft PR at exact head and base SHAs
```

Before every provider call, Stensibly durably reserves the step and rechecks the
current runner authority. Each step retains only identities, digests, closed
states, provider receipt references, and its planned compensation. Patches,
file contents, PR bodies, tokens, and arbitrary provider prose are not stored in
the operation aggregate.

SQLite and Convex implement the same project-scoped reservation, replay,
conflict, and exact-revision transition contract. Ambiguous provider outcomes
or lost workflow settlement halt at `waiting_reconciliation`; replay never
blindly dispatches the provider call again. A monotonic heartbeat extension is
accepted only while run, owner, run generation, and lease generation remain
exact.

Receipt-driven reconciliation repairs lost local settlement. Independent
publication readback can now prove matching branch and retained-identity PR
outcomes without another GitHub mutation. Repository-file ambiguity remains a
separate proof lane because a moved ref alone cannot prove the exact file
effect. Compensation is durable as a plan and lifecycle; automated compensators
remain follow-up work.

`github_land_pr` now reuses that operation spine for one consequential merge.
It requires a current runner lease, an atomically fenced head, a freshly
observed base, clean provider mergeability, no unresolved review threads,
positive successful CI evidence, a durable reservation before dispatch, and
merge-commit base-parent readback. GitHub cannot atomically fence the base; a
base race therefore remains durable reconciliation rather than verified
success. The merge is truthfully irreversible; source-branch cleanup remains
separate.

## Required dogfood lifecycle

```text
fresh authenticated ChatGPT conversation
  → discover/list exact v12 tool surface
  → read accepted GitHub project context
  → read project attachment or its setup recovery
  → create and claim one bounded work item/run
  → call github_publish_change once
  → read operation workflow and provider receipts
  → repeat the same idempotency key without duplicate GitHub effects
  → reconnect ChatGPT
  → read the same workflow and receipts again
  → complete or clean up the bounded work item
```

For an unattached project, stop before repository mutation, follow the advisory
attachment setup plan through explicit admin acceptance, then verify the
accepted attachment and guarded repository reads before resuming repository
work.

The exercise must preserve GitHub usability throughout. Any ambiguous result is
reconciled from durable operation/provider evidence before another write.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | Sustained-use incident (#490) | Transport, diagnostics, provider receipts, composite publication, and publication readback are merged; repeated hosted ChatGPT execution remains the proof gap | Deploy/verify the v12 contract, refresh ChatGPT, and run the complete lifecycle in a fresh authenticated conversation | Repeated same-session and reconnect operations remain available with typed outcomes |
| P0 | Project attachment onboarding (#334/#1329) | Scrapbook dogfood proved `repo known + attachment missing`; v11 recovery is merged | Repeat the Scrapbook setup journey through explicit attachment acceptance and guarded read verification | An unattached known repository leads to one clear setup continuation and becomes repository-ready only after accepted attachment + guarded read proof |
| P1 | Reconciliation and compensation (#154/#1325) | Independent branch/retained-PR readback is merged and hosted-mounted; exact repository-file ambiguity and live hosted proof remain | Add exact file-effect readback, then exact-SHA branch deletion/restoration and PR-close/file-restore compensators | Ambiguous provider outcomes settle from independent evidence and reversible operations can be safely compensated |
| P1 | Operation catalogue | The first four outcome tools are implemented in snapshot v12 | Deploy, refresh ChatGPT, and dogfood `repo_health`, `branch_tidy`, and `ci_diagnose`; land only a dedicated safe PR under a runner lease | Agents can request common outcomes without manually orchestrating long raw-tool chains |
| P1 | Restartable runner execution | Both SDK adapters and the bounded host exist; durable command delivery and continuation remain incomplete | Add the command inbox/observation receipt and checkpoint-lineage contracts before live model mounting | One runner episode survives process restart without duplicate model or tool effects |

## Definition of done for the wave

This wave is complete when fresh authenticated ChatGPT conversations repeatedly
prove:

1. exact MCP discovery, tool registration, and invocation remain stable through
   sustained use and reconnect;
2. raw GitHub primitives and at least one composite operation both work;
3. each write produces a durable, attributable, project-scoped receipt;
4. retries replay or reconcile without duplicate provider effects;
5. an unattached repository already known through GitHub produces a bounded
   setup continuation and cannot become repository-ready before explicit
   attachment acceptance plus guarded verification;
6. the operator can see where a call was catalogued, exposed, invoked, admitted,
   dispatched, accepted, verified, and delivered;
7. reversible operations expose truthful compensation state;
8. GitHub remains independently readable and writable during Stensibly
   degradation;
9. a temporary chat or runner process can disappear without erasing the work,
   authority, evidence, or next action.

## Immediate sequence

1. Integrate, deploy, and verify snapshot v12/50.
2. Refresh the existing ChatGPT app in place and repeat the Scrapbook
   attachment/setup journey from a normal conversation.
3. Dogfood one bounded publish-change operation, exact replay, and publication
   response-loss recovery.
4. Add exact repository-file readback for genuinely ambiguous file effects.
5. Dogfood `repo_health`, plan-only `branch_tidy`, and `ci_diagnose` in ChatGPT.
6. Add exact branch delete/restore compensators before any branch-tidy apply mode.
7. Instrument catalogue → policy → registration → invocation → admission →
   dispatch → provider acceptance → verification → delivery as one traceable
   capability journey.

— Keel · durable GitHub operations
  Intention: ship compact outcome tools with exact authority, receipts, and recovery
