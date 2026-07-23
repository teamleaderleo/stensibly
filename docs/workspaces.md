# Workspace boundary

Stensibly currently treats project slugs as globally unique. That works for one scrapbook and becomes awkward once one server holds personal work, client work, experiments, or several people.

The first workspace slice should add isolation without making every local tool call carry a pile of tenancy arguments.

## Goals

- Every project belongs to exactly one workspace.
- The existing database migrates into a `default` workspace automatically.
- Two workspaces may use the same project slug.
- HTTP tokens belong to one workspace and may narrow access to selected projects.
- Item, event, artifact, brief, and custodian queries cannot cross the selected workspace.
- Local MCP clients choose one workspace when the process starts.
- Idempotency keys collide only inside their workspace.

## Proposed records

```text
workspaces
  id             opaque stable ID
  slug           human-facing unique slug
  name
  created_at

projects
  id             opaque stable ID
  workspace_id   references workspaces.id
  slug           human-facing project slug
  name
  created_at
  unique(workspace_id, slug)

api_tokens
  workspace_id   references workspaces.id
  project_ids    optional project allowlist inside that workspace
```

Items keep referencing the opaque project ID. Events and artifacts inherit their workspace through the item. This avoids copying `workspace_id` into every table while preserving a single authoritative path:

```text
workspace → project → item → event/artifact
```

## Why projects need opaque IDs

The current project ID is also its slug. Adding `workspace_id` while keeping that global primary key would prevent two workspaces from both having a project called `scrapbook`.

The migration should split identity from presentation:

```text
current project id: scrapbook

becomes

project id:   prj_<random>
workspace:    default
project slug: scrapbook
```

Every existing `items.project_id` reference is rewritten inside one transaction.

## API selection

HTTP requests derive the workspace from the authenticated token. Project parameters remain human-facing slugs:

```text
GET /api/projects/scrapbook/brief
GET /api/items?project=scrapbook
```

A token never chooses another workspace through a request parameter. This removes an entire class of cross-workspace mistakes.

Local development with authentication disabled uses `STENSIBLY_WORKSPACE`, defaulting to `default`:

```bash
STENSIBLY_WORKSPACE=default bun run start
```

The stdio MCP server follows the same rule:

```bash
STENSIBLY_WORKSPACE=default bun run mcp
```

MCP tools continue accepting project slugs without repeating the workspace on every call.

## Token semantics

A token record carries:

```text
workspace_id
scopes: read | write | admin
project_ids: null or explicit allowlist
```

`admin` remains bounded by the token's workspace. An all-project token means every project in that workspace.

Token creation should accept workspace and project slugs, then store resolved opaque IDs:

```bash
bun run tokens create \
  --name local-agent \
  --workspace personal \
  --scopes read,write \
  --projects scrapbook,stensibly
```

## Idempotency

The current event ledger treats idempotency keys as globally unique. Workspaces should use:

```text
unique(workspace_id, idempotency_key)
```

The workspace can be derived from the event's item during writes, though a dedicated workspace column on events makes the uniqueness constraint and lookup direct. The migration may add that denormalized column with a foreign key and keep it synchronized at insertion time.

## Custodian and briefs

Both operate inside one workspace:

- HTTP brief requests inherit the token workspace.
- MCP briefs inherit `STENSIBLY_WORKSPACE`.
- The custodian accepts `--workspace`, defaulting to `STENSIBLY_WORKSPACE` or `default`.
- Cross-workspace inspection requires an explicit future server-admin command.

## Migration sequence

1. Begin an exclusive migration transaction.
2. Create `workspaces` and insert `default`.
3. Create a replacement `projects` table with opaque IDs, workspace IDs, and slugs.
4. Copy every current project into `default` and retain an old-ID → new-ID map.
5. Rewrite item project references through the map.
6. Attach existing API tokens to `default` and convert project slugs to project IDs.
7. Scope idempotency records to `default`.
8. Rebuild indexes and foreign keys.
9. Commit only after integrity checks pass.

A database backup should remain part of the CLI migration command even while the project is young.

## Security invariants

- Request parameters never select a workspace for an authenticated HTTP request.
- Every project lookup includes the resolved workspace.
- Item authorization resolves through the item's project and workspace.
- Collection queries receive workspace filtering at the SQL boundary.
- A missing project and a project in another workspace return the same response to scoped clients.
- Token listings and revocation remain local administrative commands for this slice.
- Raw token secrets remain one-time output.

## Acceptance

- Existing databases open and migrate into `default` without losing item history.
- Two workspaces can each contain a `scrapbook` project.
- HTTP tokens cannot read, infer, or mutate another workspace.
- REST collection queries never filter in application memory for workspace isolation.
- MCP, custodian, and unauthenticated local HTTP all honor `STENSIBLY_WORKSPACE`.
- Briefs, artifact lists, and duplicate-title checks stay inside the workspace.
- Tests cover migration rollback and cross-workspace denial.
