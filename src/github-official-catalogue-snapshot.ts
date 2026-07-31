import { createHash } from "node:crypto";
import {
  classifyGitHubToolCatalogueChange,
  compileGitHubToolCatalogue,
  type GitHubToolCatalogue,
  type GitHubToolCatalogueChange,
  type GitHubToolCatalogueInput,
  type GitHubToolDefinition,
} from "./github-tool-catalogue.js";
import { sha256, stableJson } from "./github-provider-validation.js";
import { githubUpstreamToolsets } from "./github-toolset-profiles.js";

const manifestMaximumBytes = 10 * 1024 * 1024;
const sourceFileMaximumBytes = 2 * 1024 * 1024;
const sourceTotalMaximumBytes = 8 * 1024 * 1024;
const maximumSourceFiles = 16;
const maximumWarnings = 32;
const repositoryName = "github/github-mcp-server" as const;
const sha1Pattern = /^[a-f0-9]{40}$/;
const pathPattern = /^[A-Za-z0-9._/-]+$/;

export type GitHubOfficialProviderMode = "local" | "remote";
export type GitHubOfficialCataloguePromotion =
  | "auto_additive"
  | "review_required"
  | "reject";

export type GitHubOfficialCatalogueDriftKind =
  | "source_revision_changed"
  | "source_files_changed"
  | "toolset_added"
  | "toolset_added_pending_review"
  | "toolset_removed"
  | "toolset_description_changed"
  | "toolset_default_changed"
  | "tool_added"
  | "tool_removed"
  | "tool_moved"
  | "tool_description_changed"
  | "tool_read_only_changed"
  | "tool_risk_changed"
  | "tool_repository_scope_changed"
  | "tool_approval_changed"
  | "schema_property_added"
  | "schema_property_removed"
  | "schema_required_added"
  | "schema_required_removed"
  | "schema_enum_added"
  | "schema_enum_removed"
  | "schema_type_changed"
  | "schema_minimum_changed"
  | "schema_maximum_changed"
  | "schema_pattern_changed"
  | "schema_additional_properties_changed"
  | "schema_value_changed";

export interface GitHubOfficialCatalogueSourceFileInput {
  path: string;
  blobSha: string;
  content: string;
}

export interface GitHubOfficialCatalogueManifestInput {
  version: 1;
  repository: typeof repositoryName;
  commitSha: string;
  providerMode: GitHubOfficialProviderMode;
  files: GitHubOfficialCatalogueSourceFileInput[];
  catalogue: GitHubToolCatalogueInput;
  warnings?: string[];
}

export interface GitHubOfficialCatalogueSourceFile {
  path: string;
  blobSha: string;
  contentSha256: string;
  byteLength: number;
}

export interface GitHubOfficialCatalogueSnapshot {
  version: 1;
  repository: typeof repositoryName;
  commitSha: string;
  providerMode: GitHubOfficialProviderMode;
  files: GitHubOfficialCatalogueSourceFile[];
  sourceFingerprint: string;
  catalogue: GitHubToolCatalogue;
  warnings: string[];
  snapshotFingerprint: string;
}

export interface GitHubOfficialCatalogueDriftEntry {
  path: string;
  kind: GitHubOfficialCatalogueDriftKind;
  promotion: GitHubOfficialCataloguePromotion;
  previous: unknown;
  next: unknown;
}

export interface GitHubOfficialCatalogueDriftReport {
  version: 1;
  previousSnapshotFingerprint: string;
  nextSnapshotFingerprint: string;
  coarse: GitHubToolCatalogueChange;
  sourceOnly: boolean;
  entries: GitHubOfficialCatalogueDriftEntry[];
  reportFingerprint: string;
}

/** Imports one exact review-authored manifest and discards copied source text. */
export function importGitHubOfficialCatalogueSnapshot(
  manifestJson: string,
): GitHubOfficialCatalogueSnapshot {
  if (typeof manifestJson !== "string") {
    throw new RangeError("GitHub official catalogue manifest must be a string");
  }
  const manifestBytes = Buffer.byteLength(manifestJson, "utf8");
  if (manifestBytes < 2 || manifestBytes > manifestMaximumBytes) {
    throw new RangeError(
      `GitHub official catalogue manifest must contain 2 to ${manifestMaximumBytes} UTF-8 bytes`,
    );
  }
  if (manifestJson.charCodeAt(0) === 0xfeff || manifestJson.includes("\0")) {
    throw new RangeError(
      "GitHub official catalogue manifest must be exact UTF-8 JSON without BOM or NUL bytes",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson) as unknown;
  } catch {
    throw new RangeError("GitHub official catalogue manifest is invalid JSON");
  }
  const input = manifestInput(parsed);
  const files = compileSourceFiles(input.files);
  const sourceRevision = officialSourceRevision(
    input.commitSha,
    input.providerMode,
  );
  if (input.catalogue.sourceRevision !== sourceRevision) {
    throw new RangeError(
      `GitHub official catalogue source revision must equal ${sourceRevision}`,
    );
  }
  const catalogue = compileGitHubToolCatalogue(input.catalogue);
  const warnings = warningList(input.warnings);
  const sourceFingerprint = sha256(stableJson({
    version: 1,
    repository: repositoryName,
    providerMode: input.providerMode,
    files,
  }));
  const canonical = {
    version: 1 as const,
    repository: repositoryName,
    commitSha: input.commitSha,
    providerMode: input.providerMode,
    files,
    sourceFingerprint,
    catalogueFingerprint: catalogue.fingerprint,
    warnings,
  };
  return deepFreeze({
    version: 1,
    repository: repositoryName,
    commitSha: input.commitSha,
    providerMode: input.providerMode,
    files,
    sourceFingerprint,
    catalogue,
    warnings,
    snapshotFingerprint: sha256(stableJson(canonical)),
  });
}

/** Imports and compares two exact manifests through compiled catalogue values. */
export function compareGitHubOfficialCatalogueManifests(
  previousManifestJson: string,
  nextManifestJson: string,
): GitHubOfficialCatalogueDriftReport {
  const previous = importGitHubOfficialCatalogueSnapshot(previousManifestJson);
  const next = importGitHubOfficialCatalogueSnapshot(nextManifestJson);
  if (previous.providerMode !== next.providerMode) {
    throw new RangeError("GitHub official catalogue provider modes do not match");
  }

  const entries: GitHubOfficialCatalogueDriftEntry[] = [];
  if (previous.commitSha !== next.commitSha) {
    addEntry(
      entries,
      "source.commitSha",
      "source_revision_changed",
      "review_required",
      previous.commitSha,
      next.commitSha,
    );
  }
  if (previous.sourceFingerprint !== next.sourceFingerprint) {
    addEntry(
      entries,
      "source.files",
      "source_files_changed",
      "review_required",
      previous.sourceFingerprint,
      next.sourceFingerprint,
    );
  }

  const reviewedToolsets = new Set(
    githubUpstreamToolsets.map((toolset) => toolset.name),
  );
  compareToolsets(entries, previous.catalogue, next.catalogue, reviewedToolsets);
  compareTools(entries, previous.catalogue, next.catalogue, reviewedToolsets);
  entries.sort((left, right) =>
    codeUnitCompare(left.path, right.path)
      || codeUnitCompare(left.kind, right.kind)
  );

  const coarse = classifyGitHubToolCatalogueChange(
    previous.catalogue,
    next.catalogue,
  );
  const sourceOnly = entries.length > 0
    && entries.every((entry) => entry.kind.startsWith("source_"));
  const canonical = {
    version: 1 as const,
    previousSnapshotFingerprint: previous.snapshotFingerprint,
    nextSnapshotFingerprint: next.snapshotFingerprint,
    coarse,
    sourceOnly,
    entries,
  };
  return deepFreeze({
    ...canonical,
    reportFingerprint: sha256(stableJson(canonical)),
  });
}

function compareToolsets(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: GitHubToolCatalogue,
  next: GitHubToolCatalogue,
  reviewedToolsets: ReadonlySet<string>,
): void {
  const before = new Map(previous.toolsets.map((value) => [value.name, value]));
  const after = new Map(next.toolsets.map((value) => [value.name, value]));
  for (const [name, prior] of before) {
    const current = after.get(name);
    if (!current) {
      addEntry(entries, `toolsets.${name}`, "toolset_removed", "reject", prior, null);
      continue;
    }
    if (prior.description !== current.description) {
      addEntry(
        entries,
        `toolsets.${name}.description`,
        "toolset_description_changed",
        "review_required",
        prior.description,
        current.description,
      );
    }
    if (prior.defaultEnabled !== current.defaultEnabled) {
      addEntry(
        entries,
        `toolsets.${name}.defaultEnabled`,
        "toolset_default_changed",
        "review_required",
        prior.defaultEnabled,
        current.defaultEnabled,
      );
    }
  }
  for (const [name, current] of after) {
    if (before.has(name)) continue;
    const pending = !reviewedToolsets.has(name);
    addEntry(
      entries,
      `toolsets.${name}`,
      pending ? "toolset_added_pending_review" : "toolset_added",
      "review_required",
      null,
      current,
    );
  }
}

function compareTools(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: GitHubToolCatalogue,
  next: GitHubToolCatalogue,
  reviewedToolsets: ReadonlySet<string>,
): void {
  const before = toolMap(previous);
  const after = toolMap(next);
  for (const [name, prior] of before) {
    const current = after.get(name);
    if (!current) {
      addEntry(entries, `tools.${name}`, "tool_removed", "reject", prior, null);
      continue;
    }
    compareTool(entries, prior, current, reviewedToolsets.has(current.toolset));
  }
  for (const [name, current] of after) {
    if (before.has(name)) continue;
    addEntry(
      entries,
      `tools.${name}`,
      "tool_added",
      reviewedToolsets.has(current.toolset)
        ? "auto_additive"
        : "review_required",
      null,
      current,
    );
  }
}

function compareTool(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: GitHubToolDefinition,
  next: GitHubToolDefinition,
  reviewedToolset: boolean,
): void {
  const path = `tools.${next.name}`;
  if (previous.toolset !== next.toolset) {
    addEntry(
      entries,
      `${path}.toolset`,
      "tool_moved",
      "review_required",
      previous.toolset,
      next.toolset,
    );
  }
  if (previous.description !== next.description) {
    addEntry(
      entries,
      `${path}.description`,
      "tool_description_changed",
      "review_required",
      previous.description,
      next.description,
    );
  }
  if (previous.readOnly !== next.readOnly) {
    addEntry(
      entries,
      `${path}.readOnly`,
      "tool_read_only_changed",
      previous.readOnly && !next.readOnly ? "reject" : "review_required",
      previous.readOnly,
      next.readOnly,
    );
  }
  if (previous.riskClass !== next.riskClass) {
    addEntry(
      entries,
      `${path}.riskClass`,
      "tool_risk_changed",
      riskRank(next.riskClass) > riskRank(previous.riskClass)
        ? "reject"
        : "review_required",
      previous.riskClass,
      next.riskClass,
    );
  }
  if (previous.repositoryScoped !== next.repositoryScoped) {
    addEntry(
      entries,
      `${path}.repositoryScoped`,
      "tool_repository_scope_changed",
      previous.repositoryScoped && !next.repositoryScoped
        ? "reject"
        : "review_required",
      previous.repositoryScoped,
      next.repositoryScoped,
    );
  }
  if (previous.requiresApproval !== next.requiresApproval) {
    addEntry(
      entries,
      `${path}.requiresApproval`,
      "tool_approval_changed",
      previous.requiresApproval && !next.requiresApproval
        ? "reject"
        : "review_required",
      previous.requiresApproval,
      next.requiresApproval,
    );
  }
  compareSchema(
    entries,
    previous.inputSchema,
    next.inputSchema,
    `${path}.inputSchema`,
    reviewedToolset,
  );
}

function compareSchema(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  reviewedToolset: boolean,
): void {
  if (jsonEqual(previous, next)) return;
  compareRequired(entries, previous.required, next.required, path);
  compareEnum(entries, previous.enum, next.enum, path);
  compareProperties(
    entries,
    plainRecord(previous.properties),
    plainRecord(next.properties),
    new Set(stringArray(next.required)),
    path,
    reviewedToolset,
  );

  for (const key of ["type", "minimum", "maximum", "pattern", "additionalProperties"] as const) {
    if (jsonEqual(previous[key], next[key])) continue;
    addEntry(
      entries,
      `${path}.${key}`,
      schemaKind(key),
      schemaPromotion(key, previous[key], next[key]),
      previous[key] ?? null,
      next[key] ?? null,
    );
  }

  const handled = new Set([
    "required",
    "enum",
    "properties",
    "type",
    "minimum",
    "maximum",
    "pattern",
    "additionalProperties",
  ]);
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (handled.has(key) || jsonEqual(previous[key], next[key])) continue;
    addEntry(
      entries,
      `${path}.${key}`,
      "schema_value_changed",
      "review_required",
      previous[key] ?? null,
      next[key] ?? null,
    );
  }
}

function compareProperties(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  nextRequired: ReadonlySet<string>,
  path: string,
  reviewedToolset: boolean,
): void {
  for (const [name, prior] of Object.entries(previous)) {
    if (!Object.hasOwn(next, name)) {
      addEntry(
        entries,
        `${path}.properties.${name}`,
        "schema_property_removed",
        "reject",
        prior,
        null,
      );
      continue;
    }
    const current = next[name];
    const priorRecord = plainRecord(prior);
    const currentRecord = plainRecord(current);
    if (Object.keys(priorRecord).length || Object.keys(currentRecord).length) {
      compareSchema(
        entries,
        priorRecord,
        currentRecord,
        `${path}.properties.${name}`,
        reviewedToolset,
      );
    } else if (!jsonEqual(prior, current)) {
      addEntry(
        entries,
        `${path}.properties.${name}`,
        "schema_value_changed",
        "review_required",
        prior,
        current ?? null,
      );
    }
  }
  for (const [name, current] of Object.entries(next)) {
    if (Object.hasOwn(previous, name)) continue;
    addEntry(
      entries,
      `${path}.properties.${name}`,
      "schema_property_added",
      reviewedToolset && !nextRequired.has(name)
        ? "auto_additive"
        : "review_required",
      null,
      current,
    );
  }
}

function compareRequired(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: unknown,
  next: unknown,
  path: string,
): void {
  const before = new Set(stringArray(previous));
  const after = new Set(stringArray(next));
  for (const name of after) {
    if (!before.has(name)) {
      addEntry(
        entries,
        `${path}.required.${name}`,
        "schema_required_added",
        "reject",
        false,
        true,
      );
    }
  }
  for (const name of before) {
    if (!after.has(name)) {
      addEntry(
        entries,
        `${path}.required.${name}`,
        "schema_required_removed",
        "auto_additive",
        true,
        false,
      );
    }
  }
}

function compareEnum(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: unknown,
  next: unknown,
  path: string,
): void {
  const before = new Map(jsonArray(previous).map((value) => [stableJson(value), value]));
  const after = new Map(jsonArray(next).map((value) => [stableJson(value), value]));
  for (const [key, value] of after) {
    if (!before.has(key)) {
      addEntry(
        entries,
        `${path}.enum.${key}`,
        "schema_enum_added",
        "auto_additive",
        null,
        value,
      );
    }
  }
  for (const [key, value] of before) {
    if (!after.has(key)) {
      addEntry(
        entries,
        `${path}.enum.${key}`,
        "schema_enum_removed",
        "reject",
        value,
        null,
      );
    }
  }
}

function schemaKind(
  key: "type" | "minimum" | "maximum" | "pattern" | "additionalProperties",
): GitHubOfficialCatalogueDriftKind {
  if (key === "type") return "schema_type_changed";
  if (key === "minimum") return "schema_minimum_changed";
  if (key === "maximum") return "schema_maximum_changed";
  if (key === "pattern") return "schema_pattern_changed";
  return "schema_additional_properties_changed";
}

function schemaPromotion(
  key: "type" | "minimum" | "maximum" | "pattern" | "additionalProperties",
  previous: unknown,
  next: unknown,
): GitHubOfficialCataloguePromotion {
  if (key === "minimum" && typeof previous === "number" && typeof next === "number") {
    return next > previous ? "reject" : "auto_additive";
  }
  if (key === "maximum" && typeof previous === "number" && typeof next === "number") {
    return next < previous ? "reject" : "auto_additive";
  }
  if (key === "additionalProperties") {
    if (previous === true && next === false) return "reject";
    if (previous === false && next === true) return "review_required";
  }
  return "reject";
}

function manifestInput(value: unknown): GitHubOfficialCatalogueManifestInput {
  const record = exactRecord(
    value,
    [
      "version",
      "repository",
      "commitSha",
      "providerMode",
      "files",
      "catalogue",
      "warnings",
    ],
    "GitHub official catalogue manifest",
  );
  if (record.version !== 1 || record.repository !== repositoryName) {
    throw new RangeError(
      "GitHub official catalogue manifest version or repository is unsupported",
    );
  }
  const commitSha = exactPatternString(
    record.commitSha,
    sha1Pattern,
    "GitHub official catalogue commit SHA",
  );
  if (record.providerMode !== "local" && record.providerMode !== "remote") {
    throw new RangeError("GitHub official catalogue provider mode is invalid");
  }
  if (!Array.isArray(record.files) || record.files.length < 1
    || record.files.length > maximumSourceFiles) {
    throw new RangeError(
      `GitHub official catalogue manifest accepts 1 to ${maximumSourceFiles} source files`,
    );
  }
  const catalogue = exactRecord(
    record.catalogue,
    ["version", "source", "sourceRevision", "toolsets"],
    "GitHub official catalogue payload",
  ) as unknown as GitHubToolCatalogueInput;
  return {
    version: 1,
    repository: repositoryName,
    commitSha,
    providerMode: record.providerMode,
    files: record.files.map((file, index) => sourceFileInput(file, index)),
    catalogue,
    ...(record.warnings === undefined
      ? {}
      : { warnings: warningList(record.warnings) }),
  };
}

function sourceFileInput(
  value: unknown,
  index: number,
): GitHubOfficialCatalogueSourceFileInput {
  const record = exactRecord(
    value,
    ["path", "blobSha", "content"],
    `GitHub official catalogue source file ${index}`,
  );
  const path = exactPatternString(
    record.path,
    pathPattern,
    "GitHub official catalogue source path",
  );
  if (path.startsWith("/") || path.endsWith("/")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new RangeError("GitHub official catalogue source path is invalid");
  }
  const blobSha = exactPatternString(
    record.blobSha,
    sha1Pattern,
    "GitHub official catalogue blob SHA",
  );
  if (typeof record.content !== "string") {
    throw new RangeError("GitHub official catalogue source content must be a string");
  }
  return { path, blobSha, content: record.content };
}

function compileSourceFiles(
  values: GitHubOfficialCatalogueSourceFileInput[],
): GitHubOfficialCatalogueSourceFile[] {
  const seen = new Set<string>();
  let totalBytes = 0;
  return values.map((value) => {
    if (seen.has(value.path)) {
      throw new RangeError(
        `Duplicate GitHub official catalogue source path: ${value.path}`,
      );
    }
    seen.add(value.path);
    const byteLength = Buffer.byteLength(value.content, "utf8");
    if (byteLength > sourceFileMaximumBytes) {
      throw new RangeError(
        `GitHub official catalogue source file exceeds ${sourceFileMaximumBytes} UTF-8 bytes`,
      );
    }
    totalBytes += byteLength;
    if (totalBytes > sourceTotalMaximumBytes) {
      throw new RangeError(
        `GitHub official catalogue sources exceed ${sourceTotalMaximumBytes} UTF-8 bytes`,
      );
    }
    if (gitBlobSha(value.content) !== value.blobSha) {
      throw new RangeError(
        `GitHub official catalogue blob SHA mismatch for ${value.path}`,
      );
    }
    return {
      path: value.path,
      blobSha: value.blobSha,
      contentSha256: sha256(value.content),
      byteLength,
    };
  }).sort((left, right) => codeUnitCompare(left.path, right.path));
}

function warningList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumWarnings) {
    throw new RangeError(
      `GitHub official catalogue accepts at most ${maximumWarnings} warnings`,
    );
  }
  const warnings = value.map((warning) => {
    if (typeof warning !== "string" || !warning.trim()
      || warning !== warning.trim()
      || /[\u0000-\u001f\u007f-\u009f]/u.test(warning)
      || [...warning].length > 500) {
      throw new RangeError("GitHub official catalogue warning is invalid");
    }
    return warning;
  });
  if (new Set(warnings).size !== warnings.length) {
    throw new RangeError("GitHub official catalogue warnings must be unique");
  }
  return warnings.sort(codeUnitCompare);
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new RangeError(`${label} contains unknown field ${key}`);
    }
  }
  return record;
}

function exactPatternString(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function officialSourceRevision(
  commitSha: string,
  providerMode: GitHubOfficialProviderMode,
): string {
  return `${repositoryName}@${commitSha}:${providerMode}`;
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes}\0`)
    .update(content, "utf8")
    .digest("hex");
}

function toolMap(catalogue: GitHubToolCatalogue): Map<string, GitHubToolDefinition> {
  return new Map(
    catalogue.toolsets.flatMap((toolset) => toolset.tools)
      .map((tool) => [tool.name, tool] as const),
  );
}

function riskRank(value: GitHubToolDefinition["riskClass"]): number {
  return value === "read" ? 0 : value === "write" ? 1 : 2;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableJson(left) === stableJson(right);
}

function addEntry(
  entries: GitHubOfficialCatalogueDriftEntry[],
  path: string,
  kind: GitHubOfficialCatalogueDriftKind,
  promotion: GitHubOfficialCataloguePromotion,
  previous: unknown,
  next: unknown,
): void {
  entries.push({ path, kind, promotion, previous, next });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value) as T;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
