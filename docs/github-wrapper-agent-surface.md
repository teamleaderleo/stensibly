# GitHub wrapper agent surface

Stensibly should feel like a smaller, safer GitHub interface—not a second GitHub vocabulary.

## Product boundary

Plain `gh` is best when an expert already knows one exact provider query and can select a narrow `--json` field set. Stensibly earns its extra hop when it removes reasoning the caller would otherwise repeat:

| Layer | Stensibly owns |
| --- | --- |
| Selection | Familiar typed GitHub verbs plus a few outcome-level composites |
| Scope | Accepted project/repository binding and authenticated principal |
| Reads | Bounded inputs/results, exact source identity, request/result digests, latency and outcome telemetry |
| Writes | Authority checks, stable idempotency identity, provider readback, ambiguity classification, reconciliation guidance, durable receipt |
| Work | Item/run association, exact generation fences, runner-neutral dispatch |
| Physical execution | Glaeda-owned machine command and receipt |

The wrapper must not create another queue, coordination ledger, or provider-state mirror. Mutable GitHub facts still belong to GitHub. Durable effect receipts use the existing receipt/workflow owners.

## Tool shape

Keep five small families visible:

1. `get_brief`, `list_work`, `get_project_attachment`, `get_runner_context` — bounded orientation.
2. `create_item`, `claim_work`, `block_work`, `unblock_work`, `handoff_work`, `complete_work`, `attach_artifact` — durable work transitions.
3. `dispatch_work` — exact item generation to one runner profile; the server supplies routine envelope, lease, and retry defaults.
4. `github_get_issue`, `github_search_issues`, `github_create_issue`, `github_update_issue`, `github_add_issue_comment` — familiar basic GitHub operations intercepted by Stensibly.
5. `github_repo_health`, `github_ci_diagnose`, `github_publish_change`, `github_land_pr` — joined outcomes that replace several provider calls and their reconciliation logic.

Do not add aliases beside existing tools. A rename costs compatibility and duplicate aliases increase selection/context tax. Keep stable descriptive wire names and use short display titles (`CI`, `Brief`, `Policy`, `Dispatch`) for scanning. Acronyms are appropriate only when they are already the domain term; opaque abbreviations shift token savings into model reasoning and error recovery.

## Context budget

The checked-in `bun run plugin:efficiency` receipt measures the exact default declaration and fails when it exceeds its reviewed budget. At snapshot 27:

```json
{"toolCount":21,"instructionChars":531,"catalogueChars":26458,"wireNameChars":323,"titleChars":156,"descriptionChars":1154,"inputSchemaChars":14399,"outputSchemaChars":6086}
```

The previous declaration plus instructions was 52,696 characters. The current total is 26,989 characters, a 48.8% reduction while retaining all 21 tools. Wire names are only 323 characters, so renaming every tool could not materially change the budget. Input schemas remain the largest cost and should receive the next optimization pass.

Small results remain readable JSON for compatibility. When structured result data exceeds 2 KiB, the text channel carries only a deterministic digest instead of duplicating the payload. `structuredContent.data` remains the canonical result.

## Observability

Every hosted `github_*` tool call emits one content-free `mcp.tool.complete` observation:

- RPC request ID when safe;
- tool name;
- success or failure;
- duration in milliseconds;
- canonical argument digest;
- canonical result digest.

Never log raw arguments, result content, repository paths, comment bodies, credentials, or provider error prose. Write operations continue to return and persist their stronger idempotency/readback/reconciliation receipts.

Capability configuration is not execution proof. `github_repo_health` reports its own successful probe, but other operations remain `probe: not_run` until exercised; it must not call a configured CI path “ready” merely because repository metadata worked.
