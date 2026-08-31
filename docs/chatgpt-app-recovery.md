# ChatGPT app latest-manifest and coexistence recovery

This runbook covers the #490 failure mode where ChatGPT discovers Stensibly actions, a later call fails before reaching the Worker, the Stensibly namespace disappears, or another app becomes unavailable inside the same conversation.

## Current published profile

Normal hosted ChatGPT publication uses the reviewed **`published_default`** profile with **21** outcome-level MCP tools. The complete current list lives in [`docs/chatgpt-app-actions.json`](chatgpt-app-actions.json), which is the release receipt and canonical owner for the published action set.

```text
published ChatGPT tool contract: sha256:e4fdf6767b4e9d283903b2fadd46b1189febcbad8060a507ae71dc3a2eb99e78
names-only diagnostic:            sha256:91919251f55e23b57292b2eb470bedfb8d86080da8a56c1df97641de9aec18b4
```

The public profile keeps frequent work coordination, exact runner-neutral dispatch, project context, bounded GitHub issue work, repository health/CI diagnosis, reviewed publication, and PR landing immediately visible. Each visible tool carries canonical `readOnlyHint`, `destructiveHint`, and `openWorldHint` metadata derived from the capability policy.

The broader **`full_internal`** profile remains available to explicit internal/admin clients. It retains long-tail provider discovery, receipts, worker enrolment, continuation machinery, low-level repository primitives, and recovery operations. Public visibility and backend capability stay separate.

Stensibly dogfood supports the **latest manifest only**. ChatGPT keeps approved custom-app actions as a frozen snapshot, so every change to a published tool name, description, annotation, or input schema requires a refresh, rescan, or app recreation.

Before a dogfood run:

1. update `docs/chatgpt-app-actions.json` from the exact candidate contract;
2. refresh, rescan, or recreate the ChatGPT app;
3. review and enable the current actions;
4. start a fresh conversation using that action snapshot;
5. compare the visible action count and contract identity with the release receipt.

## Normal agent workflow

The public profile is designed so an agent can understand the project and complete common work without learning internal policy vocabulary.

- use `get_brief`, `list_work`, `get_runner_context`, and `get_project_attachment` for project/work context; use the broader discoverable profile only when full item history is actually needed;
- use `claim_work`, `block_work`, `unblock_work`, `complete_work`, and `handoff_work` for ordinary work transitions;
- use `create_item`, attach or record exact source evidence, then use `dispatch_work` to queue that item generation for one exact runner profile; machine mechanics and terminal settlement remain runner-owned;
- use `github_repo_health` before a consequential repository workflow;
- use `github_search_issues`, `github_get_issue`, `github_create_issue`, `github_update_issue`, and `github_add_issue_comment` for the normal GitHub issue loop;
- use one explicit idempotency key for each intended GitHub write;
- use `github_ci_diagnose` for bounded PR-to-job failure diagnosis;
- use `github_publish_change` for the reviewed outcome-level branch/file/draft-PR publication path with exact revision fences;
- use `github_land_pr` only with current runner authority and successful exact-head evidence;
- follow typed ambiguity/reconciliation guidance before replaying a write whose provider outcome is uncertain.

Low-level repository write primitives, generic delegated-provider dispatch, explicit receipt reads, worker enrolment, and supervisor/continuation administration live in discovery/internal profiles. They remain available where recovery or internal dogfood requires them without crowding normal ChatGPT tool selection.

## Human setup relationship

The dashboard presents the normal repository work profile as **Build**. Build proposes routine project-scoped GitHub issue work plus draft-PR preparation while consequential merge/deploy/provider/permission effects remain approval-gated. The accepted project attachment remains the authority owner; MCP publication only controls which tools are visible to the agent.

## Refresh path

### Enterprise or Edu published app

1. Open **Workspace Settings → Apps**.
2. Open Stensibly and choose **Action control**.
3. Select **Refresh**.
4. Review the action-definition diff.
5. Enable the current published actions.

### Business published app

Recreate and republish the app when the published action set or metadata changes.

### Developer-mode draft

Use **Scan Tools** after a published action or schema change. Review the result and recreate the draft when scanning cannot adopt the current definition cleanly.

Reconnect OAuth when ChatGPT presents a Worker-visible authentication failure or an expired connection. A call that vanished before network dispatch belongs to the host/conversation binding layer.

## Representative fresh-connection proof

Use a new normal ChatGPT conversation with the refreshed Stensibly app. Exercise the public profile as a user would:

1. read one project with `get_brief` and `get_project_attachment`;
2. find useful work with `list_work` and inspect one item;
3. create and exactly dispatch one bounded item to a reviewed runner profile, then read its eventual work/run receipt;
4. run `github_repo_health` and find one issue through `github_search_issues` or `github_get_issue`;
5. perform one permitted issue create/update/comment workflow with a unique idempotency key;
6. prepare one bounded repository change through `github_publish_change` when the project contract permits it;
7. verify the agent can explain why merge/deploy remains gated when approval is required;
8. exercise one ambiguous-effect recovery scenario and confirm the agent follows the returned reconciliation instruction without duplicate provider effect.

Record the first transition where discovery, executable binding, network dispatch, server processing, result delivery, or another app changes.

## Layer diagnosis

### Stale ChatGPT action snapshot

Evidence: the visible action count/names differ from the current 21-action release receipt, or recently changed definitions are absent.

Action: refresh, rescan, or recreate the app and start a fresh conversation.

### Current snapshot and server disagree

Evidence: the refreshed app reaches `/mcp`, while the live tool schema, count, names-only fingerprint, or full contract differs from `docs/chatgpt-app-actions.json`.

Action: treat this as a release defect. Reconcile the exact server revision, release receipt, deployment, and refreshed ChatGPT app before continuing.

### ChatGPT host binding or conversation registry failure

Evidence: discovery shows the current action, then a direct call returns `Resource not found`, loses its binding, or changes another app's eligibility; Stensibly receives no request and emits no Worker request ID or MCP contract headers.

This occurs **before network dispatch**. Preserve the evidence and reproduce from a fresh conversation before escalating the host failure.

### OAuth or project access failure

Evidence: the request reaches `/mcp`; the response carries Stensibly diagnostics and reports authentication, token authority, scope, or project access.

Action: reconnect OAuth or correct project/scope admission, then retry according to the bounded diagnostic.

### Stensibly gateway or MCP failure

Evidence: the response carries `x-stensibly-mcp-tool-manifest-fingerprint` and `x-stensibly-mcp-tool-count`, plus bounded failure data identifying stage and retry/reconciliation guidance.

Action: follow that guidance. For an ambiguous provider effect, reconcile/read back before replay.

## OpenAI support evidence packet

Capture the smallest packet that identifies the first host-side failure:

- absolute timestamp with timezone;
- ChatGPT conversation URL and workspace plan;
- browser or desktop-app version;
- Stensibly app name, draft/published state, and visible action count;
- exact prompt and selected tool;
- first failure text;
- expected published count and fingerprints from the release receipt;
- whether the failed call produced a Stensibly request/diagnostic receipt;
- whether refresh/recreation, a fresh conversation, or OAuth reconnect changed the result;
- browser console export and **HAR** when the failure occurs before or around dispatch.

Remove credentials, cookies, OAuth codes, tokens, and private project payloads before sharing the packet.

## Repository release rule

`docs/chatgpt-app-actions.json` owns the current ChatGPT publication receipt.

- `published_default` is the normal ChatGPT profile;
- `full_internal` stays available for explicit internal/admin use;
- public visibility changes rotate the names-only manifest identity;
- public name/description/annotation/input-schema changes rotate the full contract identity;
- any public contract change enters the refresh/rescan/recreation flow before dogfood;
- the representative fresh-connection proof passes before directory submission;
- historical action snapshots remain available through Git history instead of becoming supported live modes.
