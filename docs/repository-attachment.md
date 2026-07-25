# Repository attachment bootstrap

Stensibly uses `STENSIBLY.md` as repository-authored input for a project attachment. The file is deliberately not the runtime interface for agents.

The intended flow is:

```text
repository/STENSIBLY.md
        |
        | bun run attach compile
        v
canonical hashed attachment snapshot
        |
        | explicit reviewed API import (next slice)
        v
Stensibly project attachment
        |
        +--> REST
        +--> MCP
        +--> dashboard and supervisor policy views
```

Agents should normally enter a project through Stensibly REST or MCP, read the project brief and imported attachment, and then use server-owned work, claim, run, approval, and event contracts. They should not repeatedly parse arbitrary repository Markdown as if it were live coordination state.

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

JSON is used instead of a general YAML parser so the initial contract has one exact, portable grammar with duplicate and unknown-field rejection. The surrounding document remains ordinary Markdown.

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

This classification is intended to support an explicit reviewed import. It is not a substitute for server-side authorization.

## Security boundary

Neither `STENSIBLY.md` nor its compiled snapshot is:

- a credential;
- an API token;
- a claim or run lease;
- a fencing generation;
- a human approval;
- proof that an external effect occurred;
- permission for a supervisor to widen its own scope.

A repository branch can propose policy. It cannot silently change the authority of an already running supervisor. The next implementation slice will store approved snapshots in the server and expose the accepted revision through REST and MCP. Live holder, generation, expiry, command, approval, and execution state remain server-owned.

## Discovery policy

The first convention is intentionally narrow:

1. use a path explicitly supplied to the command;
2. otherwise use root `STENSIBLY.md`;
3. do not recursively search parent directories, subdirectories, `AGENTS.md`, vendor-specific instruction files, or similarly named files.

Other agent instruction files can still exist. They are inputs to the relevant harness, not aliases for the Stensibly project attachment.
