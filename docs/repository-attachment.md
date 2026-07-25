# Repository attachment bootstrap

Stensibly uses `STENSIBLY.md` as repository-authored input for a project attachment. The file is deliberately not the runtime interface for agents.

The flow is:

```text
repository/STENSIBLY.md
        |
        | bun run attach compile / import
        v
canonical hashed attachment snapshot
        |
        | authenticated admin review
        v
append-only accepted project attachment
        |
        +--> REST project attachment read
        +--> MCP get_project_attachment
        +--> dashboard and supervisor policy views
```

Agents should normally enter a project through Stensibly REST or MCP, read the project brief and accepted attachment, and then use server-owned work, claim, run, approval, and event contracts. They should not repeatedly parse arbitrary repository Markdown as if it were live coordination state.

## Initialise a repository

From a Git repository with an `origin` remote:

```bash
bun run attach init
```

The command:

1. reads `remote.origin.url`;
2. normalises common GitHub HTTPS and SSH remotes to `owner/repository`;
3. derives a lowercase project slug from the repository name;
4. writes a conservative root `STENSIBLY.md`;
5. defaults project and global concurrency to one;
6. permits inspection, proposals, progress recording, artifact attachment, and draft pull requests;
7. approval-gates merges, deployments, external messages, provider changes, spending, and permission changes;
8. validates the generated document and prints its content and snapshot hashes.

Override detection when needed:

```bash
bun run attach init \
  --project example-project \
  --repository owner/repository \
  --runner-profile codex-default
```

Use `--path` for an explicitly chosen file. No recursive magic-file lookup is performed. An existing file is never replaced unless `--force` is supplied.

## File structure

`STENSIBLY.md` contains two kinds of input.

### Machine declaration

Exactly one fenced `stensibly` block contains strict JSON:

````markdown
```stensibly
{
  "version": 1,
  "project": "example-project",
  "repositories": ["owner/repository"],
  "runnerProfiles": ["codex-default"],
  "concurrency": {
    "project": 1,
    "global": 1
  },
  "autonomousActions": [
    "inspect",
    "propose",
    "record_progress",
    "attach_artifact",
    "create_draft_pr"
  ],
  "approvalRequired": [
    "merge",
    "deploy",
    "external_message",
    "provider_change",
    "spend",
    "permission_change"
  ],
  "checks": ["bun run typecheck", "bun test"],
  "tags": ["backend"],
  "relatedProjects": []
}
```
````

JSON is used instead of a general YAML parser so the initial contract has one exact, portable grammar. Unknown fields, duplicate array values, invalid identifiers, conflicting action classes, and unsafe concurrency values are rejected. The surrounding document remains ordinary Markdown.

### Durable human context

Four required sections carry repository-specific meaning:

- `## Goal`
- `## Boundaries`
- `## Evidence and handoff expectations`
- `## Escalation`

These sections become fields in the compiled snapshot. They are durable continuation context, not private model reasoning.

## Compile an API-ready snapshot

Print the canonical snapshot:

```bash
bun run attach compile
```

Write it to a file:

```bash
bun run attach compile --out .stensibly/project-attachment.json
```

The snapshot contains:

- a format and schema version;
- the validated declaration;
- the four required context sections;
- the source path;
- a SHA-256 hash of normalised source content;
- a SHA-256 hash of the canonical snapshot payload.

The snapshot is deterministic. No current time, machine identity, credentials, Git branch, or mutable process state is included.

## Review changes and permission widening

Compare the current repository file with an earlier compiled snapshot:

```bash
bun run attach diff \
  --against .stensibly/project-attachment.json
```

The diff classifies changes as widening, narrowing, or neutral.

Widening changes currently include:

- adding a repository;
- adding a runner profile;
- adding an autonomous action;
- removing an approval requirement;
- increasing project or global concurrency;
- changing the attached project identity.

Context, checks, tags, and related-project edits are reported but do not themselves grant authority.

This classification supports an explicit reviewed import. It is not a substitute for server-side authorization.

## Import the reviewed attachment

Use an admin-scoped token for the target project:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run attach import --accept-authority-widening
```

The import command:

1. compiles and validates `STENSIBLY.md` locally;
2. reads the current Git commit with `git rev-parse HEAD` unless `--source-revision` is supplied;
3. sends the canonical snapshot to the configured REST endpoint;
4. records the accepted snapshot, repository revision, importer label, and acceptance time;
5. never accepts the raw token as a command-line argument and never prints it.

The first accepted attachment establishes the project policy surface, so it is classified as widening and requires `--accept-authority-widening`. Later neutral or narrowing changes do not require the flag. Later widening changes require it again.

Use another endpoint when needed:

```bash
STENSIBLY_ENDPOINT=http://localhost:3000 \
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run attach import --accept-authority-widening
```

The server uses compare-and-swap against the current accepted snapshot. If another reviewer accepts a newer revision while an import is being prepared, the stale import fails and must be reviewed again.

## Read the accepted attachment

REST:

```bash
curl "$STENSIBLY_ENDPOINT/api/v1/projects/example-project/attachment" \
  -H "authorization: Bearer $STENSIBLY_TOKEN"
```

MCP:

```text
get_project_attachment({ project: "example-project" })
```

The MCP server instructs agents to read the project brief first and then the accepted attachment. Read access follows the same project allowlist as the rest of the ledger. Import is intentionally REST/admin-only in this slice; ordinary agents cannot rewrite policy through MCP.

Accepted records are append-only. The read projection returns the current record, including:

- the exact validated snapshot;
- source path and repository revision;
- source and snapshot hashes;
- a redacted kind-qualified importer display name;
- whether that acceptance widened declared authority;
- the acceptance timestamp.

Raw token IDs, account IDs, secrets, and credentials are not returned.

## Security boundary

Neither `STENSIBLY.md` nor its compiled or accepted snapshot is:

- a credential;
- an API token;
- a claim or run lease;
- a fencing generation;
- a human approval for an external effect;
- proof that an external effect occurred;
- permission for a supervisor to widen its own scope.

A repository branch can propose policy. It cannot silently change the authority of an already running supervisor. Live holder, generation, expiry, command, approval, and execution state remain server-owned.

The accepted attachment is a reviewed input to future selection and explanation policy. It does not by itself authorize a runner to merge, deploy, message, spend, change a provider, or perform any other consequential action.

## Discovery policy

The convention is intentionally narrow:

1. use a path explicitly supplied to the command;
2. otherwise use root `STENSIBLY.md`;
3. do not recursively search parent directories, subdirectories, `AGENTS.md`, vendor-specific instruction files, or similarly named files.

Other agent instruction files can still exist. They are inputs to the relevant harness, not aliases for the Stensibly project attachment.
