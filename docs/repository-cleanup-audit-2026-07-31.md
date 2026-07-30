# Repository cleanup audit — 2026-07-31

**Branch base:** `226e5b7ff7dc2e656193411921a3431f28d018f9`  
**Callsign:** Kite  
**Scope:** tracked repository content only; generated Convex output is excluded from code-size rankings.

## Executive findings

1. **Keep the domain split.** Pure authority, idempotency, receipt, and reconciliation cores are a strong design choice. SQLite and Convex parity tests are purposeful when they prove the same invariant through different adapters.
2. **Extract the remote MCP test harness.** Protocol headers, JSON-RPC envelopes, request dispatch, initialization, tool calls, and text-result parsing are copied across many suites. This is the clearest low-risk duplication removal.
3. **Reduce source-string contract tests.** Dashboard tests heavily assert implementation text. Keep a small wiring smoke layer, move behavior into importable pure modules, and test those modules directly. String assertions have already drifted after behavior-preserving edits.
4. **Make compatibility intentional.** Local unversioned API routes, legacy execution envelopes, fallback endpoints, and migration readers need explicit owners and removal triggers. Compatibility can stay, but every path should have evidence that it still earns its cost.
5. **Treat mirrored agent assets as generated artifacts.** The `.agents` and `.claude` trees contain overlapping files. Preserve tool-required locations, choose one source of truth, and enforce synchronization instead of hand-editing both copies.
6. **Split only the largest orchestration files.** Prefer extraction around stable concepts—request parsing, response mapping, authorization, reconciliation—rather than creating thin one-function files.
7. **Delete temporary workflow carriers promptly.** Source-only pull-request heads are easier to review and reduce queue noise. Permanent reusable workflows should replace repeated embedded repair recipes where the same operation recurs.

## Repository inventory

- Tracked files: **700**
- Production code lines: **67,803**
- Test code lines: **45,771**
- Total TypeScript/JavaScript lines: **113,574**
- Test-to-production line ratio: **0.68**
- Workflow files on the audited branch before self-removal: **10**

### Files by top-level area

| Area | Files |
| --- | ---: |
| `test` | 212 |
| `src` | 154 |
| `convex` | 86 |
| `site` | 81 |
| `docs` | 56 |
| `.agents` | 30 |
| `.claude` | 30 |
| `.github` | 20 |
| `model` | 8 |
| `.greptile` | 3 |
| `.coderabbit.yaml` | 1 |
| `.env.example` | 1 |
| `.gitignore` | 1 |
| `ADAPTIVE_COORDINATION.md` | 1 |
| `AGENTS.md` | 1 |
| `CLAUDE.md` | 1 |
| `LICENSE` | 1 |
| `POSTMORTEMS.md` | 1 |
| `README.md` | 1 |
| `STENSIBLY.md` | 1 |
| `bun.lock` | 1 |
| `package.json` | 1 |
| `probes` | 1 |
| `scripts` | 1 |
| `server.ts` | 1 |
| `skills-lock.json` | 1 |
| `tsconfig.json` | 1 |
| `vercel.json` | 1 |
| `vitest.config.ts` | 1 |
| `wrangler.jsonc` | 1 |

### Largest code files

| File | Lines | Bytes |
| --- | ---: | ---: |
| `src/tool-capability-grants-sqlite.ts` | 1,413 | 45,095 |
| `src/tool-capability-grant.ts` | 1,355 | 46,602 |
| `model/claim-run/check.ts` | 1,065 | 29,214 |
| `src/runs-core.ts` | 1,004 | 33,904 |
| `src/hosted-auth.ts` | 953 | 31,169 |
| `convex/mcpOAuth.ts` | 937 | 33,042 |
| `src/continuations.ts` | 923 | 26,445 |
| `src/promises.ts` | 921 | 29,880 |
| `convex/continuationSupervisor.ts` | 860 | 28,755 |
| `convex/mcpOAuthClientLifecycle.test.ts` | 860 | 32,016 |
| `src/project-attachment-contract.ts` | 836 | 28,959 |
| `src/github-issue-context-sqlite.ts` | 832 | 28,039 |
| `src/github-issue-provider-service.ts` | 814 | 28,142 |
| `convex/mcpOAuthClientLifecycle.ts` | 742 | 26,188 |
| `src/verify-oauth-abuse.ts` | 720 | 24,458 |
| `src/store.ts` | 699 | 18,809 |
| `src/provider-capacity.ts` | 685 | 21,961 |
| `test/mcp-oauth.test.ts` | 672 | 22,937 |
| `test/tool-capability-grants-sqlite.test.ts` | 662 | 22,010 |
| `convex/accounts.ts` | 657 | 20,667 |
| `convex/continuations.ts` | 650 | 21,343 |
| `test/tool-capability-grant.test.ts` | 643 | 22,100 |
| `src/external-effect-proposal.ts` | 629 | 22,547 |
| `src/dispatcher-core.ts` | 623 | 18,877 |
| `src/github-callsign-registry.ts` | 623 | 20,777 |
| `site/app.js` | 619 | 19,774 |
| `src/github-webhook-api.ts` | 603 | 18,971 |
| `site/item-detail-controller.js` | 597 | 21,117 |
| `test/github-webhook-events.test.ts` | 585 | 19,642 |
| `src/smolrunner-receipt-intake.ts` | 573 | 22,126 |

### Largest test files

| File | Lines |
| --- | ---: |
| `convex/mcpOAuthClientLifecycle.test.ts` | 860 |
| `test/mcp-oauth.test.ts` | 672 |
| `test/tool-capability-grants-sqlite.test.ts` | 662 |
| `test/tool-capability-grant.test.ts` | 643 |
| `test/github-webhook-events.test.ts` | 585 |
| `convex/mcpOAuthRefreshFamilyFollowup.test.ts` | 521 |
| `test/hosted-auth.test.ts` | 475 |
| `test/mcp-oauth-rejections.test.ts` | 475 |
| `test/github-issue-provider.test.ts` | 470 |
| `test/coderabbit-capacity.test.ts` | 443 |
| `convex/ledger.test.ts` | 442 |
| `convex/itemControl.test.ts` | 424 |
| `test/convex-ledger.test.ts` | 419 |
| `test/verify-oauth-abuse.test.ts` | 419 |
| `test/github-issue-context-sqlite.test.ts` | 417 |
| `test/runs.test.ts` | 416 |
| `convex/mcpOAuth.test.ts` | 412 |
| `test/verify-oauth-hosted.test.ts` | 408 |
| `convex/accounts.test.ts` | 407 |
| `test/item-control.test.ts` | 406 |
| `convex/mcpOAuthRefreshFamily.test.ts` | 395 |
| `test/dashboard-item-detail.test.ts` | 393 |
| `convex/providerMembershipAudit.test.ts` | 365 |
| `test/mcp.test.ts` | 358 |
| `test/hosted-rest-session-auth.test.ts` | 355 |

## Repeated test helpers

Named local functions appearing in at least three test files:

| Helper | Files | Sample locations |
| --- | ---: | --- |
| `createItem` | 30 | `convex/boundedHistoryContract.test.ts`<br>`convex/completion-parity.test.ts`<br>`convex/completionContinuations.test.ts`<br>`convex/continuationEdits.test.ts`<br>`convex/continuationSupervisor.test.ts`<br>`convex/continuations.test.ts` |
| `toolCall` | 15 | `test/context-mcp-http.test.ts`<br>`test/continuation-edit-api.test.ts`<br>`test/continuation-inbox-api.test.ts`<br>`test/continuation-supervisor-api.test.ts`<br>`test/mcp-ambiguous-retry-idempotency.test.ts`<br>`test/mcp-github-issue-provider.test.ts` |
| `mcpRequest` | 13 | `test/context-mcp-http.test.ts`<br>`test/continuation-edit-api.test.ts`<br>`test/continuation-inbox-api.test.ts`<br>`test/continuation-supervisor-api.test.ts`<br>`test/mcp-ambiguous-retry-idempotency.test.ts`<br>`test/mcp-diagnostics.test.ts` |
| `bearer` | 10 | `test/api-v1.test.ts`<br>`test/coderabbit-capacity.test.ts`<br>`test/context-packets.test.ts`<br>`test/continuation-api.test.ts`<br>`test/continuation-edit-api.test.ts`<br>`test/continuation-inbox-api.test.ts` |
| `initialize` | 7 | `test/mcp-ambiguous-retry-idempotency.test.ts`<br>`test/mcp-github-issue-provider.test.ts`<br>`test/mcp-github-project-slug-boundary.test.ts`<br>`test/mcp-http-reconnect.test.ts`<br>`test/mcp-oauth.test.ts`<br>`test/mcp-operation-receipts.test.ts` |
| `propose` | 7 | `convex/continuationEdits.test.ts`<br>`convex/continuationSupervisor.test.ts`<br>`test/continuation-edit-api.test.ts`<br>`test/continuation-edit.test.ts`<br>`test/continuation-inbox-api.test.ts`<br>`test/continuation-inbox.test.ts` |
| `deterministicRandomBytes` | 5 | `test/hosted-app-auth.test.ts`<br>`test/hosted-auth.test.ts`<br>`test/mcp-oauth-hardening.test.ts`<br>`test/mcp-oauth-rejections.test.ts`<br>`test/mcp-oauth.test.ts` |
| `dispatch` | 5 | `test/run-item-projection.test.ts`<br>`test/run-item-recovery.test.ts`<br>`test/runner-concurrency.test.ts`<br>`test/runner-mcp-http.test.ts`<br>`test/runner-queue.test.ts` |
| `issue` | 5 | `test/github-issue-context-sqlite.test.ts`<br>`test/github-issue-provider.test.ts`<br>`test/github-provider-boundaries.test.ts`<br>`test/mcp-github-issue-provider.test.ts`<br>`test/mcp-github-project-context.test.ts` |
| `input` | 4 | `convex/providerCapacities.test.ts`<br>`test/external-effect-proposal-budget.test.ts`<br>`test/external-effect-proposal.test.ts`<br>`test/setup-status.test.ts` |
| `jsonResponse` | 4 | `test/verify-hosted.test.ts`<br>`test/verify-oauth-abuse.test.ts`<br>`test/verify-oauth-challenge-parser.test.ts`<br>`test/verify-oauth-hosted.test.ts` |
| `mcpHeaders` | 4 | `test/async-auth.test.ts`<br>`test/hosted-app.test.ts`<br>`test/mcp-http.test.ts`<br>`test/project-attachment-control-plane.test.ts` |
| `refreshId` | 4 | `convex/mcpOAuthClientLifecycle.test.ts`<br>`convex/mcpOAuthHardening.test.ts`<br>`convex/mcpOAuthRefreshFamily.test.ts`<br>`convex/mcpOAuthRefreshFamilyFollowup.test.ts` |
| `signedHeaders` | 4 | `test/coderabbit-capacity.test.ts`<br>`test/github-webhook-bot-actors.test.ts`<br>`test/github-webhook-events.test.ts`<br>`test/hosted-provider-capacity-api.test.ts` |
| `textContent` | 4 | `test/completion-continuation-mcp.test.ts`<br>`test/mcp-http-reconnect.test.ts`<br>`test/mcp-legacy-chatgpt-snapshot.test.ts`<br>`test/mcp.test.ts` |
| `attachment` | 3 | `test/github-issue-context-sqlite.test.ts`<br>`test/github-issue-context-synchronization-order.test.ts`<br>`test/github-issue-provider.test.ts` |
| `audit` | 3 | `convex/mcpOAuthClientLifecycleAudit.test.ts`<br>`convex/mcpOAuthClientLifecycleAuditBounds.test.ts`<br>`convex/providerMembershipAudit.test.ts` |
| `clientId` | 3 | `convex/mcpOAuthClientLifecycle.test.ts`<br>`convex/mcpOAuthRefreshFamily.test.ts`<br>`convex/mcpOAuthRefreshFamilyFollowup.test.ts` |
| `clientRecord` | 3 | `convex/mcpOAuthClientLifecycle.test.ts`<br>`convex/mcpOAuthClientLifecycleAudit.test.ts`<br>`convex/mcpOAuthClientLifecycleAuditBounds.test.ts` |
| `codeId` | 3 | `convex/mcpOAuthClientLifecycle.test.ts`<br>`convex/mcpOAuthRefreshFamily.test.ts`<br>`convex/mcpOAuthRefreshFamilyFollowup.test.ts` |
| `createCode` | 3 | `convex/mcpOAuth.test.ts`<br>`convex/mcpOAuthClientLifecycle.test.ts`<br>`convex/mcpOAuthHardening.test.ts` |
| `grant` | 3 | `test/mcp-oauth-hardening.test.ts`<br>`test/mcp-oauth-rejections.test.ts`<br>`test/tool-capability-grants-sqlite.test.ts` |
| `initializeMessage` | 3 | `test/mcp-diagnostics.test.ts`<br>`test/mcp-http-cleanup.test.ts`<br>`test/mcp-http.test.ts` |
| `item` | 3 | `test/convex-ledger.test.ts`<br>`test/item-control.test.ts`<br>`test/survey.test.ts` |
| `options` | 3 | `test/hosted-auth.test.ts`<br>`test/mcp-oauth-hardening.test.ts`<br>`test/verify-oauth-abuse.test.ts` |
| `registerClient` | 3 | `convex/mcpOAuth.test.ts`<br>`convex/mcpOAuthHardening.test.ts`<br>`test/mcp-oauth.test.ts` |
| `request` | 3 | `test/callsign-lifecycle.test.ts`<br>`test/pod-participation.test.ts`<br>`test/provider-quota-policy.test.ts` |
| `runnerRequest` | 3 | `test/runner-authority-fence-http.test.ts`<br>`test/runner-concurrency.test.ts`<br>`test/runner-mcp-http.test.ts` |
| `scheduledArgs` | 3 | `convex/mcpOAuthClientLifecycle.test.ts`<br>`convex/mcpOAuthRefreshFamily.test.ts`<br>`convex/mcpOAuthRefreshFamilyFollowup.test.ts` |
| `scheduledFunctions` | 3 | `convex/mcpOAuthClientLifecycle.test.ts`<br>`convex/mcpOAuthRefreshFamily.test.ts`<br>`convex/mcpOAuthRefreshFamilyFollowup.test.ts` |
| `sessionContext` | 3 | `test/hosted-auth.test.ts`<br>`test/mcp-oauth-rejections.test.ts`<br>`test/mcp-oauth.test.ts` |
| `setup` | 3 | `convex/mcpOAuthRefreshFamily.test.ts`<br>`convex/mcpOAuthRefreshFamilyFollowup.test.ts`<br>`test/github-issue-provider.test.ts` |
| `snapshot` | 3 | `test/effective-tool-surface.test.ts`<br>`test/project-attachment-control-plane.test.ts`<br>`test/provider-quota-policy.test.ts` |
| `toolClass` | 3 | `test/effective-tool-surface-conformance.test.ts`<br>`test/effective-tool-surface-events.test.ts`<br>`test/effective-tool-surface.test.ts` |
| `transition` | 3 | `test/dispatcher.test.ts`<br>`test/promise-wakeup-model.test.ts`<br>`test/runs.test.ts` |

### Recommended first extraction

Create `test/support/mcp-http.ts` with one protocol version, header builder, JSON-RPC message builders, app request helper, typed result reader, and explicit error reader. Migrate foundational HTTP suites first; let feature branches adopt the helper when they rebase.

## Source-string contract tests

Files loading implementation source and asserting `.toContain(...)`: **20**

| Test | String assertions | Lines |
| --- | ---: | ---: |
| `test/dashboard-item-detail-contract.test.ts` | 74 | 103 |
| `test/dashboard-item-handoff-contract.test.ts` | 66 | 97 |
| `test/dashboard-item-complete-contract.test.ts` | 65 | 96 |
| `test/dashboard-project-brief-contract.test.ts` | 59 | 96 |
| `test/dashboard-board-filter-contract.test.ts` | 58 | 82 |
| `test/dashboard-item-block-contract.test.ts` | 56 | 90 |
| `test/dashboard-item-lease-renewal-contract.test.ts` | 54 | 80 |
| `test/dashboard-actor-activity-contract.test.ts` | 52 | 77 |
| `test/dashboard-item-claim-contract.test.ts` | 50 | 80 |
| `test/dashboard-item-progress-contract.test.ts` | 49 | 73 |
| `test/dashboard-item-create-contract.test.ts` | 45 | 74 |
| `test/dashboard-item-lease-state-contract.test.ts` | 45 | 72 |
| `test/dashboard-item-semantic-generation-contract.test.ts` | 30 | 56 |
| `test/dashboard-hosted-refresh-contract.test.ts` | 28 | 42 |
| `test/dashboard-session-context-contract.test.ts` | 28 | 54 |
| `test/dashboard-deployment-docs.test.ts` | 20 | 38 |
| `test/review-capacity-gate.test.ts` | 17 | 30 |
| `test/mcp-legacy-chatgpt-snapshot.test.ts` | 7 | 257 |
| `test/verify-dashboard.test.ts` | 5 | 173 |
| `test/promise-wakeup-model.test.ts` | 3 | 220 |

**Refactor rule:** preserve one integration assertion for wiring, then export the decision logic from browser modules and test inputs/outputs. Source-text checks should guard only constraints that cannot be observed through a public function or DOM behavior.

## Exact duplicate and mirrored files

- Exact duplicate text groups: **30**
- `.agents`/`.claude` relative-path pairs: **30**
- Identical mirrored pairs: **30**

- `.agents/skills/convex-create-component/SKILL.md`, `.claude/skills/convex-create-component/SKILL.md`
- `.agents/skills/convex-create-component/agents/openai.yaml`, `.claude/skills/convex-create-component/agents/openai.yaml`
- `.agents/skills/convex-create-component/assets/icon.svg`, `.claude/skills/convex-create-component/assets/icon.svg`
- `.agents/skills/convex-create-component/references/advanced-patterns.md`, `.claude/skills/convex-create-component/references/advanced-patterns.md`
- `.agents/skills/convex-create-component/references/hybrid-components.md`, `.claude/skills/convex-create-component/references/hybrid-components.md`
- `.agents/skills/convex-create-component/references/local-components.md`, `.claude/skills/convex-create-component/references/local-components.md`
- `.agents/skills/convex-create-component/references/packaged-components.md`, `.claude/skills/convex-create-component/references/packaged-components.md`
- `.agents/skills/convex-migration-helper/SKILL.md`, `.claude/skills/convex-migration-helper/SKILL.md`
- `.agents/skills/convex-migration-helper/agents/openai.yaml`, `.claude/skills/convex-migration-helper/agents/openai.yaml`
- `.agents/skills/convex-migration-helper/assets/icon.svg`, `.claude/skills/convex-migration-helper/assets/icon.svg`
- `.agents/skills/convex-migration-helper/references/migration-patterns.md`, `.claude/skills/convex-migration-helper/references/migration-patterns.md`
- `.agents/skills/convex-migration-helper/references/migrations-component.md`, `.claude/skills/convex-migration-helper/references/migrations-component.md`
- `.agents/skills/convex-performance-audit/SKILL.md`, `.claude/skills/convex-performance-audit/SKILL.md`
- `.agents/skills/convex-performance-audit/agents/openai.yaml`, `.claude/skills/convex-performance-audit/agents/openai.yaml`
- `.agents/skills/convex-performance-audit/assets/icon.svg`, `.claude/skills/convex-performance-audit/assets/icon.svg`
- `.agents/skills/convex-performance-audit/references/function-budget.md`, `.claude/skills/convex-performance-audit/references/function-budget.md`
- `.agents/skills/convex-performance-audit/references/hot-path-rules.md`, `.claude/skills/convex-performance-audit/references/hot-path-rules.md`
- `.agents/skills/convex-performance-audit/references/occ-conflicts.md`, `.claude/skills/convex-performance-audit/references/occ-conflicts.md`
- `.agents/skills/convex-performance-audit/references/subscription-cost.md`, `.claude/skills/convex-performance-audit/references/subscription-cost.md`
- `.agents/skills/convex-quickstart/SKILL.md`, `.claude/skills/convex-quickstart/SKILL.md`
- `.agents/skills/convex-quickstart/agents/openai.yaml`, `.claude/skills/convex-quickstart/agents/openai.yaml`
- `.agents/skills/convex-quickstart/assets/icon.svg`, `.claude/skills/convex-quickstart/assets/icon.svg`
- `.agents/skills/convex-setup-auth/SKILL.md`, `.claude/skills/convex-setup-auth/SKILL.md`
- `.agents/skills/convex-setup-auth/agents/openai.yaml`, `.claude/skills/convex-setup-auth/agents/openai.yaml`
- `.agents/skills/convex-setup-auth/assets/icon.svg`, `.claude/skills/convex-setup-auth/assets/icon.svg`
- `.agents/skills/convex-setup-auth/references/auth0.md`, `.claude/skills/convex-setup-auth/references/auth0.md`
- `.agents/skills/convex-setup-auth/references/clerk.md`, `.claude/skills/convex-setup-auth/references/clerk.md`
- `.agents/skills/convex-setup-auth/references/convex-auth.md`, `.claude/skills/convex-setup-auth/references/convex-auth.md`
- `.agents/skills/convex-setup-auth/references/workos-authkit.md`, `.claude/skills/convex-setup-auth/references/workos-authkit.md`
- `.agents/skills/convex/SKILL.md`, `.claude/skills/convex/SKILL.md`

## Compatibility and fallback concentration

| File | Mentions |
| --- | ---: |
| `test/mcp-legacy-chatgpt-snapshot.test.ts` | 21 |
| `test/store-migration.test.ts` | 17 |
| `.github/workflows/kite-repository-cleanup-audit.yml` | 14 |
| `test/run-execution-envelope.test.ts` | 13 |
| `docs/operations.md` | 12 |
| `test/run-execution-legacy-replay.test.ts` | 12 |
| `docs/mcp-oauth-verification.md` | 10 |
| `convex/runsExecutionEnvelopeLegacy.test.ts` | 9 |
| `docs/cloudflare-deployment.md` | 8 |
| `test/exact-idempotency-fingerprint.test.ts` | 8 |
| `convex/continuationSupervisor.test.ts` | 7 |
| `convex/exactIdempotencyFingerprint.test.ts` | 7 |
| `convex/mcpOAuthClientLifecycleAudit.ts` | 7 |
| `docs/chatgpt-app-recovery.md` | 7 |
| `docs/mcp-oauth-production-gate.md` | 7 |
| `src/mcp-release-manifest.ts` | 7 |
| `.github/labels.json` | 6 |
| `.github/workflows/deploy-worker.yml` | 6 |
| `convex/mcpOAuthClientLifecycle.test.ts` | 6 |
| `docs/w01-hosted-auth-phase1-packet.md` | 6 |
| `test/dashboard-item-detail.test.ts` | 6 |
| `test/deploy-dashboard-workflow.test.ts` | 6 |
| `README.md` | 5 |
| `convex/lib/runVisibility.ts` | 5 |
| `.agents/skills/convex-performance-audit/references/hot-path-rules.md` | 4 |
| `.claude/skills/convex-performance-audit/references/hot-path-rules.md` | 4 |
| `.github/workflows/deploy-dashboard.yml` | 4 |
| `convex/dependency-isolation.test.ts` | 4 |
| `docs/architecture.md` | 4 |
| `docs/mcp-oauth.md` | 4 |
| `docs/smolrunner-receipt-intake.md` | 4 |
| `model/claim-run/check.ts` | 4 |
| `src/hosted-auth.ts` | 4 |
| `test/completion-parity.test.ts` | 4 |
| `test/mcp-oauth.test.ts` | 4 |
| `convex/mcpOAuthClientLifecycle.ts` | 3 |
| `docs/coordination-correctness.md` | 3 |
| `docs/github-connector-suite.md` | 3 |
| `docs/issue-intake-and-labels.md` | 3 |
| `docs/large-codebase-agent-workflow.md` | 3 |

**Decision template for each compatibility path:** supported users, current caller, failure consequence, replacement, evidence required before removal, and target review date.

## Package scripts and entrypoints

| Script | Command | Direct entry | Other filename references |
| --- | --- | --- | ---: |
| `attach` | `bun src/project-attach-cli.ts` | `src/project-attach-cli.ts` | 0 |
| `audit:membership` | `bun src/provider-membership-audit-cli.ts` | `src/provider-membership-audit-cli.ts` | 1 |
| `callsign-catalog` | `bun src/callsign-catalog-cli.ts` | `src/callsign-catalog-cli.ts` | 1 |
| `callsigns` | `bun src/callsigns.ts` | `src/callsigns.ts` | 1 |
| `convex:deploy` | `convex deploy` | `—` | 0 |
| `convex:dev` | `convex dev` | `—` | 0 |
| `convex:local` | `convex dev --dev-deployment local` | `—` | 0 |
| `custodian` | `bun src/custodian.ts` | `src/custodian.ts` | 1 |
| `dev` | `bun --watch src/index.ts` | `src/index.ts` | 3 |
| `mcp` | `bun src/mcp-stdio.ts` | `src/mcp-stdio.ts` | 0 |
| `snapshot` | `bun src/snapshot-cli.ts` | `src/snapshot-cli.ts` | 0 |
| `start` | `bun src/index.ts` | `src/index.ts` | 3 |
| `test` | `bun test ./test/*.test.ts` | `—` | 0 |
| `test:convex` | `vitest run` | `—` | 0 |
| `test:runtime-parity` | `bun scripts/verify-runtime-parity.mjs` | `scripts/verify-runtime-parity.mjs` | 0 |
| `tokens` | `bun src/tokens.ts` | `src/tokens.ts` | 0 |
| `typecheck` | `bunx tsc --noEmit` | `—` | 0 |
| `verify:dashboard` | `bun src/verify-dashboard.ts` | `src/verify-dashboard.ts` | 8 |
| `verify:hosted` | `bun src/verify-hosted.ts` | `src/verify-hosted.ts` | 1 |
| `verify:oauth` | `bun src/verify-oauth-hosted.ts` | `src/verify-oauth-hosted.ts` | 2 |
| `verify:oauth-abuse` | `bun src/verify-oauth-abuse.ts` | `src/verify-oauth-abuse.ts` | 1 |
| `worker:check` | `wrangler deploy --dry-run --outdir .wrangler-dry-run` | `—` | 0 |
| `worker:deploy` | `wrangler deploy` | `—` | 0 |
| `worker:dev` | `wrangler dev` | `—` | 0 |
| `worker:tail` | `wrangler tail` | `—` | 0 |

Low-reference CLI entrypoints deserve a product decision, not automatic deletion. Keep operator tools that provide unique recovery value; combine commands that differ only by endpoint or verification profile.

## Strong areas worth preserving

- Server-owned authority and responsibility semantics stay separate from client/runtime identity.
- Idempotency receipts are treated as evidence and fenced from authority decisions.
- Privacy-sensitive projections use explicit bounded fields and digest identities.
- Hosted and local adapters share domain contracts while keeping provider effects outside pure cores.
- Exact-head CI, recovery notes, and source-only final candidates make risky internal changes recoverable.
- The no-gradient visual rule is explicit and easy to enforce.

## Prioritized cleanup queue

### P0 — merge-safe maintenance
1. Extract and adopt the remote MCP HTTP test harness.
2. Add a repository check that rejects committed one-off workflow carriers on merge-ready pull requests, while allowing named permanent workflows.
3. Add one sync check for mirrored agent skill assets or document the generator that owns both trees.

### P1 — reduce brittleness
4. Convert dashboard source-string contracts to behavioral tests, starting with item mutation refresh and connection/session helpers.
5. Introduce shared test builders for actors, tokens, item creation, and JSON-RPC receipts; keep scenario assertions local.
6. Split the largest HTTP/MCP orchestration files at stable policy boundaries after current W01 feature branches land.

### P2 — product simplification decisions
7. Review unversioned `/api` compatibility routes and local SQLite mode using actual dogfood usage and recovery value.
8. Consolidate hosted verifier CLIs behind profiles where their transport and redaction logic overlaps.
9. Review each legacy execution-envelope reader and migration fixture for a retained caller and sunset condition.
10. Remove or archive features that expose no current user journey, have no active caller, and add ongoing authority or migration burden.

## Next executable action

Implement P0.1 on this branch: add the canonical MCP HTTP test harness, migrate a non-overlapping foundational set of suites, run the full repository gate, then expand only while active pull-request overlap remains low.
