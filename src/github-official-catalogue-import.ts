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
import {
  githubUpstreamToolsets,
  type GitHubToolsetAvailability,
} from "./github-toolset-profiles.js";

const repositoryName = "github/github-mcp-server" as const;
const manifestMaximumBytes = 12 * 1024 * 1024;
const manifestMaximumDepth = 64;
const manifestMaximumNodes = 100_000;
const manifestMaximumStringBytes = 2 * 1024 * 1024;
const sourceFileMaximumBytes = 2 * 1024 * 1024;
const sourceTotalMaximumBytes = 8 * 1024 * 1024;
const maximumSourceFiles = 16;
const maximumWarnings = 32;
const commitPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const namePattern = /^[a-z][a-z0-9_]{0,127}$/;
const unsafeEvidenceTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const provenanceOnlyKinds = new Set<GitHubOfficialCatalogueDriftKind>([
  "source_revision_changed",
  "source_evidence_changed",
  "exporter_changed",
  "warnings_changed",
]);

export type GitHubOfficialCatalogueProviderMode = "local" | "remote";
export type GitHubOfficialCataloguePromotion =
  | "auto_additive"
  | "review_required"
  | "reject";

export type GitHubOfficialCatalogueDriftKind =
  | "source_identity_conflict"
  | "source_revision_changed"
  | "source_evidence_changed"
  | "exporter_changed"
  | "export_profile_changed"
  | "warnings_changed"
  | "toolset_availability_changed"
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
  | "schema_description_changed"
  | "schema_type_changed"
  | "schema_minimum_changed"
  | "schema_maximum_changed"
  | "schema_pattern_changed"
  | "schema_additional_properties_changed"
  | "schema_value_changed";

export interface GitHubOfficialCatalogueExporterInput {
  name: string;
  version: string;
  sourceSha256: string;
  commandSha256: string;
  toolchain: string;
  moduleLockSha256: string;
}

export interface GitHubOfficialCatalogueExportProfileInput {
  locale: string;
  translationMode: "default" | "translated";
  featureFlags: string[];
  selectedToolsets: string[];
  additionalTools: string[];
  readOnly: boolean;
  excludedTools: string[];
}

export interface GitHubOfficialCatalogueSourceFileInput {
  path: string;
  blobSha: string;
  content: string;
}

export interface GitHubOfficialCatalogueAvailabilityInput {
  name: string;
  availability: GitHubToolsetAvailability;
}

export interface GitHubOfficialCatalogueManifestInput {
  version: 1;
  sourceKind: "source_catalogue_candidate";
  repository: typeof repositoryName;
  commitSha: string;
  providerMode: GitHubOfficialCatalogueProviderMode;
  exporter: GitHubOfficialCatalogueExporterInput;
  profile: GitHubOfficialCatalogueExportProfileInput;
  files: GitHubOfficialCatalogueSourceFileInput[];
  availability: GitHubOfficialCatalogueAvailabilityInput[];
  catalogue: GitHubToolCatalogueInput;
  warnings?: string[];
}

export interface GitHubOfficialCatalogueExporter {
  name: string;
  version: string;
  sourceSha256: string;
  commandSha256: string;
  toolchain: string;
  moduleLockSha256: string;
}

export interface GitHubOfficialCatalogueExportProfile {
  locale: string;
  translationMode: "default" | "translated";
  featureFlags: string[];
  selectedToolsets: string[];
  additionalTools: string[];
  readOnly: boolean;
  excludedTools: string[];
  fingerprint: string;
}

export interface GitHubOfficialCatalogueSourceFile {
  path: string;
  blobSha: string;
  contentSha256: string;
  byteLength: number;
}

export interface GitHubOfficialCatalogueAvailability {
  name: string;
  availability: GitHubToolsetAvailability;
}

export interface GitHubOfficialCatalogueSnapshot {
  version: 1;
  sourceKind: "source_catalogue_candidate";
  repository: typeof repositoryName;
  commitSha: string;
  providerMode: GitHubOfficialCatalogueProviderMode;
  exporter: GitHubOfficialCatalogueExporter;
  profile: GitHubOfficialCatalogueExportProfile;
  files: GitHubOfficialCatalogueSourceFile[];
  availability: GitHubOfficialCatalogueAvailability[];
  sourceFingerprint: string;
  catalogue: GitHubToolCatalogue;
  effectiveCatalogueFingerprint: string;
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

export function githubOfficialCatalogueSourceRevision(
  commitShaInput: string,
  providerModeInput: GitHubOfficialCatalogueProviderMode,
): string {
  return `github-mcp-server:${commitShaValue(commitShaInput)}:${providerModeValue(providerModeInput)}`;
}

/**
 * Imports one canonical artifact emitted by a separately reviewed pinned-source exporter.
 * This function executes no upstream code and retains no copied upstream source text.
 */
export function importGitHubOfficialCatalogueManifest(
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
  assertManifestNesting(manifestJson);

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson) as unknown;
  } catch {
    throw new RangeError("GitHub official catalogue manifest is invalid JSON");
  }
  assertManifestValueBudget(parsed);
  if (JSON.stringify(parsed) !== manifestJson) {
    throw new RangeError(
      "GitHub official catalogue manifest must use canonical compact JSON encoding",
    );
  }

  const manifest = exactRecord(
    parsed,
    [
      "version",
      "sourceKind",
      "repository",
      "commitSha",
      "providerMode",
      "exporter",
      "profile",
      "files",
      "availability",
      "catalogue",
      "warnings",
    ],
    [
      "version",
      "sourceKind",
      "repository",
      "commitSha",
      "providerMode",
      "exporter",
      "profile",
      "files",
      "availability",
      "catalogue",
    ],
    "GitHub official catalogue manifest",
  );
  if (manifest.version !== 1) {
    throw new RangeError("GitHub official catalogue manifest version is unsupported");
  }
  if (manifest.sourceKind !== "source_catalogue_candidate") {
    throw new RangeError("GitHub official catalogue source kind is unsupported");
  }
  if (manifest.repository !== repositoryName) {
    throw new RangeError(`GitHub official catalogue repository must equal ${repositoryName}`);
  }

  const commitSha = commitShaValue(manifest.commitSha);
  const providerMode = providerModeValue(manifest.providerMode);
  const exporter = exporterInput(manifest.exporter);
  const profile = exportProfileInput(manifest.profile);
  const files = sourceFilesInput(manifest.files);
  const catalogue = compileGitHubToolCatalogue(
    manifest.catalogue as GitHubToolCatalogueInput,
  );
  const expectedSourceRevision = githubOfficialCatalogueSourceRevision(
    commitSha,
    providerMode,
  );
  if (catalogue.sourceRevision !== expectedSourceRevision) {
    throw new RangeError(
      `GitHub official catalogue source revision must equal ${expectedSourceRevision}`,
    );
  }
  const catalogueToolsets = catalogue.toolsets.map((toolset) => toolset.name);
  const availability = availabilityInput(manifest.availability, catalogueToolsets);
  validateExportProfile(profile, providerMode, catalogue, availability);
  const warnings = boundedStringList(
    Object.hasOwn(manifest, "warnings") ? manifest.warnings : [],
    "GitHub official catalogue warning",
    maximumWarnings,
    800,
    false,
  );
  const effectiveCatalogueFingerprint = effectiveFingerprint(catalogue);
  const sourceIdentity = {
    version: 1 as const,
    sourceKind: "source_catalogue_candidate" as const,
    repository: repositoryName,
    commitSha,
    providerMode,
    exporter,
    profile,
    files,
    availability,
  };
  const sourceFingerprint = sha256(stableJson(sourceIdentity));
  const canonical = {
    ...sourceIdentity,
    sourceFingerprint,
    catalogueFingerprint: catalogue.fingerprint,
    effectiveCatalogueFingerprint,
    warnings,
  };
  return deepFreeze({
    version: 1,
    sourceKind: "source_catalogue_candidate",
    repository: repositoryName,
    commitSha,
    providerMode,
    exporter,
    profile,
    files,
    availability,
    sourceFingerprint,
    catalogue,
    effectiveCatalogueFingerprint,
    warnings,
    snapshotFingerprint: sha256(stableJson(canonical)),
  });
}

export function compareGitHubOfficialCatalogueManifests(
  previousManifestJson: string,
  nextManifestJson: string,
): GitHubOfficialCatalogueDriftReport {
  return compareGitHubOfficialCatalogueSnapshots(
    importGitHubOfficialCatalogueManifest(previousManifestJson),
    importGitHubOfficialCatalogueManifest(nextManifestJson),
  );
}

function compareGitHubOfficialCatalogueSnapshots(
  previous: GitHubOfficialCatalogueSnapshot,
  next: GitHubOfficialCatalogueSnapshot,
): GitHubOfficialCatalogueDriftReport {
  if (previous.repository !== next.repository) {
    throw new RangeError("GitHub official catalogue repositories do not match");
  }
  if (previous.providerMode !== next.providerMode) {
    throw new RangeError("GitHub official catalogue provider modes do not match");
  }

  const entries: GitHubOfficialCatalogueDriftEntry[] = [];
  const sameSource = previous.sourceFingerprint === next.sourceFingerprint;
  const sameEffectiveCatalogue = previous.effectiveCatalogueFingerprint
    === next.effectiveCatalogueFingerprint;
  if (sameSource && !sameEffectiveCatalogue) {
    addEntry(
      entries,
      "source.identity",
      "source_identity_conflict",
      "reject",
      previous.effectiveCatalogueFingerprint,
      next.effectiveCatalogueFingerprint,
    );
  }
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
  if (!sameSource) {
    addEntry(
      entries,
      "source.fingerprint",
      "source_evidence_changed",
      "review_required",
      previous.sourceFingerprint,
      next.sourceFingerprint,
    );
  }
  if (!jsonEqual(previous.exporter, next.exporter)) {
    addEntry(
      entries,
      "source.exporter",
      "exporter_changed",
      "review_required",
      previous.exporter,
      next.exporter,
    );
  }
  if (!jsonEqual(previous.profile, next.profile)) {
    addEntry(
      entries,
      "source.profile",
      "export_profile_changed",
      "review_required",
      previous.profile,
      next.profile,
    );
  }
  if (!jsonEqual(previous.warnings, next.warnings)) {
    addEntry(
      entries,
      "source.warnings",
      "warnings_changed",
      "review_required",
      previous.warnings,
      next.warnings,
    );
  }

  compareAvailability(entries, previous.availability, next.availability);
  compareCatalogues(entries, previous.catalogue, next.catalogue);
  entries.sort((left, right) =>
    codeUnitCompare(left.path, right.path)
      || codeUnitCompare(left.kind, right.kind)
  );

  const coarse = classifyGitHubToolCatalogueChange(
    previous.catalogue,
    next.catalogue,
  );
  const sameAvailability = jsonEqual(previous.availability, next.availability);
  const sourceOnly = entries.length > 0
    && sameEffectiveCatalogue
    && sameAvailability
    && entries.every((entry) => provenanceOnlyKinds.has(entry.kind));
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

function validateExportProfile(
  profile: GitHubOfficialCatalogueExportProfile,
  providerMode: GitHubOfficialCatalogueProviderMode,
  catalogue: GitHubToolCatalogue,
  availability: GitHubOfficialCatalogueAvailability[],
): void {
  const catalogueToolsets = new Set(
    catalogue.toolsets.map((toolset) => toolset.name),
  );
  for (const selected of profile.selectedToolsets) {
    if (!catalogueToolsets.has(selected)) {
      throw new RangeError(
        `GitHub official catalogue selected toolset ${selected} is absent from the effective catalogue`,
      );
    }
  }
  const selectedToolsets = new Set(profile.selectedToolsets);
  const additionalTools = new Set(profile.additionalTools);
  const tools = catalogue.toolsets.flatMap((toolset) => toolset.tools);
  for (const tool of tools) {
    if (
      !selectedToolsets.has(tool.toolset)
      && !additionalTools.has(tool.name)
    ) {
      throw new RangeError(
        `GitHub official effective tool ${tool.name} is outside selected toolsets and additional tools`,
      );
    }
  }
  const toolNames = new Set(tools.map((tool) => tool.name));
  if (profile.excludedTools.some((name) => toolNames.has(name))) {
    throw new RangeError(
      "GitHub official catalogue excluded tools must be absent from the effective catalogue",
    );
  }
  if (profile.readOnly && tools.some((tool) => !tool.readOnly)) {
    throw new RangeError(
      "GitHub official catalogue read-only export contains a write-capable tool",
    );
  }
  if (
    providerMode === "local"
    && availability.some((entry) => entry.availability === "remote_only")
  ) {
    throw new RangeError(
      "GitHub official local catalogue contains a remote-only toolset",
    );
  }
}

function compareAvailability(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: GitHubOfficialCatalogueAvailability[],
  next: GitHubOfficialCatalogueAvailability[],
): void {
  const prior = new Map(previous.map((entry) => [entry.name, entry.availability]));
  const current = new Map(next.map((entry) => [entry.name, entry.availability]));
  const names = new Set([...prior.keys(), ...current.keys()]);
  for (const name of names) {
    if (prior.get(name) === current.get(name)) continue;
    addEntry(
      entries,
      `toolsets.${name}.availability`,
      "toolset_availability_changed",
      "review_required",
      prior.get(name) ?? null,
      current.get(name) ?? null,
    );
  }
}

function compareCatalogues(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: GitHubToolCatalogue,
  next: GitHubToolCatalogue,
): void {
  const reviewedToolsets = new Set<string>(
    githubUpstreamToolsets.map((toolset) => toolset.name),
  );
  const previousToolsets = new Map(
    previous.toolsets.map((toolset) => [toolset.name, toolset]),
  );
  const nextToolsets = new Map(
    next.toolsets.map((toolset) => [toolset.name, toolset]),
  );

  for (const [name, prior] of previousToolsets) {
    const current = nextToolsets.get(name);
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

  for (const [name, current] of nextToolsets) {
    if (previousToolsets.has(name)) continue;
    addEntry(
      entries,
      `toolsets.${name}`,
      reviewedToolsets.has(name)
        ? "toolset_added"
        : "toolset_added_pending_review",
      "review_required",
      null,
      current,
    );
  }

  const previousTools = toolMap(previous);
  const nextTools = toolMap(next);
  for (const [name, prior] of previousTools) {
    const current = nextTools.get(name);
    if (!current) {
      addEntry(entries, `tools.${name}`, "tool_removed", "reject", prior, null);
      continue;
    }
    compareTool(
      entries,
      prior,
      current,
      reviewedToolsets.has(current.toolset),
    );
  }
  for (const [name, current] of nextTools) {
    if (previousTools.has(name)) continue;
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
  previous: unknown,
  next: unknown,
  path: string,
  reviewedToolset: boolean,
): void {
  if (jsonEqual(previous, next)) return;
  const prior = jsonRecord(previous);
  const current = jsonRecord(next);
  if (!prior || !current) {
    addEntry(
      entries,
      path,
      "schema_value_changed",
      "review_required",
      valueOrNull(previous),
      valueOrNull(next),
    );
    return;
  }

  const previousRequired = new Set(stringValues(prior.required));
  const nextRequired = new Set(stringValues(current.required));
  for (const name of nextRequired) {
    if (previousRequired.has(name)) continue;
    addEntry(
      entries,
      `${path}.required.${name}`,
      "schema_required_added",
      "reject",
      false,
      true,
    );
  }
  for (const name of previousRequired) {
    if (nextRequired.has(name)) continue;
    addEntry(
      entries,
      `${path}.required.${name}`,
      "schema_required_removed",
      "review_required",
      true,
      false,
    );
  }

  compareEnum(entries, prior.enum, current.enum, path);
  compareProperties(
    entries,
    jsonRecord(prior.properties) ?? {},
    jsonRecord(current.properties) ?? {},
    nextRequired,
    path,
    reviewedToolset,
  );

  if (!jsonEqual(prior.description, current.description)) {
    addEntry(
      entries,
      `${path}.description`,
      "schema_description_changed",
      "review_required",
      valueOrNull(prior.description),
      valueOrNull(current.description),
    );
  }

  for (const key of [
    "type",
    "minimum",
    "maximum",
    "pattern",
    "additionalProperties",
  ] as const) {
    if (jsonEqual(prior[key], current[key])) continue;
    addEntry(
      entries,
      `${path}.${key}`,
      schemaKind(key),
      schemaPromotion(key, prior[key], current[key]),
      valueOrNull(prior[key]),
      valueOrNull(current[key]),
    );
  }

  const handled = new Set([
    "required",
    "enum",
    "properties",
    "description",
    "type",
    "minimum",
    "maximum",
    "pattern",
    "additionalProperties",
  ]);
  const keys = new Set([...Object.keys(prior), ...Object.keys(current)]);
  for (const key of keys) {
    if (handled.has(key) || jsonEqual(prior[key], current[key])) continue;
    addEntry(
      entries,
      `${path}.${key}`,
      "schema_value_changed",
      "review_required",
      valueOrNull(prior[key]),
      valueOrNull(current[key]),
    );
  }
}

function compareProperties(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  nextRequired: Set<string>,
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
    compareSchema(
      entries,
      prior,
      next[name],
      `${path}.properties.${name}`,
      reviewedToolset,
    );
  }
  for (const [name, current] of Object.entries(next)) {
    if (Object.hasOwn(previous, name)) continue;
    addEntry(
      entries,
      `${path}.properties.${name}`,
      "schema_property_added",
      nextRequired.has(name)
        ? "reject"
        : reviewedToolset
        ? "auto_additive"
        : "review_required",
      null,
      current,
    );
  }
}

function compareEnum(
  entries: GitHubOfficialCatalogueDriftEntry[],
  previous: unknown,
  next: unknown,
  path: string,
): void {
  const prior = jsonArray(previous);
  const current = jsonArray(next);
  if (!prior && !current) return;
  if (!prior || !current) {
    addEntry(
      entries,
      `${path}.enum`,
      "schema_value_changed",
      "review_required",
      valueOrNull(previous),
      valueOrNull(next),
    );
    return;
  }
  const priorMap = new Map(prior.map((value) => [stableJson(value), value]));
  const currentMap = new Map(current.map((value) => [stableJson(value), value]));
  for (const [identity, value] of currentMap) {
    if (priorMap.has(identity)) continue;
    addEntry(
      entries,
      `${path}.enum.${sha256(identity)}`,
      "schema_enum_added",
      "review_required",
      null,
      value,
    );
  }
  for (const [identity, value] of priorMap) {
    if (currentMap.has(identity)) continue;
    addEntry(
      entries,
      `${path}.enum.${sha256(identity)}`,
      "schema_enum_removed",
      "reject",
      value,
      null,
    );
  }
}

function exporterInput(value: unknown): GitHubOfficialCatalogueExporter {
  const record = exactRecord(
    value,
    [
      "name",
      "version",
      "sourceSha256",
      "commandSha256",
      "toolchain",
      "moduleLockSha256",
    ],
    [
      "name",
      "version",
      "sourceSha256",
      "commandSha256",
      "toolchain",
      "moduleLockSha256",
    ],
    "GitHub official catalogue exporter",
  );
  return deepFreeze({
    name: exactAscii(record.name, "GitHub official catalogue exporter name", 120),
    version: exactAscii(record.version, "GitHub official catalogue exporter version", 80),
    sourceSha256: fingerprintValue(record.sourceSha256, "Exporter source fingerprint"),
    commandSha256: fingerprintValue(record.commandSha256, "Exporter command fingerprint"),
    toolchain: exactAscii(record.toolchain, "GitHub official catalogue exporter toolchain", 160),
    moduleLockSha256: fingerprintValue(
      record.moduleLockSha256,
      "Exporter module-lock fingerprint",
    ),
  });
}

function exportProfileInput(value: unknown): GitHubOfficialCatalogueExportProfile {
  const record = exactRecord(
    value,
    [
      "locale",
      "translationMode",
      "featureFlags",
      "selectedToolsets",
      "additionalTools",
      "readOnly",
      "excludedTools",
    ],
    [
      "locale",
      "translationMode",
      "featureFlags",
      "selectedToolsets",
      "additionalTools",
      "readOnly",
      "excludedTools",
    ],
    "GitHub official catalogue export profile",
  );
  let translationMode: GitHubOfficialCatalogueExportProfile["translationMode"];
  if (record.translationMode === "default") {
    translationMode = "default";
  } else if (record.translationMode === "translated") {
    translationMode = "translated";
  } else {
    throw new RangeError("GitHub official catalogue translation mode is invalid");
  }
  if (typeof record.readOnly !== "boolean") {
    throw new RangeError("GitHub official catalogue read-only profile flag must be boolean");
  }
  const canonical = {
    locale: exactAscii(record.locale, "GitHub official catalogue locale", 40),
    translationMode,
    featureFlags: boundedStringList(
      record.featureFlags,
      "GitHub official catalogue feature flag",
      64,
      120,
      true,
    ),
    selectedToolsets: boundedStringList(
      record.selectedToolsets,
      "GitHub official catalogue selected toolset",
      40,
      128,
      true,
    ),
    additionalTools: boundedStringList(
      record.additionalTools,
      "GitHub official catalogue additional tool",
      500,
      128,
      true,
    ),
    readOnly: record.readOnly,
    excludedTools: boundedStringList(
      record.excludedTools,
      "GitHub official catalogue excluded tool",
      500,
      128,
      true,
    ),
  };
  return deepFreeze({
    ...canonical,
    fingerprint: sha256(stableJson(canonical)),
  });
}

function sourceFilesInput(value: unknown): GitHubOfficialCatalogueSourceFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumSourceFiles) {
    throw new RangeError(
      `GitHub official catalogue requires 1 to ${maximumSourceFiles} source files`,
    );
  }
  const files: GitHubOfficialCatalogueSourceFile[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value) {
    const record = exactRecord(
      candidate,
      ["path", "blobSha", "content"],
      ["path", "blobSha", "content"],
      "GitHub official catalogue source file",
    );
    const path = sourcePath(record.path);
    if (paths.has(path)) {
      throw new RangeError(`Duplicate GitHub official catalogue source path: ${path}`);
    }
    paths.add(path);
    const blobSha = commitShaValue(record.blobSha);
    if (typeof record.content !== "string") {
      throw new RangeError(`GitHub official catalogue source ${path} must be text`);
    }
    const bytes = Buffer.from(record.content, "utf8");
    if (bytes.byteLength > sourceFileMaximumBytes) {
      throw new RangeError(
        `GitHub official catalogue source ${path} exceeds ${sourceFileMaximumBytes} UTF-8 bytes`,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > sourceTotalMaximumBytes) {
      throw new RangeError(
        `GitHub official catalogue source files exceed ${sourceTotalMaximumBytes} UTF-8 bytes`,
      );
    }
    if (gitBlobSha(bytes) !== blobSha) {
      throw new RangeError(`GitHub official catalogue source ${path} blob SHA does not match`);
    }
    files.push({
      path,
      blobSha,
      contentSha256: sha256(record.content),
      byteLength: bytes.byteLength,
    });
  }
  return deepFreeze(files.sort((left, right) => codeUnitCompare(left.path, right.path)));
}

function availabilityInput(
  value: unknown,
  catalogueToolsets: string[],
): GitHubOfficialCatalogueAvailability[] {
  if (!Array.isArray(value) || value.length > 40) {
    throw new RangeError("GitHub official catalogue availability accepts at most 40 toolsets");
  }
  const entries: GitHubOfficialCatalogueAvailability[] = [];
  const names = new Set<string>();
  for (const candidate of value) {
    const record = exactRecord(
      candidate,
      ["name", "availability"],
      ["name", "availability"],
      "GitHub official catalogue availability",
    );
    const name = canonicalName(record.name, "GitHub official catalogue toolset name");
    if (names.has(name)) {
      throw new RangeError(`Duplicate GitHub official catalogue availability: ${name}`);
    }
    names.add(name);
    const rawAvailability = record.availability;
    let availability: GitHubToolsetAvailability;
    if (rawAvailability === "local_and_remote") {
      availability = "local_and_remote";
    } else if (rawAvailability === "remote_only") {
      availability = "remote_only";
    } else {
      throw new RangeError(`GitHub official catalogue availability for ${name} is invalid`);
    }
    entries.push({ name, availability });
  }
  const expected = [...catalogueToolsets].sort(codeUnitCompare);
  const actual = [...names].sort(codeUnitCompare);
  if (!jsonEqual(expected, actual)) {
    throw new RangeError(
      "GitHub official catalogue availability must cover every catalogue toolset exactly",
    );
  }
  return deepFreeze(entries.sort((left, right) => codeUnitCompare(left.name, right.name)));
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const accepted = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!accepted.has(key)) {
      throw new RangeError(`${label} has unknown field ${safeFieldIdentity(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new RangeError(`${label} is missing field ${key}`);
    }
  }
  return record;
}

function boundedStringList(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumLength: number,
  canonicalNames: boolean,
): string[] {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new RangeError(`${label} list accepts at most ${maximumEntries} entries`);
  }
  const result = value.map((entry) => canonicalNames
    ? canonicalName(entry, label)
    : exactEvidenceText(entry, label, maximumLength));
  if (new Set(result).size !== result.length) {
    throw new RangeError(`${label} list must be unique`);
  }
  return result.sort(codeUnitCompare);
}

function sourcePath(value: unknown): string {
  const path = exactAscii(value, "GitHub official catalogue source path", 512);
  if (
    path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\\")
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || !/^[A-Za-z0-9._/-]+$/.test(path)
  ) {
    throw new RangeError("GitHub official catalogue source path is invalid");
  }
  return path;
}

function commitShaValue(value: unknown): string {
  if (typeof value !== "string" || !commitPattern.test(value)) {
    throw new RangeError(
      "GitHub official catalogue commit/blob SHA must be 40 lowercase hex characters",
    );
  }
  return value;
}

function providerModeValue(value: unknown): GitHubOfficialCatalogueProviderMode {
  if (value !== "local" && value !== "remote") {
    throw new RangeError("GitHub official catalogue provider mode is invalid");
  }
  return value;
}

function fingerprintValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new RangeError(`${label} must be a SHA-256 fingerprint`);
  }
  return value;
}

function exactAscii(value: unknown, label: string, maximum: number): string {
  const text = exactText(value, label, maximum);
  if (!/^[\x20-\x7e]+$/.test(text)) {
    throw new RangeError(`${label} must use exact printable ASCII`);
  }
  return text;
}

function exactEvidenceText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const text = exactText(value, label, maximum);
  if (unsafeEvidenceTextPattern.test(text)) {
    throw new RangeError(`${label} contains unsafe characters`);
  }
  return text;
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new RangeError(`${label} must contain 1 to ${maximum} characters`);
  }
  if (value !== value.trim()) {
    throw new RangeError(`${label} must not contain surrounding whitespace`);
  }
  return value;
}

function canonicalName(value: unknown, label: string): string {
  if (typeof value !== "string" || !namePattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function safeFieldIdentity(value: string): string {
  return /^[A-Za-z0-9._/-]{1,128}$/.test(value)
    ? value
    : sha256(value).slice(0, 23);
}

function assertManifestNesting(json: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const character = json[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > manifestMaximumDepth) {
        throw new RangeError(
          `GitHub official catalogue manifest exceeds JSON depth ${manifestMaximumDepth}`,
        );
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
}

function assertManifestValueBudget(value: unknown): void {
  let nodes = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > manifestMaximumNodes) {
      throw new RangeError(
        `GitHub official catalogue manifest exceeds ${manifestMaximumNodes} JSON nodes`,
      );
    }
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > manifestMaximumStringBytes) {
        throw new RangeError(
          `GitHub official catalogue manifest string exceeds ${manifestMaximumStringBytes} UTF-8 bytes`,
        );
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (const nested of current) pending.push(nested);
      continue;
    }
    if (current && typeof current === "object") {
      for (const [key, nested] of Object.entries(
        current as Record<string, unknown>,
      )) {
        if (Buffer.byteLength(key, "utf8") > manifestMaximumStringBytes) {
          throw new RangeError(
            `GitHub official catalogue manifest key exceeds ${manifestMaximumStringBytes} UTF-8 bytes`,
          );
        }
        pending.push(nested);
      }
    }
  }
}

function gitBlobSha(content: Uint8Array): string {
  const prefix = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return createHash("sha1").update(prefix).update(content).digest("hex");
}

function effectiveFingerprint(catalogue: GitHubToolCatalogue): string {
  return sha256(stableJson({
    version: catalogue.version,
    source: catalogue.source,
    toolsets: catalogue.toolsets,
    toolCount: catalogue.toolCount,
  }));
}

function toolMap(catalogue: GitHubToolCatalogue): Map<string, GitHubToolDefinition> {
  return new Map(
    catalogue.toolsets.flatMap((toolset) => toolset.tools)
      .map((tool) => [tool.name, tool] as const),
  );
}

function schemaKind(
  key: "type" | "minimum" | "maximum" | "pattern" | "additionalProperties",
): GitHubOfficialCatalogueDriftKind {
  switch (key) {
    case "type": return "schema_type_changed";
    case "minimum": return "schema_minimum_changed";
    case "maximum": return "schema_maximum_changed";
    case "pattern": return "schema_pattern_changed";
    case "additionalProperties": return "schema_additional_properties_changed";
  }
}

function schemaPromotion(
  key: "type" | "minimum" | "maximum" | "pattern" | "additionalProperties",
  previous: unknown,
  next: unknown,
): GitHubOfficialCataloguePromotion {
  if (key === "type" || key === "pattern") return "reject";
  if (key === "minimum") {
    return typeof previous === "number" && typeof next === "number" && next > previous
      ? "reject"
      : "review_required";
  }
  if (key === "maximum") {
    return typeof previous === "number" && typeof next === "number" && next < previous
      ? "reject"
      : "review_required";
  }
  return previous === true && next === false ? "reject" : "review_required";
}

function riskRank(value: GitHubToolDefinition["riskClass"]): number {
  return value === "read" ? 0 : value === "write" ? 1 : 2;
}

function addEntry(
  entries: GitHubOfficialCatalogueDriftEntry[],
  path: string,
  kind: GitHubOfficialCatalogueDriftKind,
  promotion: GitHubOfficialCataloguePromotion,
  previous: unknown,
  next: unknown,
): void {
  entries.push(deepFreeze({ path, kind, promotion, previous, next }));
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableJson(left) === stableJson(right);
}

function valueOrNull(value: unknown): unknown {
  return value === undefined ? null : value;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  const nestedValues = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const nested of nestedValues) deepFreeze(nested);
  return value;
}
