import { expect, test } from "bun:test";

function replaceExactlyOnce(
  source: string,
  before: string,
  after: string,
  label: string,
): string {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label} marker changed`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

test("emit exact hosted context repair blobs", async () => {
  let source = await Bun.file(
    "src/github-project-context-convex-ledger.ts",
  ).text();

  source = replaceExactlyOnce(
    source,
    `import { snapshotBoundedJson } from "./github-repository-observation-admission.js";\n`,
    `import { snapshotBoundedJson } from "./github-repository-observation-admission.js";\nimport { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";\n`,
    "fingerprint import",
  );
  source = replaceExactlyOnce(
    source,
    `export interface ConvexGitHubProjectContextServiceOptions {\n  client: ConvexCaller;\n  serviceSecret: string;\n  workspace?: string;\n}\n`,
    `export interface ConvexGitHubProjectContextServiceOptions {\n  client: ConvexCaller;\n  serviceSecret: string;\n  workspace?: string;\n  now?: () => Date;\n}\n`,
    "service options",
  );
  source = replaceExactlyOnce(
    source,
    `  readonly client: ConvexCaller;\n  readonly serviceSecret: string;\n  readonly workspace: string;\n\n  constructor(options: ConvexGitHubProjectContextServiceOptions) {\n`,
    `  readonly client: ConvexCaller;\n  readonly serviceSecret: string;\n  readonly workspace: string;\n  readonly #now: () => Date;\n\n  constructor(options: ConvexGitHubProjectContextServiceOptions) {\n`,
    "service clock field",
  );
  source = replaceExactlyOnce(
    source,
    `    this.workspace = exactWorkspace(options.workspace ?? "default");\n  }\n`,
    `    this.workspace = exactWorkspace(options.workspace ?? "default");\n    this.#now = options.now ?? (() => new Date());\n  }\n`,
    "service clock initialization",
  );
  source = replaceExactlyOnce(
    source,
    `      const result = admitAcceptance(raw);\n      const admitted = validateStoredRecord(result.record);\n`,
    `      const result = admitAcceptance(raw);\n      const currentTime = this.#currentTime();\n      const admitted = validateStoredRecord(\n        result.record,\n        this.workspace,\n        project,\n        currentTime,\n      );\n`,
    "acceptance record validation",
  );
  source = replaceExactlyOnce(
    source,
    `    try {\n      const rawRecords = requestedExternalId === null\n`,
    `    try {\n      const currentTime = this.#currentTime();\n      const rawRecords = requestedExternalId === null\n`,
    "read clock admission",
  );
  source = replaceExactlyOnce(
    source,
    `      const admittedCurrent = currentRecords.map(validateStoredRecord);\n`,
    `      const admittedCurrent = currentRecords.map((record) =>\n        validateStoredRecord(record, this.workspace, project, currentTime)\n      );\n`,
    "current row validation",
  );
  source = replaceExactlyOnce(
    source,
    `      for (const record of admittedCurrent) {\n        if (record.raw.project !== project) throw new GitHubProjectContextStorageError();\n      }\n`,
    `      for (const record of admittedCurrent) {\n        if (\n          record.raw.project !== project\n          || record.raw.isCurrent !== true\n          || (requestedExternalId !== null\n            && record.raw.externalId !== requestedExternalId)\n        ) throw new GitHubProjectContextStorageError();\n      }\n`,
    "current row semantics",
  );
  source = replaceExactlyOnce(
    source,
    `        })), historyLimit).map(validateStoredRecord);\n`,
    `        })), historyLimit).map((record) =>\n          validateStoredRecord(record, this.workspace, project, currentTime)\n        );\n`,
    "history row validation",
  );
  source = replaceExactlyOnce(
    source,
    `  private args(input: Record<string, unknown>): Record<string, unknown> {\n`,
    `  #currentTime(): number {\n    try {\n      const current = this.#now();\n      const milliseconds = current instanceof Date ? current.getTime() : Number.NaN;\n      if (!Number.isFinite(milliseconds)) {\n        throw new GitHubProjectContextStorageError();\n      }\n      return milliseconds;\n    } catch {\n      throw new GitHubProjectContextStorageError();\n    }\n  }\n\n  private args(input: Record<string, unknown>): Record<string, unknown> {\n`,
    "service clock method",
  );
  source = replaceExactlyOnce(
    source,
    `function validateStoredRecord(raw: StoredRecord): AdmittedRecord {\n`,
    `function validateStoredRecord(\n  raw: StoredRecord,\n  workspace: string,\n  project: string,\n  currentTime: number,\n): AdmittedRecord {\n`,
    "stored record signature",
  );
  source = replaceExactlyOnce(
    source,
    `  if (\n    canonicalGitHubIssueContextJson(snapshot) !== raw.snapshotJson\n`,
    `  if (\n    raw.project !== project\n    || raw.id !== deterministicRecordId(workspace, project, raw.observationRef)\n    || Date.parse(raw.acceptedAt)\n      > currentTime + maximumObservationFutureSkewMs\n    || canonicalGitHubIssueContextJson(snapshot) !== raw.snapshotJson\n`,
    "stored record identity and chronology",
  );
  source = replaceExactlyOnce(
    source,
    `  const issues = records.map(projectIssue);\n  return Object.freeze({\n`,
    `  const issues = records.map(projectIssue);\n  return deepFreeze({\n`,
    "projection freeze",
  );
  source = replaceExactlyOnce(
    source,
    `function exactWorkspace(value: string): string {\n`,
    `function deterministicRecordId(\n  workspace: string,\n  project: string,\n  observationRef: string,\n): string {\n  const digest = fingerprintCanonicalRequest({\n    version: 1,\n    workspace,\n    project,\n    observationRef,\n  });\n  return \`github_context_\${digest.slice("sha256:".length)}\`;\n}\n\nfunction exactWorkspace(value: string): string {\n`,
    "deterministic record identity",
  );
  source = replaceExactlyOnce(
    source,
    `function codeUnitCompare(left: string, right: string): number {\n`,
    `function deepFreeze<T>(value: T): T {\n  if (value && typeof value === "object" && !Object.isFrozen(value)) {\n    for (const child of Object.values(value as Record<string, unknown>)) {\n      deepFreeze(child);\n    }\n    Object.freeze(value);\n  }\n  return value;\n}\n\nfunction codeUnitCompare(left: string, right: string): number {\n`,
    "deep freeze helper",
  );

  let schema = await Bun.file("convex/schema.ts").text();
  schema = replaceExactlyOnce(
    schema,
    `.index("by_project_issue_accepted", ["projectId", "issueExternalId", "acceptedAt"]),\n`,
    `.index("by_project_issue_accepted", ["projectId", "issueExternalId", "acceptedAt", "externalId"]),\n`,
    "history index identity tie-breaker",
  );

  console.log("EMBER912_SOURCE_BEGIN");
  console.log(Buffer.from(source, "utf8").toString("base64"));
  console.log("EMBER912_SOURCE_END");
  console.log("EMBER912_SCHEMA_BEGIN");
  console.log(Buffer.from(schema, "utf8").toString("base64"));
  console.log("EMBER912_SCHEMA_END");
  expect("repair blobs emitted").toBe("intentional diagnostics failure");
});
