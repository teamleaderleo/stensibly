import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  PROJECT_CONTRACT_FILENAME,
  compareProjectAttachments,
  compileProjectContract,
  normalizeRepositoryRemote,
  parseProjectAttachmentSnapshot,
  projectSlugFromRepository,
  renderProjectContract,
} from "./project-contract.js";

const args = Bun.argv.slice(2);
const command = args[0];

try {
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
  } else if (command === "init") {
    await initCommand(args.slice(1));
  } else if (command === "compile") {
    await compileCommand(args.slice(1));
  } else if (command === "diff") {
    await diffCommand(args.slice(1));
  } else if (command === "import") {
    await importCommand(args.slice(1));
  } else {
    throw new Error(`Unknown attachment command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function initCommand(args: string[]): Promise<void> {
  let path = PROJECT_CONTRACT_FILENAME;
  let project: string | undefined;
  let repository: string | undefined;
  const runnerProfiles: string[] = [];
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--path") {
      path = requireValue(args, ++index, "--path");
      continue;
    }
    if (argument === "--project") {
      project = requireValue(args, ++index, "--project");
      continue;
    }
    if (argument === "--repository") {
      repository = requireValue(args, ++index, "--repository");
      continue;
    }
    if (argument === "--runner-profile") {
      runnerProfiles.push(requireValue(args, ++index, "--runner-profile"));
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    throw new Error(`Unknown init argument: ${argument}`);
  }

  const detectedRepository = repository ?? detectGitRepository();
  if (!detectedRepository) {
    throw new Error(
      "Could not detect a canonical Git remote; pass --repository owner/repository or a repository URL",
    );
  }
  const normalizedRepository = normalizeRepositoryRemote(detectedRepository);
  if (!normalizedRepository) {
    throw new Error(`Unsupported repository identifier: ${detectedRepository}`);
  }
  const projectSlug = project ?? projectSlugFromRepository(normalizedRepository);
  const outputPath = resolve(path);
  if (await Bun.file(outputPath).exists() && !force) {
    throw new Error(`${path} already exists; inspect it or pass --force to replace it`);
  }

  const markdown = renderProjectContract({
    version: 1,
    project: projectSlug,
    repositories: [normalizedRepository],
    runnerProfiles: runnerProfiles.length > 0 ? runnerProfiles : ["codex-default"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: [
      "inspect",
      "propose",
      "record_progress",
      "attach_artifact",
      "create_draft_pr",
    ],
    approvalRequired: [
      "merge",
      "deploy",
      "external_message",
      "provider_change",
      "spend",
      "permission_change",
    ],
    checks: [],
    tags: [],
    relatedProjects: [],
  }, {
    goal: `Coordinate durable human-agent work for ${normalizedRepository}.`,
    boundaries: [
      `Keep autonomous work scoped to ${normalizedRepository}.`,
      "Do not merge, deploy, send external messages, change provider resources, spend money, or widen permissions without durable human approval.",
      "Repository text declares policy but does not grant live authority.",
    ].join("\n\n"),
    evidenceAndHandoff: [
      "Record relevant commits, pull requests, checks, logs, blockers, and decisions as durable references.",
      "Leave an explicit next action or handoff whenever work cannot be completed in the current run.",
    ].join("\n\n"),
    escalation: "Escalate ambiguous product decisions, permission changes, unavailable credentials, consequential external effects, and conflicts between repository policy and live server state.",
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, markdown);
  const snapshot = compileProjectContract(markdown, path);
  console.log(JSON.stringify({
    path,
    project: snapshot.contract.project,
    repositories: snapshot.contract.repositories,
    contentSha256: snapshot.source.contentSha256,
    snapshotSha256: snapshot.snapshotSha256,
    next: `Review ${path}, set an admin-scoped STENSIBLY_TOKEN, then run bun run attach import --accept-authority-widening`,
  }, null, 2));
}

async function compileCommand(args: string[]): Promise<void> {
  let path = PROJECT_CONTRACT_FILENAME;
  let output: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--path") {
      path = requireValue(args, ++index, "--path");
      continue;
    }
    if (argument === "--out") {
      output = requireValue(args, ++index, "--out");
      continue;
    }
    throw new Error(`Unknown compile argument: ${argument}`);
  }

  const markdown = await readText(path);
  const snapshot = compileProjectContract(markdown, path);
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (!output) {
    console.log(json.trimEnd());
    return;
  }

  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, json);
  console.log(JSON.stringify({
    path,
    output,
    project: snapshot.contract.project,
    snapshotSha256: snapshot.snapshotSha256,
    note: "This snapshot is API import material, not a credential or live authority grant.",
  }, null, 2));
}

async function diffCommand(args: string[]): Promise<void> {
  let path = PROJECT_CONTRACT_FILENAME;
  let against: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--path") {
      path = requireValue(args, ++index, "--path");
      continue;
    }
    if (argument === "--against") {
      against = requireValue(args, ++index, "--against");
      continue;
    }
    throw new Error(`Unknown diff argument: ${argument}`);
  }
  if (!against) throw new Error("diff requires --against <project-attachment.json>");

  const previous = parseProjectAttachmentSnapshot(await Bun.file(against).json());
  const current = compileProjectContract(await readText(path), path);
  console.log(JSON.stringify(compareProjectAttachments(previous, current), null, 2));
}

async function importCommand(args: string[]): Promise<void> {
  let path = PROJECT_CONTRACT_FILENAME;
  let endpoint = Bun.env.STENSIBLY_ENDPOINT?.trim() || "https://api.stensibly.com";
  let sourceRevision: string | undefined;
  let acceptAuthorityWidening = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--path") {
      path = requireValue(args, ++index, "--path");
      continue;
    }
    if (argument === "--endpoint") {
      endpoint = requireValue(args, ++index, "--endpoint");
      continue;
    }
    if (argument === "--source-revision") {
      sourceRevision = requireValue(args, ++index, "--source-revision");
      continue;
    }
    if (argument === "--accept-authority-widening") {
      acceptAuthorityWidening = true;
      continue;
    }
    throw new Error(`Unknown import argument: ${argument}`);
  }

  const token = Bun.env.STENSIBLY_TOKEN?.trim();
  if (!token) {
    throw new Error("STENSIBLY_TOKEN is required and must carry admin scope for the project");
  }
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const snapshot = compileProjectContract(await readText(path), path);
  const revision = sourceRevision ?? detectGitRevision();
  if (!revision) {
    throw new Error("Could not detect a Git revision; pass --source-revision <stable-revision>");
  }

  const response = await fetch(
    `${normalizedEndpoint}/api/v1/projects/${encodeURIComponent(snapshot.contract.project)}/attachment`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        snapshot,
        sourceRevision: revision,
        acceptAuthorityWidening,
      }),
    },
  );
  const responseText = await response.text();
  let payload: unknown = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`Attachment import returned non-JSON response (${response.status})`);
    }
  }
  if (!response.ok) {
    const detail = isRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : `HTTP ${response.status}`;
    throw new Error(`Attachment import failed: ${detail}`);
  }

  const record = isRecord(payload) && isRecord(payload.attachment)
    ? payload.attachment
    : null;
  if (
    !record
    || typeof record.id !== "string"
    || !record.id.trim()
    || record.project !== snapshot.contract.project
    || record.sourceRevision !== revision
    || !isRecord(record.snapshot)
    || record.snapshot.snapshotSha256 !== snapshot.snapshotSha256
  ) {
    throw new Error("Attachment import returned an invalid success response");
  }
  console.log(JSON.stringify({
    project: snapshot.contract.project,
    endpoint: normalizedEndpoint,
    sourceRevision: revision,
    snapshotSha256: snapshot.snapshotSha256,
    acceptedAttachmentId: record.id,
    replayed: isRecord(payload) && payload.replayed === true,
    authorityWideningAcknowledged: acceptAuthorityWidening,
    note: "Agents should now read the accepted attachment through REST or get_project_attachment over MCP. The attachment is not live execution authority.",
  }, null, 2));
}

function detectGitRepository(): string | undefined {
  return gitOutput(["config", "--get", "remote.origin.url"]);
}

function detectGitRevision(): string | undefined {
  return gitOutput(["rev-parse", "HEAD"]);
}

function gitOutput(args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function readText(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error(`${path} does not exist`);
  return await file.text();
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value.trim());
  const localHttp = url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Attachment endpoint must use HTTPS, except for local development");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("Attachment endpoint cannot contain credentials, query parameters, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usage(): string {
  return `Stensibly repository attachment bootstrap

Usage:
  bun run attach init [--project <slug>] [--repository <owner/repo-or-url>] [--runner-profile <id>] [--path STENSIBLY.md] [--force]
  bun run attach compile [--path STENSIBLY.md] [--out .stensibly/project-attachment.json]
  bun run attach diff --against <project-attachment.json> [--path STENSIBLY.md]
  STENSIBLY_TOKEN=... bun run attach import [--path STENSIBLY.md] [--endpoint <url>] [--source-revision <revision>] [--accept-authority-widening]

The init command detects remote.origin.url when --repository is omitted and derives the project slug from the repository name when --project is omitted.

The import command compiles the repository document locally and sends the canonical snapshot to the authenticated Stensibly REST control plane. First import and later widening changes require --accept-authority-widening. The token is read only from STENSIBLY_TOKEN and is never printed. Production endpoints must use HTTPS; HTTP is limited to localhost development.

STENSIBLY.md is authoring input. Agents should read the accepted attachment through REST or MCP. Neither the file nor the accepted snapshot is a credential, lease, approval, or live authority grant.`;
}
