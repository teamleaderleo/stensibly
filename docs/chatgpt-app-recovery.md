# ChatGPT app snapshot and coexistence recovery

This runbook covers the #490 failure mode where ChatGPT discovers Stensibly actions, a later call fails before reaching the Worker, the Stensibly namespace disappears, or another app becomes forbidden inside the same conversation.

## Current checkpoint

Current `main` defines **26** public MCP tools with manifest fingerprint:

```text
sha256:ecbae4d7efe2b6757b321a80d301fe06b81e70641717ddd682f9ceab0d4165bb
```

The incident conversation exposed 25 Stensibly actions. The missing action is `get_operation_receipt`, added after the earlier ChatGPT app scan. Treat a 25-action scan as a stale ChatGPT app snapshot.

OpenAI currently documents these product behaviours:

- ChatGPT keeps a frozen snapshot of an approved custom MCP app's tools and inputs.
- Server-side action changes take effect after an admin refreshes and approves the updated actions.
- Business workspaces may require recreating and republishing an app when its actions change.
- Multiple first-party and third-party apps can run in one prompt.
- Agent mode excludes custom apps, and company knowledge includes only eligible search/fetch actions.

Stensibly's OAuth authorization metadata advertises `offline_access`, `authorization_code`, and `refresh_token`, with refresh tokens enabled by default. A clean failure before network dispatch points toward ChatGPT app or conversation-host state rather than token refresh.

## Refresh or recreate the ChatGPT app

Perform this after any checked-in change to `docs/chatgpt-app-actions.json`.

### Enterprise or Edu published app

1. Open **Workspace Settings → Apps**.
2. Open Stensibly's menu and choose **Action control**.
3. Select **Refresh** to scan the live MCP actions.
4. Review and enable the added or changed actions.
5. Confirm the app shows 26 actions and includes `get_operation_receipt`.

### Business published app

Recreate and republish the app from the current endpoint when the published action set cannot be updated in place.

### Developer-mode draft

1. Open **Settings → Apps → Create**.
2. Enter the current Stensibly MCP endpoint and authentication choice.
3. Select **Scan Tools** and complete OAuth.
4. Confirm 26 actions and create a fresh draft.
5. Disable or remove the stale draft after the replacement succeeds.

Reconnect OAuth after the action refresh when ChatGPT still presents an authentication prompt or an expired connection.

## Mixed GitHub and Stensibly proof

Use a new normal ChatGPT conversation. Select both GitHub and Stensibly explicitly. Keep agent mode and company knowledge outside this write-capable proof.

Use one unique run identity and idempotency prefix. Execute the sequence in separate visible checkpoints:

```text
GitHub read → Stensibly read → GitHub read → Stensibly read
→ Stensibly idempotent write → GitHub comment
→ Stensibly receipt/read-after-write → GitHub read
```

Recommended calls:

1. GitHub: read #490 and current `main`.
2. Stensibly: `survey_workspace` or `get_brief`.
3. GitHub: add a pre-write checkpoint comment.
4. Stensibly: `get_continuation` or `get_item`.
5. Stensibly: create one uniquely named item with an idempotency key.
6. GitHub: add a post-write checkpoint comment.
7. Stensibly: call `get_operation_receipt` with the exact project and idempotency key, then read the item.
8. GitHub: read #490 again.

Record the first transition where discovery, executable binding, network dispatch, server processing, result delivery, or another app changes.

## Layer diagnosis

### Stale ChatGPT action snapshot

Evidence:

- ChatGPT exposes 25 actions while the checked-in snapshot expects 26;
- `get_operation_receipt` is absent;
- refresh or recreation has yet to occur after the manifest changed.

Action: refresh or recreate the app before continuing the coexistence proof.

### ChatGPT host binding or conversation registry failure

Evidence:

- the app schema appears during discovery;
- a direct call returns `Resource not found`, loses its tool binding, or changes another app's eligibility;
- Stensibly receives no request;
- no Worker request ID, version receipt, response stage, manifest fingerprint, or tool-count header exists.

This failure occurs before network dispatch. Server retries and OAuth changes cannot repair that specific call. Start a new conversation after refreshing the app, preserve the evidence, and escalate the host failure to OpenAI.

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
- browser console export and HAR captured around the failure;
- whether a new conversation, app refresh, app recreation, and OAuth reconnect changed the result.

OpenAI's general ChatGPT troubleshooting guidance asks for console logs and a HAR with timestamps when failures persist. Remove credentials, cookies, OAuth codes, tokens, and private project payloads before sharing the packet.

## Repository release rule

`docs/chatgpt-app-actions.json` is the checked-in ChatGPT action checkpoint. The CI test compares its ordered tool names, count, manifest version, and fingerprint with `src/mcp-diagnostics.ts`.

Any MCP tool-name change must update the checkpoint in the same pull request. That update means the deployed ChatGPT app requires an action refresh or recreation before the next production dogfood run.
