# Project-scoped hosted OAuth bootstrap

## Purpose

Use `STENSIBLY_AUTH_BOOTSTRAP_PROJECTS` to restrict a newly created hosted GitHub
membership to an explicit set of Stensibly projects. This setting affects only the
first membership created for an allowed GitHub identity. It does not modify an
existing membership on later logins.

## Configuration

The value is a comma-separated list of lowercase project slugs:

```text
STENSIBLY_AUTH_BOOTSTRAP_ROLE=member
STENSIBLY_AUTH_BOOTSTRAP_PROJECTS=oauth-dogfood
```

The Worker normalizes entries to lowercase, sorts them, and rejects:

- empty entries;
- duplicate entries after normalization;
- controls or bidirectional-control characters;
- malformed project slugs;
- more than 32 projects;
- more than 2048 UTF-8 bytes of configuration.

Omitting `STENSIBLY_AUTH_BOOTSTRAP_PROJECTS` preserves the existing workspace-wide
bootstrap contract. Do not treat omission as a safe default for a write-capable
production identity.

## Role interaction

- `viewer` grants read only;
- `member` grants read and write;
- `admin` and `owner` also grant administrative scope.

Project restrictions limit which projects the resulting principal and OAuth grant
may access. They do not reduce the scopes granted by the selected role.

For W01 Phase 1, configure `STENSIBLY_AUTH_BOOTSTRAP_ROLE=viewer`, leave all MCP
OAuth bindings absent, and do not complete a GitHub login. Before Phase 2, confirm
the dedicated dogfood project slug and obtain the required approval for the exact
write-capable role and project list.

## Existing memberships

A later login for an existing provider identity reuses the existing active
membership. Changing the bootstrap role or project variable does not silently widen
or narrow that membership. Any existing-membership change requires a separate
reviewed operator or product path.

## Authority boundary

Adding this code does not configure Cloudflare, deploy the Worker, create a GitHub
OAuth App, log in, enable MCP OAuth, grant write access, or authorize the W01
production write. Production bindings and deployment remain Tier 3 actions requiring
contemporaneous human approval.
