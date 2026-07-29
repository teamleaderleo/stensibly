# GitHub project context and connector recovery

Issue #492 keeps GitHub as the independently usable public source of truth while Stensibly retains bounded accepted observations for coordination and recovery.

`get_github_project_context` exposes that accepted context through one read-only, project-scoped MCP tool.

## Modes

With only `project`, the tool returns a bounded list of current accepted GitHub issue contexts for that project.

With `externalId` in canonical form:

```text
github:owner/repository#number
```

it returns the current accepted issue plus bounded synchronization history.

## Projection boundary

The response includes:

- canonical GitHub issue identity and direct public URL;
- repository, issue number, title, state, labels, assignees, milestone, and explicit relationships;
- provider creation, update, and source-revision evidence;
- synchronized or degraded state and bounded degraded reason;
- observation and acceptance times and attribution;
- accepted repository instruction-set identity and source paths;
- explicit recovery guidance for restoring GitHub and Stensibly app use.

The response excludes:

- raw issue bodies or discussion history;
- issue-body, content, snapshot, or instruction content fingerprints;
- synchronization cursors;
- unrestricted provider payloads;
- claims, leases, approvals, grants, credentials, or mutation authority;
- any automatic GitHub read or write.

The projection is last-known accepted context. A synchronized projection is not a guarantee that GitHub is currently reachable. A degraded projection is a direct instruction to open the canonical GitHub URL and reconcile against the public source before consequential work.

## Conversation recovery guidance

Every response includes machine-readable guidance with these steps:

1. use a normal ChatGPT conversation rather than agent mode or company knowledge for the write-capable app combination;
2. explicitly select both GitHub and Stensibly;
3. start a new conversation when schemas appear but calls fail before any Stensibly request receipt, because that indicates conversation-host binding failure;
4. refresh or recreate the Stensibly app when its action manifest is stale;
5. reconnect OAuth when a request reaches Stensibly and reports authentication failure.

Stensibly cannot restore a missing first-party GitHub connector from the server side. It can preserve the canonical link, accepted issue state, instruction identity, synchronization evidence, and exact recovery steps so a worker is not trapped inside one narrow tool call or one stale chat.

## Authorization

The MCP gateway classifies the tool as read-only and requires the caller to have read scope and access to the requested project. The tool uses the existing default workspace boundary because the current remote token contract is project-scoped.

## ChatGPT action snapshot

Adding this public tool changes the MCP tool manifest. The same change updates `docs/chatgpt-app-actions.json` and `docs/chatgpt-app-recovery.md`.

After deployment, refresh or recreate the Stensibly ChatGPT app before dogfood verification. A stale action scan will not contain `get_github_project_context`.

## Non-goals

This slice performs no GitHub API call, polling, webhook intake, issue mutation, provider receipt, credential resolution, dashboard projection, or automatic cross-system state transition.
