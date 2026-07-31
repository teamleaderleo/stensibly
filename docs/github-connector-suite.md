# GitHub connector suite strategy

## Decision

Use GitHub's official MCP server as the compatibility and delegated-execution source for the broad GitHub capability surface. Keep Stensibly's public model-visible surface compact and stable, then expose the long tail through catalogue discovery and guarded dispatch.

The upstream source is:

- repository: `github/github-mcp-server`;
- local image: `ghcr.io/github/github-mcp-server`;
- remote endpoint: `https://api.githubcopilot.com/mcp/`.

Stensibly should avoid copying every host-specific GitHub connector action into first-party source one wrapper at a time. The ChatGPT GitHub connector action list is useful product evidence, while its action names and schemas belong to that host integration. GitHub's official MCP catalogue is the reusable source with explicit toolsets, read-only filtering, an `all` profile, remote and local execution modes, and upstream maintenance.

## Upstream capability groups

The current reviewed official inventory contains these standard toolsets:

- `actions`;
- `code_quality`;
- `code_security`;
- `context`;
- `copilot`;
- `copilot_issue_intents`;
- `dependabot`;
- `discussions`;
- `gists`;
- `git`;
- `issues`;
- `labels`;
- `notifications`;
- `orgs`;
- `projects`;
- `pull_requests`;
- `repos`;
- `secret_protection`;
- `security_advisories`;
- `stargazers`;
- `users`.

The remote service also publishes remote-only toolsets:

- `copilot_spaces`;
- `github_support_docs_search`.

GitHub supports toolset selection through URL paths or `X-MCP-Toolsets`, exact tool selection through `X-MCP-Tools`, read-only filtering through `X-MCP-Readonly`, lockdown mode, and insiders mode. The local server exposes equivalent environment variables or flags for the shared capabilities.

Source revisions reviewed:

- remote catalogue: `github/github-mcp-server` main file `docs/remote-server.md`, blob `04d3ceefae5fe851c104ea9b2c53393a8f03944e`;
- shared source inventory: commit `ca8ab52dcc45b86fae190398178fd22edb7b1362`, file `pkg/github/tools.go`, blob `7bae64d2e85c60fcb2ea00933c3a853c4ca4e10a`.

The shared source inventory declares `context` as a default toolset and does not classify it as remote-only.

## Stensibly product surface

The durable Stensibly-facing tools remain:

- `github_list_toolsets`;
- `github_search_tools`;
- `github_get_tool`;
- `github_call_tool`.

High-value or consequential operations may also keep typed first-party tools where exact inputs, authority checks, stale-version fences, read-after-write verification, or specialized recovery add real protection.

The delegated path should:

1. select a reviewed profile;
2. intersect toolsets with provider availability, installation access, project binding, client scopes, grants, approval policy, read-only policy, and budgets;
3. bind a catalogue revision and exact tool schema before dispatch;
4. record an attributable receipt;
5. reserve writes before provider contact;
6. reconcile ambiguous writes before any retry.

## Profiles

The first profile registry lives in `src/github-toolset-profiles.ts`:

- `default`: authenticated context, repositories, issues, pull requests, and users;
- `read_only`: every reviewed provider-available toolset with writes removed;
- focused `actions`, `security`, `projects`, and `notifications` profiles;
- `all`: every reviewed provider-available toolset, with explicit operator approval required.

Provider resolution removes reviewed remote-only toolsets from local-sidecar profiles and reports the omitted names instead of silently presenting unavailable capabilities. The default and broad profiles include the shared `context` group so authenticated identity and operating context remain available in both provider modes.

## Compatibility tests

Tests should protect stable required tools, uniqueness, schemas, authority boundaries, and drift behavior. A global exact tool count blocks healthy additive growth and turns every new capability into unrelated test maintenance.

Use these rules:

- required stable public tools remain asserted by name;
- duplicate names fail;
- observed snapshots may record a count and fingerprint for audit history;
- additive tools inside an already reviewed toolset pass compatibility checks, subject to read-only and policy metadata;
- a newly observed toolset remains quarantined until its provider availability, authority implications, and profile membership receive an explicit inventory revision;
- removals, schema narrowing, authority widening, or read-to-write changes require explicit drift handling.

## Implementation sequence

1. Catalogue and profile contracts — active under #585.
2. Catalogue service boundary plus an in-memory fake delegated MCP adapter.
3. Stable public list, search, and get discovery tools.
4. Stensibly-owned GitHub connection and repository-binding persistence.
5. Read-only delegated calls with receipts.
6. Guarded write dispatch with reservation, verification, ambiguity, and reconciliation tests.
7. Remote delegation and local-sidecar adapters behind the same contract.
8. Automated upstream catalogue snapshot and CI drift classification.

The full suite arrives through one governed GitHub capability boundary. Clients can use the focused typed tools and the broad delegated catalogue together without depending on a second connector namespace.