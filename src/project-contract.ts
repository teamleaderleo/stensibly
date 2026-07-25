import { createHash } from "node:crypto";
import { z } from "zod";

export const PROJECT_CONTRACT_FILENAME = "STENSIBLY.md";
export const PROJECT_ATTACHMENT_FORMAT = "stensibly.project-attachment";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Use a lowercase identifier");

const projectSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug");

const repositorySchema = z
  .string()
  .trim()
  .min(3)
  .max(512)
  .refine(
    isCanonicalRepositoryIdentifier,
    "Use owner/repository or a credential-free HTTP(S) or SSH repository URL",
  );

const uniqueArray = <T extends z.ZodTypeAny>(schema: T, maximum: number) =>
  z.array(schema).max(maximum).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = typeof value === "string" ? value : JSON.stringify(value);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate value: ${key}`,
          path: [index],
        });
      }
      seen.add(key);
    }
  });

const projectContractBaseSchema = z.object({
  version: z.literal(1),
  project: projectSlugSchema,
  repositories: uniqueArray(repositorySchema, 32).min(1),
  runnerProfiles: uniqueArray(identifierSchema, 32).default([]),
  concurrency: z.object({
    project: z.number().int().min(1).max(100),
    global: z.number().int().min(1).max(100),
  }).strict(),
  autonomousActions: uniqueArray(identifierSchema, 64).default([]),
  approvalRequired: uniqueArray(identifierSchema, 64).default([]),
  checks: uniqueArray(z.string().trim().min(1).max(500), 50).default([]),
  tags: uniqueArray(identifierSchema, 50).default([]),
  relatedProjects: uniqueArray(projectSlugSchema, 50).default([]),
}).strict();

export const projectContractSchema = projectContractBaseSchema.superRefine(
  (contract, context) => {
    if (contract.concurrency.project > contract.concurrency.global) {
      context.addIssue({
        code: "custom",
        message: "Project concurrency cannot exceed global concurrency",
        path: ["concurrency", "project"],
      });
    }

    const overlap = contract.autonomousActions.filter((action) =>
      contract.approvalRequired.includes(action)
    );
    if (overlap.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Actions cannot be both autonomous and approval-required: ${overlap.join(", ")}`,
        path: ["autonomousActions"],
      });
    }
  },
);

export const projectContextSchema = z.object({
  goal: z.string().trim().min(1).max(20_000),
  boundaries: z.string().trim().min(1).max(20_000),
  evidenceAndHandoff: z.string().trim().min(1).max(20_000),
  escalation: z.string().trim().min(1).max(20_000),
}).strict();

const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const projectAttachmentSnapshotBaseSchema = z.object({
  format: z.literal(PROJECT_ATTACHMENT_FORMAT),
  schemaVersion: z.literal(1),
  contract: projectContractSchema,
  context: projectContextSchema,
  source: z.object({
    path: z.string().trim().min(1).max(4096),
    contentSha256: hashSchema,
  }).strict(),
}).strict();

export const projectAttachmentSnapshotSchema = projectAttachmentSnapshotBaseSchema.extend({
  snapshotSha256: hashSchema,
}).strict();

export type ProjectContract = z.infer<typeof projectContractSchema>;
export type ProjectContext = z.infer<typeof projectContextSchema>;
export type ProjectAttachmentSnapshot = z.infer<typeof projectAttachmentSnapshotSchema>;

export interface ProjectAttachmentChange {
  field: string;
  kind: "added" | "removed" | "changed";
  before: unknown;
  after: unknown;
  authorityEffect: "widens" | "narrows" | "neutral";
}

export interface ProjectAttachmentDiff {
  from: string;
  to: string;
  widensAuthority: boolean;
  changes: ProjectAttachmentChange[];
}

export function compileProjectContract(
  markdown: string,
  sourcePath = PROJECT_CONTRACT_FILENAME,
): ProjectAttachmentSnapshot {
  if (new TextEncoder().encode(markdown).byteLength > 256_000) {
    throw new Error(`${PROJECT_CONTRACT_FILENAME} must not exceed 256 KB`);
  }
  if (markdown.includes("\0")) {
    throw new Error(`${PROJECT_CONTRACT_FILENAME} must be UTF-8 text without NUL bytes`);
  }

  const normalized = normalizeNewlines(markdown);
  const contract = projectContractSchema.parse(parseContractBlock(normalized));
  const context = projectContextSchema.parse({
    goal: extractSection(normalized, "Goal"),
    boundaries: extractSection(normalized, "Boundaries"),
    evidenceAndHandoff: extractSection(normalized, "Evidence and handoff expectations"),
    escalation: extractSection(normalized, "Escalation"),
  });
  const base = projectAttachmentSnapshotBaseSchema.parse({
    format: PROJECT_ATTACHMENT_FORMAT,
    schemaVersion: 1,
    contract,
    context,
    source: {
      path: sourcePath,
      contentSha256: hash(normalized),
    },
  });

  return projectAttachmentSnapshotSchema.parse({
    ...base,
    snapshotSha256: hash(canonicalJson(base)),
  });
}

export function parseProjectAttachmentSnapshot(value: unknown): ProjectAttachmentSnapshot {
  const snapshot = projectAttachmentSnapshotSchema.parse(value);
  const { snapshotSha256: _snapshotSha256, ...base } = snapshot;
  const expected = hash(canonicalJson(projectAttachmentSnapshotBaseSchema.parse(base)));
  if (snapshot.snapshotSha256 !== expected) {
    throw new Error("Project attachment snapshot hash does not match its canonical content");
  }
  return snapshot;
}

export function renderProjectContract(
  input: z.input<typeof projectContractSchema>,
  contextInput: z.input<typeof projectContextSchema>,
): string {
  const contract = projectContractSchema.parse(input);
  const context = projectContextSchema.parse(contextInput);
  return `# Stensibly project contract

This file is repository-authored context and declared policy. Agents should consume the imported project attachment through Stensibly REST or MCP rather than treating this Markdown file as live authority.

\`\`\`stensibly
${JSON.stringify(contract, null, 2)}
\`\`\`

## Goal

${context.goal}

## Boundaries

${context.boundaries}

## Evidence and handoff expectations

${context.evidenceAndHandoff}

## Escalation

${context.escalation}
`;
}

export function compareProjectAttachments(
  previousInput: ProjectAttachmentSnapshot,
  nextInput: ProjectAttachmentSnapshot,
): ProjectAttachmentDiff {
  const previous = parseProjectAttachmentSnapshot(previousInput);
  const next = parseProjectAttachmentSnapshot(nextInput);
  const changes: ProjectAttachmentChange[] = [];

  if (previous.contract.project !== next.contract.project) {
    changes.push({
      field: "project",
      kind: "changed",
      before: previous.contract.project,
      after: next.contract.project,
      authorityEffect: "widens",
    });
  }

  compareStringSets(changes, "repositories", previous.contract.repositories, next.contract.repositories, "widens", "narrows");
  compareStringSets(changes, "runnerProfiles", previous.contract.runnerProfiles, next.contract.runnerProfiles, "widens", "narrows");
  compareStringSets(changes, "autonomousActions", previous.contract.autonomousActions, next.contract.autonomousActions, "widens", "narrows");
  compareStringSets(changes, "approvalRequired", previous.contract.approvalRequired, next.contract.approvalRequired, "narrows", "widens");
  compareStringSets(changes, "checks", previous.contract.checks, next.contract.checks, "neutral", "neutral");
  compareStringSets(changes, "tags", previous.contract.tags, next.contract.tags, "neutral", "neutral");
  compareStringSets(changes, "relatedProjects", previous.contract.relatedProjects, next.contract.relatedProjects, "neutral", "neutral");

  for (const field of ["project", "global"] as const) {
    const before = previous.contract.concurrency[field];
    const after = next.contract.concurrency[field];
    if (before !== after) {
      changes.push({
        field: `concurrency.${field}`,
        kind: "changed",
        before,
        after,
        authorityEffect: after > before ? "widens" : "narrows",
      });
    }
  }

  for (const field of ["goal", "boundaries", "evidenceAndHandoff", "escalation"] as const) {
    const before = previous.context[field];
    const after = next.context[field];
    if (before !== after) {
      changes.push({
        field: `context.${field}`,
        kind: "changed",
        before,
        after,
        authorityEffect: "neutral",
      });
    }
  }

  if (previous.source.path !== next.source.path) {
    changes.push({
      field: "source.path",
      kind: "changed",
      before: previous.source.path,
      after: next.source.path,
      authorityEffect: "neutral",
    });
  }
  if (previous.source.contentSha256 !== next.source.contentSha256) {
    changes.push({
      field: "source.contentSha256",
      kind: "changed",
      before: previous.source.contentSha256,
      after: next.source.contentSha256,
      authorityEffect: "neutral",
    });
  }

  return {
    from: previous.snapshotSha256,
    to: next.snapshotSha256,
    widensAuthority: changes.some((change) => change.authorityEffect === "widens"),
    changes,
  };
}

export function normalizeRepositoryRemote(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;

  const scp = /^([^@\s]+)@([^:\s]+):(.+)$/.exec(value);
  if (scp) {
    const user = scp[1];
    const host = scp[2]?.toLowerCase();
    const rawPath = scp[3] ?? "";
    if (/[?#]/.test(rawPath)) return null;
    const path = stripGitSuffix(rawPath);
    if (!user || !host || !path) return null;
    if (host === "github.com" && /^[^/]+\/[^/]+$/.test(path)) return path;
    return `ssh://${user}@${host}/${path}`;
  }

  try {
    const url = new URL(value);
    const protocol = url.protocol.toLowerCase();
    if (!new Set(["http:", "https:", "ssh:"]).has(protocol)) return null;
    if (url.search || url.hash) return null;
    if (url.password || ((protocol === "http:" || protocol === "https:") && url.username)) {
      return null;
    }
    const path = stripGitSuffix(url.pathname.replace(/^\/+/, ""));
    if (!url.hostname || !path) return null;
    if (url.hostname.toLowerCase() === "github.com" && /^[^/]+\/[^/]+$/.test(path)) {
      return path;
    }
    url.pathname = `/${path}`;
    return url.toString().replace(/\/$/, "");
  } catch {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
      ? stripGitSuffix(value)
      : null;
  }
}

export function projectSlugFromRepository(repository: string): string {
  const normalized = normalizeRepositoryRemote(repository);
  if (!normalized) throw new Error(`Cannot derive a project slug from repository: ${repository}`);
  const candidate = stripGitSuffix(normalized.split("/").filter(Boolean).at(-1) ?? "");
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 80);
  return projectSlugSchema.parse(slug);
}

function parseContractBlock(markdown: string): unknown {
  const matches = [...markdown.matchAll(/^```stensibly[ \t]*\n([\s\S]*?)^```[ \t]*$/gm)];
  if (matches.length !== 1) {
    throw new Error(`${PROJECT_CONTRACT_FILENAME} must contain exactly one fenced \`stensibly\` JSON block`);
  }
  const raw = matches[0]?.[1]?.trim();
  if (!raw) throw new Error("The fenced stensibly contract block is empty");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The fenced stensibly contract block is not valid JSON: ${message}`);
  }
}

function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const starts = lines
    .map((line, index) => line.trim() === `## ${heading}` ? index : -1)
    .filter((index) => index >= 0);
  if (starts.length === 0) {
    throw new Error(`${PROJECT_CONTRACT_FILENAME} is missing the \"${heading}\" section`);
  }
  if (starts.length > 1) {
    throw new Error(`${PROJECT_CONTRACT_FILENAME} contains more than one \"${heading}\" section`);
  }
  const start = starts[0];
  if (start === undefined) throw new Error(`Could not locate the \"${heading}\" section`);
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^##\s+/.test(line.trim())) break;
    body.push(line);
  }
  const content = body.join("\n").trim();
  if (!content) throw new Error(`The \"${heading}\" section must not be empty`);
  return content;
}

function compareStringSets(
  changes: ProjectAttachmentChange[],
  field: string,
  beforeValues: string[],
  afterValues: string[],
  addedEffect: ProjectAttachmentChange["authorityEffect"],
  removedEffect: ProjectAttachmentChange["authorityEffect"],
): void {
  const before = new Set(beforeValues);
  const after = new Set(afterValues);
  for (const value of [...after].filter((entry) => !before.has(entry)).sort()) {
    changes.push({ field, kind: "added", before: null, after: value, authorityEffect: addedEffect });
  }
  for (const value of [...before].filter((entry) => !after.has(entry)).sort()) {
    changes.push({ field, kind: "removed", before: value, after: null, authorityEffect: removedEffect });
  }
}

function isCanonicalRepositoryIdentifier(value: string): boolean {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    const protocol = url.protocol.toLowerCase();
    if (!new Set(["http:", "https:", "ssh:"]).has(protocol)) return false;
    if (url.search || url.hash) return false;
    if (!url.hostname || !stripGitSuffix(url.pathname.replace(/^\/+/, ""))) return false;
    if (url.password) return false;
    return protocol === "ssh:" || !url.username;
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
}
