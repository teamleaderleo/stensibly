# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-08 after delegated-read activation merged and hosted verifier ordering converged  
**Current main:** `88f400b070862f01a58ead18ad05c4e7e6be98cb`  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `31`  
**Operating protocol:** `stensibly-agent-ops/0.5.0` plus standing policy `stensibly-internal-dogfood/v2`

## Purpose

Keep GitHub and Stensibly usable together through sustained ChatGPT work, repeated reads and writes, explicit reconciliation, disconnect/reconnect, and recovery.

GitHub remains the independent repository, review, CI, and recovery record. Stensibly adds responsibility, authority, continuation, provider receipts, and execution history when its connector is available. A repository merge is not live hosted proof unless an authenticated endpoint receipt is recorded separately.

## Required lifecycle

```text
GitHub repository and issue reads
  → Stensibly survey
  → create
  → claim
  → progress event
  → artifact attachment
  → read back
  → complete with exact continuation
  → reread
  → governed Stensibly-to-GitHub write
  → provider receipt reconciliation
  → further GitHub read/write
  → disconnect/reconnect
  → repeat bounded read/write
```

W01 completes only after repeated same-conversation execution and reconnect recovery pass with typed outcomes and attributable evidence.

## Current verified repository state

### Mainline capability

Current `main` is `88f400b070862f01a58ead18ad05c4e7e6be98cb`, merged from #1168.

Recent landed packets include:

- #1134 fixture-only Work Pulse operator view;
- #1150 bounded automatic activity observations;
- #1154 shared UTF-16 code-unit ordering;
- #1138 descriptor-safe provider method capture;
- #1152 exactly-once authority-free activity ingestion;
- #1174 and #1182 shared retained-credential policy adoption in execution-certainty and work-stack projection;
- #1158 hardened detached Project Brief admission;
- #1187 full MCP action-contract snapshot protection;
- #1190 read-only GitHub repository binding facts for future Project Pulse composition;
- #1191 bounded hosted MCP `tools/list` contract verification composed into `verify:hosted`;
- #1168 configured delegated GitHub reads and job-detail reads default-on under complete hosted provider configuration, with exact `false` kill switches and unchanged fail-closed provider admission.

These repository facts do not by themselves prove current production deployment, refreshed ChatGPT app state, connector recovery, or successful authenticated live calls.

### Hosted MCP verification

#1191 is merged. `verify:hosted` checks the live MCP tool catalogue against the checked-in full action contract rather than only a coarse manifest count/fingerprint.

Current follow-ups now have an explicit parent-first order:

1. **#1194 — hosted `tools/list` verifier hardening.** Exact current-main candidate `5667bf5d4553a0360ffd80c5f6a7f21a5b8e3ecc`, one commit ahead of `main@88f400b…`, six workflow-free files. It requires exact JSON-RPC identity, status-first rejection, strict duplicate-key-rejecting JSON, independent byte/chunk ceilings, intrinsic typed-array byte admission, best-effort cleanup containment, and Web Streams intrinsic reader acquisition/read/cancel/release. CodeRabbit is green, review threads are empty, source review is complete, and canonical run `31235833720` is pending before job allocation.
2. **#1193 — one real stable MCP read.** Its nine-file stable-read packet is source-reviewed, including strict outer/inner JSON, exact project scope, bounded Worker/request evidence, byte/chunk/text ceilings, intrinsic byte admission, cleanup containment, and Web Streams intrinsic reader lifecycle. Its current branch is based on pre-#1168 main and therefore has no integration authority. After #1194 lands, replay the exact stable-read files onto that new main and renew all canonical/serial/exact-ref/terminal gates.
3. **#1192 — deployment receipt wording.** This packet only reports the protected post-deploy command generically as `Hosted API + MCP verification` on both origins. It changes no verifier behavior. Its current execution evidence predates the #1168 main advance and must be replayed/revalidated after the verifier chain settles before integration.

None of these open PRs is live endpoint evidence until merged, deployed through the governed path, and observed against the configured hosted origins.

### Project Pulse foundations

Merged foundations include:

- fixture-only Work Pulse (#1134);
- automatic activity observation (#1150);
- exactly-once activity ingestion (#1152);
- detached Project Brief compilation/admission (#1158);
- read-only GitHub repository binding facts (#1190).

Open foundations:

- #1171 causal operator-attention projection remains under source/test convergence machinery; do not review or merge a workflow-bearing head as source;
- #1159 return-to-work delta compilation is under revoked-Proxy repair machinery. Preserve the shared `requirePlainObject` compatibility export while #1222 and #1159 can land in either order;
- #1222 work-stack caller admission has a source-reviewed descriptor-only caller boundary and a compatibility export for detached compiler consumers, but its current head predates the #1168 main advance and requires current-main replay before integration;
- #1000 observation Merkle checkpoints remains under caller-inspection repair/convergence;
- #1160 reusable execution recipes remains under closed direct-descriptor convergence;
- #1200 capability-policy simulation remains under semantic convergence machinery that must preserve approval widening, receipt/reconciliation changes, complete source-reference accounting, and exclusive unknown classification before a workflow-free candidate exists.

No live Project Pulse aggregate endpoint, durable attention store, notification path, or autonomous decision surface is claimed.

### GitHub context and governed issue writes

The typed GitHub issue-write and project-context foundations remain merged from the earlier W01 chain. Hosted issue writes remain exact opt-in: `STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED=true` is required with complete accepted provider configuration and durable receipts.

Default-on issue-write proposals were closed without merge. Do not describe hosted writes as default-on.

Configured delegated-read default-on policy is now merged in #1168. Only `STENSIBLY_GITHUB_DELEGATED_READS_ENABLED` and `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED` default on when hosted GitHub provider configuration is present. Exact `false` remains the independent recovery switch, generic exact-boolean fields remain default-off, and partial/malformed configuration still fails closed.

That merge is an activation-policy repository fact, not authenticated hosted evidence. #697 still requires a deployed delegated GitHub job step/log receipt against the accepted hosted declaration.

### Private native repository-write chain

The native repository-file transport stays private and has no current `main` integration authority.

Absorbed prerequisites in #1020 include shared repository/ref/path/object admission and bounded repository-scoped installation-token profiles.

The previous `force:false` REST ref update was rejected as an exact-CAS primitive because fast-forward acceptance does not prove the observed old OID remained current. The active direction is provider-native GraphQL `updateRefs` compare-and-swap with an exact old OID.

Current CAS work:

- #1210 is the static, provider-call-free repaired CAS contract. Its reviewed source binds one provider-admitted repository receipt to normalized GraphQL endpoint + canonical repository + opaque node ID, derives the mutation endpoint only from that receipt, uses a full SHA-256 mutation identity over endpoint/repository/node/ref/old/new/object format, and keeps exact old/new OIDs with `force:false`. It has zero independent merge authority and must be absorbed into #1201/#1208 after fresh canonical execution.
- #1208 is the direct adapter integration target. Repository-node lookup occurs before write-side Git object creation and `updateRefs` receives exact repository/ref/old/new identities. Current source acceptance remains contingent on fixed provider-response admission before later response-lifetime/post-effect layers rely on it.
- #1185 is a provider-call-free receive-pack exact-CAS fallback contract. Its wire semantics and revoked-input normalization are technically reviewed, but it has no independent integration authority and requires a separately reviewed authenticated transport if selected.
- #1201 remains the pure CAS parent/convergence lane; workflow-bearing repair heads have no source authority.

Required private order is now:

```text
shared admission + combined installation tokens
  → exact provider-bound GraphQL updateRefs CAS contract
  → direct adapter integration with fixed response admission
  → total response lifetime + request attribution
  → canonical landed-tree settlement
  → verified post-effect service retention
  → consolidated workflow-free #1020 current-main replay
```

No native repository-write packet may be mounted hosted or exposed publicly before that private chain converges and receives a separate current-main integration review.

### Private label/assignee issue-write chain

#968 is under private label/assignee mutation and response-settlement convergence. Transition or red-control heads have zero integration authority.

#970 public typed label/assignee actions remain blocked behind the final private #968 parent and a fresh public manifest/capability/current-main replay. Do not integrate a stale stacked public head independently.

### Outbound-reference admission

#987 remains the sole integration owner for outbound GitHub text-preflight convergence. Current red-control children must be absorbed into that parent rather than merged independently.

## Live evidence still required

W01 remains open because repository CI does not prove sustained hosted use. Fresh authenticated evidence is still required for:

1. #490 — repeated create/claim/event/artifact/read/complete/reread execution plus reconnect in one conversation;
2. #921 — authorised idempotent GitHub issue create/update/comment with durable receipt lookup and no duplicate effect on exact replay;
3. #492 — authorised hosted `get_github_project_context` use inside a sustained lifecycle;
4. #697 — deployed delegated GitHub job step/log receipt on the now-merged default-on declaration;
5. #537 — governed deployment receipt proving the merged hosted verification command against both configured origins, followed by the bounded real MCP read once #1194 and replayed #1193 land.

GitHub must remain independently readable and writable while Stensibly is degraded.

## Current execution constraint

GitHub Actions runner allocation remains the limiting repository resource for several otherwise source-reviewed packets. The exact current-main #1194 run `31235833720` is pending before job allocation. Older-base queued, completed, or partially completed runs on #1193/#1192/#1222 are non-authorizing after the #1168 main advance.

Queued, pending, cancelled, carrier, predecessor, and stale-head runs remain non-authorizing. Do not merge around required CI, but continue source review, bounded repairs, replay preparation, and queue reconciliation while runners are unavailable.

## Failure handling

When a step fails:

- identify the exact failing stage and responsible surface where possible;
- preserve bounded evidence, operation identity, and ambiguity identity;
- reconcile a possible successful mutation before retrying;
- keep queued, cancelled, workflow-carrier, red-control, stale-parent, and predecessor receipts non-authorizing;
- repair and rerun on the exact final source head;
- leave GitHub with one current fact and one executable next action.

A failed dogfood attempt should produce a sharper control, diagnostic, or bounded repair.

## Immediate execution order

1. complete #1194 on exact current main; merge only after repository/browser/runtime, serial-full, checksum-valid exact-ref receipt, CodeRabbit, empty threads, unchanged ancestry/mergeability, and terminal review all pass;
2. replay #1193's exact stable-read packet on the resulting main, renew all gates, integrate it, then let the governed deploy path exercise the hardened full-contract check plus the real stable read against both hosted origins;
3. replay/revalidate #1192 after the verifier chain settles so the deployment receipt describes the whole final hosted API + MCP verification command;
4. replay source-reviewed older-base candidates such as #1222 only after the P0 verifier chain stops moving main; let workflow-bearing #1159/#1171/#1000/#1160/#1200/#987/#968 convergence publish before integration review;
5. continue the private exact-CAS chain without treating provider-call-free or workflow-bearing packets as integration-ready;
6. collect governed live #537/#490/#921/#492/#697 receipts without using repository merges as a substitute for hosted proof.

## Definition of done

W01 completes when fresh authenticated ChatGPT conversations repeatedly prove:

- repository instructions and backlog stay readable;
- authentication, discovery, refresh, and reconnect recover correctly;
- Stensibly tools remain executable through sustained use;
- the full item lifecycle succeeds repeatedly;
- ambiguous mutations reconcile deterministically before replay;
- governed GitHub writes return durable actor-bound receipts without duplicate effects;
- GitHub context and delegated reads remain bounded and attributable;
- disconnect/reconnect restores authorised functionality;
- diagnostics identify the failing layer without exposing secrets;
- GitHub remains an independent recovery path throughout degradation.

A single successful login, catalogue read, deployment, merge, or provider write does not complete W01.

— Turnstile · W01 revision 31 reconciliation  
  Intention: keep one exact GitHub-verifiable campaign record while hosted proof remains separate
