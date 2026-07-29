# ChatGPT app snapshot and coexistence recovery

This runbook covers the #490 failure mode where ChatGPT discovers Stensibly actions, a later call fails before reaching the Worker, the Stensibly namespace disappears, or another app becomes forbidden inside the same conversation.

## Current checkpoint

Current `main` defines **27** public MCP tools with manifest fingerprint:

```text
sha256:0e7353a9a48b1b9d6d618a8a4a19b4520a97ba54f1ba4c91fb54294fbbe6f516
```

The incident conversation exposed **25** Stensibly actions. Current additive actions absent from that older snapshot are `get_operation_receipt` and `get_github_project_context`.

OpenAI keeps the approved tools and inputs for a custom MCP app as a snapshot. Server changes are not automatically added to that snapshot. This does not require Stensibly to stop adding tools.

Stensibly's compatibility rule is:

- additive public tool names are allowed;
- an older ChatGPT snapshot may keep calling the actions it already knows;
- previously accepted top-level input names remain accepted;
- an existing optional input does not become required without an explicit migration;
- adding a tool may require a ChatGPT refresh only for clients that want to use that new tool.

The 25-action snapshot cannot call `get_operation_receipt` or `get_github_project_context`. Use a unique idempotency key and reconcile an ambiguous write through `get_item`, `list_work`, `get_brief`, or another bounded read already present in that snapshot. Read GitHub issue context directly through GitHub until the newer Stensibly action is visible.

Stensibly's OAuth authorization metadata advertises `offline_access`, `authorization_code`, and `refresh_token`, with refresh tokens enabled by default. A clean failure before network dispatch points toward ChatGPT app or conversation-host state rather than token refresh.

## Normal operation without app recreation

Existing approved actions should continue working across compatible Stensibly releases. Adding a new action does not invalidate old actions and does not require app recreation for users who do not need the new action.

A compatibility-preserving release keeps:

1. every previously approved action executable;
2. every previously accepted top-level input name;
3. existing optional inputs optional;
4. old calls executable after a new MCP server instance is created;
5. bounded read-after-write recovery for clients without `get_operation_receipt`.

CI covers these conditions in `test/chatgpt-app-actions-snapshot.test.ts` and `test/mcp-legacy-chatgpt-snapshot.test.ts`.

New tools are allowed. The checked-in action snapshot must be updated when the live manifest changes so drift remains visible and testable.

## Optional refresh path

Refresh or recreate the ChatGPT app only when an operator wants newly added actions or when an existing action changes incompatibly.

### Enterprise or Edu published app

1. Open **Workspace Settings → Apps**.
2. Open Stensibly's menu and choose **Action control**.
3. Select **Refresh** to scan the live MCP actions.
4. Review and enable the added or changed actions.

### Business published app

A published app may require recreation and republishing to expose newly added actions. Existing approved actions can continue to be used when the server remains backward-compatible.

### Developer-mode draft

Use **Scan Tools** when deliberately updating the draft action set. Keeping the current draft is valid when its existing actions remain compatible.

Reconnect OAuth when ChatGPT presents a Worker-visible authentication failure or an expired connection. OAuth changes do not repair a call that vanished before network dispatch.

## Mixed GitHub and Stensibly proof

Use a new normal ChatGPT conversation. Select both GitHub and Stensibly explicitly. Keep agent mode and company knowledge outside this write-capable proof.

Use one unique run identity and idempotency prefix. Execute the sequence in separate visible checkpoints:

```text
GitHub read → Stensibly read → GitHub read → Stensibly read
→ Stensibly idempotent write → GitHub comment
→ Stensibly receipt/read-after-write → GitHub read
```

For a 25-action client, replace the receipt call with `get_item`, `list_work`, or `get_brief` using the unique item identity.

Recommended calls:

1. GitHub: read #490 and current `main`.
2. Stensibly: `survey_workspace` or `get_brief`.
3. GitHub: add a pre-write checkpoint comment.
4. Stensibly: `get_continuation` or `get_item`.
5. Stensibly: create one uniquely named item with an idempotency key.
6. GitHub: add a post-write checkpoint comment.
7. Stensibly: reconcile through `get_operation_receipt` when available, otherwise perform a bounded read-after-write.
8. GitHub: read #490 again.

Record the first transition where discovery, executable binding, network dispatch, server processing, result delivery, or another app changes.

## Layer diagnosis

### Older but compatible ChatGPT action snapshot

Evidence:

- ChatGPT exposes fewer actions than the current manifest;
- the selected older action still reaches Stensibly and executes successfully;
- newly added actions are absent.

Action: continue using the existing actions. Refresh only when the newly added actions are needed.

### Snapshot incompatibility

Evidence:

- an existing tool call reaches `/mcp` but fails request validation because an approved input disappeared, changed incompatibly, or became newly required;
- the server returns Worker receipts and typed request-validation evidence.

Action: treat this as a Stensibly release regression. Restore backward compatibility or perform an explicit versioned migration.

### ChatGPT host binding or conversation registry failure

Evidence:

- the app schema appears during discovery;
- a direct call returns `Resource not found`, loses its tool binding, or changes another app's eligibility;
- Stensibly receives no request;
- no Worker request ID, version receipt, response stage, manifest fingerprint, or tool-count header exists.

This failure occurs before network dispatch. Server retries, schema compatibility changes, and OAuth changes cannot repair that specific call. Start a new conversation, preserve the evidence, and escalate the host failure to OpenAI. App recreation is not required to prove this layer when the selected action is already present in the app snapshot.

### OAuth or workspace access failure

Evidence:

- the request reaches `/mcp`;
- the response carries Stensibly Worker and manifest receipts;
- the response reports authentication, token authority, authorization, scope, or project access.

Action: reconnect OAuth, inspect requested scopes and project access, then follow the bounded diagnostic action returned by the server.

### Stensibly gateway or MCP failure

Evidence:

- the response carries `x-stensibly-mcp-tool-manifest-fingerprint` and `x-stensibly-mcp-tool-count`;
- a bounded `error.data` object identifies the layer, stage, retry safety, reconciliation requirement, and next action.

Action: follow the typed diagnostic. Reconcile any ambiguous write through `get_operation_receipt` or read-after-write before replay.

## OpenAI support evidence packet

Capture one packet for the first clean host-side reproduction:

- absolute timestamp with timezone;
- ChatGPT conversation URL and workspace plan;
- browser or desktop-app version;
- Stensibly app name, draft/published state, and visible action count;
- exact prompt and tool selected;
- the previous successful GitHub and Stensibly checkpoints;
- the first `Resource not found` or `FORBIDDEN` text;
- confirmation of the expected server manifest count and fingerprint;
- confirmation that the failed call produced no Stensibly Worker receipt;
- whether the selected action existed in the app's visible snapshot;
- browser console export and HAR captured around the failure;
- whether a new conversation, app refresh, app recreation, and OAuth reconnect changed the result.

Remove credentials, cookies, OAuth codes, tokens, and private project payloads before sharing the packet.

## Repository release rule

`docs/chatgpt-app-actions.json` is the checked-in ChatGPT action checkpoint.

- additive tool growth is allowed;
- the checkpoint tracks the current live manifest;
- legacy approved actions and inputs remain covered by compatibility tests;
- new tools may require refresh only to become visible in ChatGPT;
- breaking changes to existing actions require an explicit migration plan.
