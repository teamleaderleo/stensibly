# Repository cleanup audit — 2026-07-31

**Audited base:** `226e5b7ff7dc2e656193411921a3431f28d018f9`  
**Callsign:** Kite  
**Scope:** tracked repository content; generated Convex output excluded from code-size rankings.

## Summary

Stensibly has a strong domain core and a growing maintenance burden around test plumbing, browser contract tests, compatibility paths, large orchestration modules, and temporary delivery machinery.

The cleanup strategy should preserve the product's authority and recovery guarantees while reducing repeated mechanics around them. The highest-value near-term work is shared test support and behavioral testing. Product-surface removal should follow usage evidence and explicit replacement paths.

## Inventory

- Tracked files: **700**
- Production TypeScript/JavaScript lines: **67,803**
- Test TypeScript/JavaScript lines: **45,771**
- Total TypeScript/JavaScript lines: **113,574**
- Test-to-production line ratio: **0.68**
- Test files under `test/`: **212**
- Source files under `src/`: **154**
- Convex files: **86**
- Dashboard files: **81**

### Largest implementation files

| File | Lines |
| --- | ---: |
| `src/tool-capability-grants-sqlite.ts` | 1,413 |
| `src/tool-capability-grant.ts` | 1,355 |
| `model/claim-run/check.ts` | 1,065 |
| `src/runs-core.ts` | 1,004 |
| `src/hosted-auth.ts` | 953 |
| `convex/mcpOAuth.ts` | 937 |
| `src/continuations.ts` | 923 |
| `src/promises.ts` | 921 |
| `convex/continuationSupervisor.ts` | 860 |
| `src/project-attachment-contract.ts` | 836 |
| `src/github-issue-context-sqlite.ts` | 832 |
| `src/github-issue-provider-service.ts` | 814 |

Large files alone are not defects. Split them only at stable policy boundaries such as parsing, authorization, reconciliation, persistence, or projection. Avoid thin files that merely move complexity around.

## Strong areas to preserve

1. **Authority and responsibility stay distinct.** Server-owned grants, claims, generations, and responsibilities avoid accidental reliance on process identity.
2. **Pure policy cores are reusable.** Idempotency, receipt, reconciliation, grant, and lifecycle logic can be tested independently of providers.
3. **Adapters have real parity coverage.** SQLite and Convex duplication earns its cost when tests prove the same invariant across both implementations.
4. **Privacy boundaries are explicit.** Bounded projections and digest identities appear throughout the repository.
5. **Recovery is part of delivery.** Exact heads, CI receipts, deterministic retries, and durable handoffs make internal iteration recoverable.
6. **The visual rule is crisp.** The flat-colour, no-gradient direction is simple to enforce.

## Confirmed duplication hotspots

### Remote MCP test plumbing

The audit found local copies of:

- `toolCall` in **15** test files;
- `mcpRequest` in **13** test files;
- `initialize` helpers in **7** test files;
- `mcpHeaders` in **4** test files.

These copies repeat the protocol revision, headers, JSON-RPC envelopes, Hono request seam, and text-result parsing. They already vary in client names, initialization behavior, error messages, and typing.

**Action:** use `test/support/mcp-http.ts` as the canonical harness and migrate suites when their active branches rebase. Keep scenario setup and assertions local.

### Test builders

Repeated local builders include:

- `createItem` in **30** files;
- bearer-header helpers in **10** files;
- deterministic random-byte helpers in **5** files;
- webhook signed-header helpers in **4** files;
- OAuth client, code, refresh, and scheduler fixtures across several Convex suites.

**Action:** extract builders only when they encode stable data defaults. Keep scenario-specific intent visible in each test.

### Dashboard source-string contracts

The audit found **20** files that load implementation source and assert `.toContain(...)`. Several suites contain 45–74 string assertions each.

This style is useful for a narrow wiring or privacy fence, yet it becomes brittle when it verifies ordinary behavior. A behavior-preserving edit to `refreshCurrent({ interactive: true })` already demonstrated this drift.

**Action:** retain a small wiring smoke layer, export pure browser decisions, and test inputs/outputs or DOM effects. Source-text checks should cover only constraints that cannot be observed through an exported function or browser interaction.

## Managed mirrored skills

The repository contains **30** identical relative-path pairs under `.agents/skills/` and `.claude/skills/`.

These are expected Convex AI Files output:

- `.agents/skills/` is the canonical project-scoped agent install;
- `.claude/skills/` is the Claude Code location, commonly provided through managed links or copies.

Treat these paths as tool-managed packaging, not ordinary duplicate code. Use `npx convex ai-files status` and `npx convex ai-files update` to reconcile them. Avoid hand-deleting one tree.

Upstream reference: [Convex AI Files manual testing](https://github.com/get-convex/convex-backend/blob/dd67049edf82415d8c3209c2449c687801a0540f/npm-packages/convex/src/cli/lib/aiFiles/MANUAL_TESTING.md).

## Compatibility and product-surface debt

Compatibility is concentrated in:

- unversioned local `/api` routes;
- local SQLite mode;
- legacy run/execution-envelope readers and fixtures;
- Worker fallback endpoints;
- OAuth and ChatGPT recovery paths;
- migration readers and replay tests;
- several narrowly focused verifier CLIs.

Each path should have a small decision record:

1. current user or recovery caller;
2. failure consequence if removed;
3. supported replacement;
4. evidence required before removal;
5. review date or sunset trigger.

Low-reference CLI entrypoints deserve review rather than automatic deletion. Recovery tools can be valuable even with infrequent use. Verifiers that differ only by endpoint, profile, or expected denial should share transport, redaction, and reporting code.

## Delivery-process debt

One-off self-removing workflow carriers have helped recover branches without a local checkout. They also add review noise, can remain committed when branch-defined workflows are not executed, and duplicate shell/Python recipes.

**Action:**

- keep final PR heads source-only;
- remove carriers before readiness;
- prefer permanent reusable workflows for recurring repair operations;
- add a merge-ready check that rejects unapproved one-off carrier paths.

## GitHub-only research basis

The cleanup direction aligns with current upstream practice:

- The [official MCP TypeScript SDK test helpers](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/test/e2e/helpers/index.ts) centralize in-process transport wiring, lifecycle cleanup, and raw HTTP capture for scenario tests.
- Hono's [official testing helper](https://github.com/honojs/hono/blob/224d2f5cbf2b4bc2ebb7482d0592149a8d9f0574/src/helper/testing/index.ts) wraps `app.request` behind one injected fetch seam.
- Convex documents ownership of the agent-native skill paths in its [AI Files manual testing guide](https://github.com/get-convex/convex-backend/blob/dd67049edf82415d8c3209c2449c687801a0540f/npm-packages/convex/src/cli/lib/aiFiles/MANUAL_TESTING.md).

## Prioritized cleanup queue

### P0 — merge-safe maintenance

1. **Adopt the shared MCP HTTP harness.** Started in PR #599 with five foundational suites and direct helper tests.
2. **Keep merge-ready heads source-only.** Reject leftover one-off workflow carriers.
3. **Document managed files.** Mark Convex AI Files as owner of `.agents/skills/` and `.claude/skills/`.

### P1 — reduce brittleness

4. Convert dashboard source-string contracts to behavioral tests, beginning with connection/session and item-mutation refresh behavior.
5. Introduce stable builders for actors, tokens, item creation, OAuth fixtures, signed webhook requests, and operation receipts.
6. Split the largest orchestration files after overlapping W01 feature branches land, using policy boundaries instead of line-count targets.
7. Consolidate verifier transport, redaction, argument parsing, and result formatting behind explicit verification profiles.

### P2 — simplify product surface

8. Review unversioned `/api` compatibility routes with caller evidence and a migration path.
9. Review local SQLite mode as a deliberate self-hosted/recovery product rather than an implicit second product.
10. Review each legacy execution-envelope reader and migration fixture for a retained caller and sunset trigger.
11. Remove or archive features that have no current user journey, no recovery role, no active caller, and ongoing authority or migration cost.

## Removal standard

A feature is a strong removal candidate when all of these hold:

- no current user or operational recovery journey;
- no active caller in code, docs, scripts, or hosted configuration;
- a simpler replacement covers the useful outcome;
- removal reduces durable-state, authorization, migration, or provider burden;
- rollback consists of reverting one bounded change.

## Next action

Merge PR #599 after exact-head CI. Then create one cleanup programme issue from this queue and execute P1 work in small, non-overlapping slices while W01 reliability work continues.
