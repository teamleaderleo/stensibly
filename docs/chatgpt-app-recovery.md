# ChatGPT app latest-manifest and coexistence recovery

This runbook covers the #490 failure mode where ChatGPT discovers Stensibly actions, a later call fails before reaching the Worker, the Stensibly namespace disappears, or another app becomes forbidden inside the same conversation.

## Current release

Current `main` defines **35** public MCP tools with manifest fingerprint:

```text
sha256:0356ccd4f47c88e63833bb4abdeb0890aae74b7dd06348cac9769271cc7f7c6e
```

Stensibly dogfood supports the **latest manifest only**. The checked-in action file records the current server release. It is not a historical client-compatibility fixture.

ChatGPT keeps approved custom-app tools and inputs as a frozen snapshot. Server changes do not appear automatically. A refresh, rescan, or app recreation is therefore part of every Stensibly release that changes a public tool name, description, annotation, or input schema.

Before a dogfood run begins:

1. update `docs/chatgpt-app-actions.json` to the current server manifest;
2. refresh, rescan, or recreate the ChatGPT app;
3. review and enable the current actions;
4. start a new conversation using the refreshed app;
5. treat any older visible action set as stale host state, not a supported execution mode.

## GitHub tool-surface policy

Keep a compact set of frequent Stensibly workflow tools and GitHub discovery tools immediately visible. Group the broader GitHub surface by workflow and retrieve it on demand.

- use host-native tool search or deferred loading when the host supports it;
- keep `github_list_toolsets`, `github_search_tools`, and `github_get_tool` as the ChatGPT-compatible discovery fallback;
- load or return exact schemas before execution;
- validate a delegated call against the catalogue schema, project binding, repository scope, authority, approval policy, and provider budget;
- keep write and admin operations approval-aware;
- do not expose one universal unvalidated argument tunnel as the primary interface.

The catalogue is a routing layer. Typed first-party actions remain appropriate where exact inputs, stale-version checks, readback verification, receipts, or recovery semantics improve execution.

## Refresh path

### Enterprise or Edu published app

1. Open **Workspace Settings → Apps**.
2. Open Stensibly's menu and choose **Action control**.
3. Select **Refresh** to scan the current MCP actions.
4. Review the action-definition diff.
5. Enable the current actions required for dogfood.

### Business published app

Recreate and republish the app when the published action set or metadata changes.

### Developer-mode draft

Use **Scan Tools** after every public tool or schema change, review the result, and recreate the draft when scanning cannot adopt the current definition cleanly.

Reconnect OAuth when ChatGPT presents a Worker-visible authentication failure or an expired connection. OAuth changes do not repair a call that vanished before network dispatch.

## Mixed GitHub and Stensibly proof

Use a new normal ChatGPT conversation with the refreshed Stensibly app and GitHub selected explicitly. Keep agent mode and company knowledge outside this write-capable proof.

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
7. Stensibly: reconcile through `get_operation_receipt` or a bounded read-after-write.
8. GitHub: read #490 again.

Record the first transition where discovery, executable binding, network dispatch, server processing, result delivery, or another app changes.

## Layer diagnosis

### Stale ChatGPT action snapshot

Evidence:

- ChatGPT exposes fewer or different actions than the current release;
- the app was created or refreshed before the current manifest;
- newly added or changed definitions are absent.

Action: refresh, rescan, or recreate the app before continuing the dogfood run. Do not spend server effort preserving that stale action set.

### Current snapshot and server disagree

Evidence:

- the app was refreshed against the current release;
- a selected action reaches `/mcp` but fails request validation because the live schema differs from the reviewed action definition;
- the response carries Stensibly Worker receipts and typed request-validation evidence.

Action: treat this as a release defect. Reconcile the current action file, server implementation, deployed revision, and refreshed ChatGPT app, then repeat from a new conversation.

### ChatGPT host binding or conversation registry failure

Evidence:

- the current app schema appears during discovery;
- a direct call returns `Resource not found`, loses its tool binding, or changes another app's eligibility;
- Stensibly receives no request;
- no Worker request ID, version receipt, response stage, manifest fingerprint, or tool-count header exists.

This failure occurs before network dispatch. Server retries, schema changes, and OAuth changes cannot repair that specific call. Start a new conversation, preserve the evidence, and escalate the host failure to OpenAI.

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
- whether the app was refreshed or recreated against the current release;
- browser console export and HAR captured around the failure;
- whether a new conversation, app refresh, app recreation, and OAuth reconnect changed the result.

Remove credentials, cookies, OAuth codes, tokens, and private project payloads before sharing the packet.

## Repository release rule

`docs/chatgpt-app-actions.json` is the current ChatGPT action release receipt.

- it tracks the current public manifest only;
- any public tool or schema change requires refresh, rescan, or recreation before dogfood;
- historical ChatGPT action sets are outside the support target;
- the complete latest-manifest journey must pass after refresh;
- host-native lazy loading is preferred where available;
- the stable searchable catalogue remains the fallback for hosts that freeze a compact app surface.
