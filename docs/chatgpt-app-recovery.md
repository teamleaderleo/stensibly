# ChatGPT app snapshot and coexistence recovery

This runbook covers the #490 failure mode where ChatGPT discovers Stensibly actions, a later call fails before reaching the Worker, the Stensibly namespace disappears, or another app becomes forbidden inside the same conversation.

## Current compatibility checkpoint

Current `main` defines **26** public MCP tools with manifest fingerprint:

```text
sha256:ecbae4d7efe2b6757b321a80d301fe06b81e70641717ddd682f9ceab0d4165bb
```

The incident conversation exposed **25** Stensibly actions. The missing action is `get_operation_receipt`, added after the earlier ChatGPT app scan.

OpenAI currently freezes the approved tools and inputs for a custom MCP app. Server changes are not applied automatically. OpenAI also states that backward-compatible changes may continue working, while incompatible input changes require an admin action refresh and Business published apps may require recreation.

Stensibly therefore treats both snapshots as explicit compatibility targets during #490:

- the approved 26-action epoch is frozen against additional public tool names;
- the earlier 25-action snapshot remains supported for its existing reads and writes;
- existing top-level input names remain accepted;
- an existing optional input cannot become required;
- new product data should be exposed through backward-compatible output additions to an existing read action while the incident remains open.

The 25-action snapshot cannot call `get_operation_receipt`. Use a unique idempotency key and reconcile an ambiguous write through `get_item`, `list_work`, `get_brief`, or another bounded read already present in that snapshot.

Stensibly's OAuth authorization metadata advertises `offline_access`, `authorization_code`, and `refresh_token`, with refresh tokens enabled by default. A clean failure before network dispatch points toward ChatGPT app or conversation-host state rather than token refresh.

## Normal operation without app recreation

Do not recreate the ChatGPT app for a Stensibly release that preserves the compatibility epoch.

A compatibility-preserving release must keep:

1. all approved public tool names;
2. every previously accepted top-level input name;
3. the absence of any newly required input on an existing tool;
4. old calls executable after a new MCP server instance is created;
5. bounded read-after-write recovery for clients without `get_operation_receipt`.

CI locks these conditions in `test/chatgpt-app-actions-snapshot.test.ts` and `test/mcp-frozen-chatgpt-snapshot.test.ts`.

During #490, a proposed 27th public tool should be reworked into an existing read action's response or retained behind a non-public internal boundary. A deliberate breaking migration must change the compatibility checkpoint visibly and requires the corresponding ChatGPT admin refresh or recreation.

## Optional refresh path

Refreshing remains useful when an operator wants the 26th action or a later deliberately approved action migration. It is not the default recovery for compatibility-preserving server releases.

### Enterprise or Edu published app

1. Open **Workspace Settings → Apps**.
2. Open Stensibly's menu and choose **Action control**.
3. Select **Refresh** to scan the live MCP actions.
4. Review and enable the added or changed actions.
5. Confirm the app shows 26 actions and includes `get_operation_receipt`.

### Business published app

Business published apps currently require recreation and republishing when their approved actions or metadata must change. Continue using the frozen compatible snapshot when no migration is required.

### Developer-mode draft

Use **Scan Tools** only when deliberately updating the draft action set. Keep the existing draft for normal compatibility-preserving releases.

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

### Frozen but compatible ChatGPT action snapshot

Evidence:

- ChatGPT exposes 25 actions while the checked-in current checkpoint has 26;
- `get_operation_receipt` is absent;
- existing 25-action reads and writes still execute.

Action: continue using the supported legacy actions. Use read-after-write reconciliation for ambiguous mutations. Refresh only when the additional action is operationally valuable enough to justify the admin change.

### Frozen snapshot incompatibility

Evidence:

- an existing tool call reaches `/mcp` but fails request validation because an approved input disappeared, changed incompatibly, or became newly required;
- the server returns Worker receipts and typed request-validation evidence.

Action: treat this as a Stensibly release regression. Restore backward compatibility or roll back before asking operators to refresh the app.

### ChatGPT host binding or conversation registry failure

Evidence:

- the app schema appears during discovery;
- a direct call returns `Resource not found`, loses its tool binding, or changes another app's eligibility;
- Stensibly receives no request;
- no Worker request ID, version receipt, response stage, manifest fingerprint, or tool-count header exists.

This failure occurs before network dispatch. Server retries, schema compatibility changes, and OAuth changes cannot repair that specific call. Start a new conversation, preserve the evidence, and escalate the host failure to OpenAI. App recreation is not required to prove this layer when the cached action is covered by the compatibility epoch.

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
- confirmation that the expected server manifest is 26 tools with fingerprint `sha256:ecbae4d7efe2b6757b321a80d301fe06b81e70641717ddd682f9ceab0d4165bb`;
- confirmation that the failed call produced no Stensibly Worker receipt;
- whether the selected tool belongs to the frozen 25-action compatibility set;
- browser console export and HAR captured around the failure;
- whether a new conversation, app refresh, app recreation, and OAuth reconnect changed the result.

OpenAI's general ChatGPT troubleshooting guidance asks for console logs and a HAR with timestamps when failures persist. Remove credentials, cookies, OAuth codes, tokens, and private project payloads before sharing the packet.

## Repository release rule

`docs/chatgpt-app-actions.json` is the checked-in ChatGPT action checkpoint.

While #490 remains open:

- the public action list stays at 26;
- the pinned 25-action legacy subset remains executable;
- previously accepted top-level inputs stay present;
- no existing action gains a new required top-level input;
- new capability should prefer an additive response field on an existing read action.

Any deliberate exception is a visible compatibility-epoch migration and requires an explicit operator plan. Backward-compatible releases require no ChatGPT admin action.
