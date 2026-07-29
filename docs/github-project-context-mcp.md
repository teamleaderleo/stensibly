# GitHub project context and connector recovery projection

Issue #492 keeps GitHub as the independently usable public source of truth while Stensibly retains bounded accepted observations for coordination and recovery.

This slice adds `getSqliteGitHubProjectContext()`: a content-minimised read projection that can later be registered through REST, MCP, or the dashboard without reinterpreting provider state.

## Modes

With only `project`, the projection returns a bounded list of current accepted GitHub issue contexts for that project.

With `externalId` in canonical form:

```text
github:owner/repository#number
```

it returns the current accepted issue plus bounded synchronization history.

## Projection boundary

The result includes:

- canonical GitHub issue identity and direct public URL;
- repository, issue number, title, state, labels, assignees, milestone, and explicit relationships;
- provider creation, update, and source-revision evidence;
- synchronized or degraded state and bounded degraded reason;
- observation and acceptance times and attribution;
- accepted repository instruction-set identity and source paths;
- explicit recovery guidance for restoring GitHub and Stensibly app use.

The result excludes:

- raw issue bodies or discussion history;
- issue-body, content, snapshot, or instruction content fingerprints;
- synchronization cursors;
- unrestricted provider payloads;
- claims, leases, approvals, grants, credentials, or mutation authority;
- any automatic GitHub read or write.

The projection is last-known accepted context. A synchronized projection is not a guarantee that GitHub is currently reachable. A degraded projection is a direct instruction to open the canonical GitHub URL and reconcile against the public source before consequential work.

## Conversation recovery guidance

Every result includes machine-readable guidance with these steps:

1. use a normal ChatGPT conversation rather than agent mode or company knowledge for the write-capable app combination;
2. explicitly select both GitHub and Stensibly;
3. start a new conversation when schemas appear but calls fail before any Stensibly request receipt, because that indicates conversation-host binding failure;
4. refresh or recreate the Stensibly app when its action manifest is stale;
5. reconnect OAuth when a request reaches Stensibly and reports authentication failure.

Stensibly cannot restore a missing first-party GitHub connector from the server side. It can preserve the canonical link, accepted issue state, instruction identity, synchronization evidence, and exact recovery steps so a worker is not trapped inside one narrow tool call or stale chat.

## Storage and integrity

Project mode reads the current external identities directly from `github_issue_contexts`, ordered by canonical external ID. Each identity is then reread through `getCurrentSqliteGitHubIssueContext()`, preserving the existing canonical snapshot, instruction-set, attachment-binding, and row-integrity checks.

Issue mode reuses the existing current-record and append-only history APIs. History is returned chronologically and bounded to the requested tail.

The current remote workspace boundary remains `default`; project remains explicit and bounded.

## Public integration boundary

This commit does not register a new MCP action or change the ChatGPT action manifest. Public registration must separately:

- classify the read as project-scoped in the MCP gateway before exposure;
- add the action to the manifest and checked-in ChatGPT app snapshot;
- refresh or recreate the Stensibly ChatGPT app;
- test project allowlists, read scope, stale action scans, and hosted degraded recovery.

Keeping registration separate avoids accidentally exposing an authenticated-but-unscoped read when a new tool name is not yet known to the gateway.

## Non-goals

This slice performs no GitHub API call, polling, webhook intake, issue mutation, provider receipt, credential resolution, dashboard projection, MCP registration, or automatic cross-system state transition.
