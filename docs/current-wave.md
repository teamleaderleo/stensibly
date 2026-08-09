# Current dogfood wave: durable agent operations

**Status:** active P0 rollout
**Last reconciled:** 2026-08-10
**Exact live base before this revision:** `3682ca3ec7e9617771d90b69b2936cde9ec12dcc`
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
authenticated capability policy. This is real repository and runtime work, not
an unstarted “MCP v2” roadmap item.

At the exact base above, the hosted Worker and Convex deployment serve the v9
contract with 45 tools. This revision stages snapshot v10 with 46 tools:

- searchable `github_publish_change`;
- read-only `get_operation_workflow`;
- searchable `reconcile_github_publish_change`.

The staged hosted names-only fingerprint is:

```text
sha256:7f410756f91d18c6325fa6e1d75f41c7a5523b3e6604f5f23c1b6ce7cbced318
```

The staged full tool-contract fingerprint is:

```text
sha256:cd66a9a6824642e2145e6aac944d6015bc7fd3c60276030780cd81814780683e
```

These v10 fingerprints are not live evidence until the Worker deploy and hosted
verification pass, then the existing ChatGPT app is refreshed in place.

### GitHub execution provider

The merged provider stack now has:

- accepted-attachment-derived multi-repository routing under one configured
  GitHub installation/account;
- exact repository and permission token minting;
- governed issue create/update/comment with durable receipts;
- guarded delegated GitHub reads;
- typed create-branch and create-pull-request operations;
- exact-parent create/update-file publication with durable CAS receipts;
- protected Convex and Worker deployment workflows with exact-candidate
  verification and recovery.

Raw primitives remain useful and are the implementation pieces for higher-level
operations. They are not the final product boundary.

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

## Current composite operation and this revision

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

The first slice is intentionally bounded to one file. This revision adds a
receipt-driven reconciler for lost workflow settlement. The caller resubmits
the exact original bounded request, Stensibly recomputes every retained digest,
and an already-settled branch/file/PR receipt can advance the workflow without
another GitHub write. Missing or ambiguous receipts remain blocked. Compensation
is durable as a plan and lifecycle, but automated compensators are not yet mounted.

## Required dogfood lifecycle

```text
fresh authenticated ChatGPT conversation
  → discover/list exact v10 tool surface
  → read accepted GitHub project context
  → create and claim one bounded work item/run
  → call github_publish_change once
  → read operation workflow and provider receipts
  → repeat the same idempotency key without duplicate GitHub effects
  → reconnect ChatGPT
  → read the same workflow and receipts again
  → complete or clean up the bounded work item
```

The exercise must preserve GitHub usability throughout. Any ambiguous result is
reconciled from the durable operation and provider keys before another write.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | First operation rollout (#154) | The composer is merged and live at `d7a5b89a`; receipt-driven workflow reconciliation is in this candidate | Deploy the 46-tool contract, refresh ChatGPT, and dogfood one exact branch→file→PR journey including response-loss recovery | Hosted success, reconciliation, and exact replay produce one branch, one commit, one PR, and durable readback across reconnect |
| P0 | Sustained-use incident (#490) | Transport, diagnostics, provider receipts, and deployment controls are materially stronger; repeated ChatGPT execution remains the proof gap | Run the complete lifecycle above in a fresh authenticated conversation | Repeated same-session and reconnect operations remain available with typed outcomes |
| P1 | Reconciliation and compensation | Settled provider receipts can now repair lost workflow settlement without redispatch; truly ambiguous provider outcomes still require independent readback | Add exact provider readback reconciliation, then exact-SHA branch deletion/restoration and PR-close/file-restore compensators | Ambiguous provider outcomes settle from independent evidence and reversible operations can be safely compensated |
| P1 | Operation catalogue | Raw provider reach is broad but model exposure should stay compact | Add `repo_health`, plan-only `branch_tidy`, then `land_pr` and `ci_diagnose` behind searchable capability discovery | Agents can request common outcomes without manually orchestrating long raw-tool chains |
| P1 | Restartable runner execution | Both SDK adapters and the bounded host exist; durable command delivery and continuation remain incomplete | Add the command inbox/observation receipt and checkpoint-lineage contracts before live model mounting | One runner episode survives process restart without duplicate model or tool effects |

## Definition of done for the wave

This wave is complete when fresh authenticated ChatGPT conversations repeatedly
prove:

1. exact MCP discovery, tool registration, and invocation remain stable through
   sustained use and reconnect;
2. raw GitHub primitives and at least one composite operation both work;
3. each write produces a durable, attributable, project-scoped receipt;
4. retries replay or reconcile without duplicate provider effects;
5. the operator can see where a call was catalogued, exposed, invoked, admitted,
   dispatched, accepted, verified, and delivered;
6. reversible operations expose truthful compensation state;
7. GitHub remains independently readable and writable during Stensibly
   degradation;
8. a temporary chat or runner process can disappear without erasing the work,
   authority, evidence, or next action.

## Immediate sequence

1. Integrate and deploy receipt-driven workflow reconciliation.
2. Verify the hosted v10/46 contract and refresh the existing ChatGPT app; do not
   recreate it unless the host refuses an in-place refresh.
3. Dogfood one bounded publish-change operation and exact replay.
4. Add independent provider readback for receipts that remain genuinely ambiguous.
5. Add `repo_health`, then plan-only `branch_tidy` before branch deletion.
6. Add exact compensators and build `land_pr` from the same operation spine.
7. Instrument catalogue → policy → registration → invocation → admission →
   dispatch → provider acceptance → verification → delivery as one traceable
   capability journey.

— Keel · durable operations reconciliation
  Intention: ship the first outcome-oriented GitHub operation and prove it through ChatGPT
