import {
  compileGitHubToolCatalogue,
  type GitHubToolCatalogueInput,
  type GitHubToolDefinition,
} from "./github-tool-catalogue.js";
import {
  githubUpstreamToolsets,
  resolveGitHubToolsetProfile,
  type GitHubProviderMode,
  type GitHubToolsetAvailability,
  type GitHubToolsetProfileName,
  type ResolvedGitHubToolsetProfile,
} from "./github-toolset-profiles.js";
import {
  boundedText,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

const toolNamePattern = /^[a-z][a-z0-9_]{0,127}$/;
const maximumToolOverrides = 100;
const maximumCatalogueJsonDepth = 32;
const maximumCatalogueJsonNodes = 10_000;
const maximumCatalogueJsonBytes = 8 * 1024 * 1024;
const maximumCatalogueJsonStringBytes = 512 * 1024;
const selectionInputKeys = [
  "profile",
  "providerMode",
  "additionalTools",
  "excludedTools",
] as const;
const requiredSelectionInputKeys = ["profile", "providerMode"] as const;
const reviewedToolsetAvailability = new Map<string, GitHubToolsetAvailability>(
  githubUpstreamToolsets.map((toolset) => [toolset.name, toolset.availability]),
);

export type GitHubAdditionalToolOmissionReason =
  | "toolset_pending_review"
  | "provider_unavailable"
  | "read_only"
  | "excluded";

export interface GitHubToolsetProfileSelectionInput {
  profile: GitHubToolsetProfileName;
  providerMode: GitHubProviderMode;
  additionalTools?: string[];
  excludedTools?: string[];
}

interface AdmittedGitHubToolsetProfileSelectionInput {
  profile: GitHubToolsetProfileName;
  providerMode: GitHubProviderMode;
  additionalTools: string[];
  excludedTools: string[];
}

interface CatalogueJsonState {
  nodes: number;
  bytes: number;
}

export interface GitHubAdditionalToolOmission {
  name: string;
  reason: GitHubAdditionalToolOmissionReason;
}

export interface ResolvedGitHubToolsetProfileSelection {
  profile: ResolvedGitHubToolsetProfile;
  catalogueSourceRevision: string;
  catalogueFingerprint: string;
  selectionFingerprint: string;
  selectedToolsets: string[];
  catalogueMissingToolsets: string[];
  catalogueAddedToolsets: string[];
  additionalTools: string[];
  excludedTools: string[];
  omittedAdditionalTools: GitHubAdditionalToolOmission[];
  tools: GitHubToolDefinition[];
}

/**
 * Compiles one untrusted official GitHub MCP catalogue and applies one reviewed profile.
 *
 * Newly added tools inherit membership only inside an already reviewed toolset. Entirely
 * new toolsets remain quarantined in `catalogueAddedToolsets` until the reviewed upstream
 * inventory admits their availability and policy role. Exact tools remain additive only
 * after that toolset review, read-only filtering still applies, and exclusions take final
 * precedence, matching github/github-mcp-server selection semantics inside the accepted
 * inventory.
 */
export function resolveGitHubToolsetProfileSelection(
  catalogueInput: GitHubToolCatalogueInput,
  input: GitHubToolsetProfileSelectionInput,
): ResolvedGitHubToolsetProfileSelection {
  const catalogue = compileGitHubToolCatalogue(
    snapshotCatalogueInput(catalogueInput),
  );
  const admittedInput = admitSelectionInput(input);
  const profile = resolveGitHubToolsetProfile(
    admittedInput.profile,
    admittedInput.providerMode,
  );
  const additionalTools = admittedInput.additionalTools;
  const excludedTools = admittedInput.excludedTools;
  const excluded = new Set(excludedTools);
  const toolsets = new Map(catalogue.toolsets.map((toolset) => [toolset.name, toolset]));
  const toolsByName = new Map(
    catalogue.toolsets.flatMap((toolset) => toolset.tools)
      .map((tool) => [tool.name, tool] as const),
  );

  for (const name of additionalTools) {
    if (!toolsByName.has(name)) {
      throw new RangeError(`Unknown GitHub additional tool: ${name}`);
    }
  }

  const selectedToolsets = profile.toolsets
    .filter((name) => toolsets.has(name))
    .sort(codeUnitCompare);
  const catalogueMissingToolsets = profile.toolsets
    .filter((name) => !toolsets.has(name))
    .sort(codeUnitCompare);
  const catalogueAddedToolsets = catalogue.toolsets
    .map((toolset) => toolset.name)
    .filter((name) => !reviewedToolsetAvailability.has(name))
    .sort(codeUnitCompare);
  const selected = new Map<string, GitHubToolDefinition>();

  for (const name of selectedToolsets) {
    for (const tool of toolsets.get(name)!.tools) {
      if (excluded.has(tool.name)) continue;
      if (profile.readOnly && !tool.readOnly) continue;
      selected.set(tool.name, tool);
    }
  }

  const omittedAdditionalTools: GitHubAdditionalToolOmission[] = [];
  for (const name of additionalTools) {
    const tool = toolsByName.get(name)!;
    const reason = additionalToolOmissionReason(
      tool,
      profile.providerMode,
      profile.readOnly,
      excluded,
    );
    if (reason) {
      omittedAdditionalTools.push({ name, reason });
      continue;
    }
    selected.set(name, tool);
  }

  const tools = [...selected.values()].sort((left, right) =>
    codeUnitCompare(left.name, right.name)
  );
  const canonical = {
    profile: {
      name: profile.name,
      providerMode: profile.providerMode,
      toolsets: profile.toolsets,
      omittedToolsets: profile.omittedToolsets,
      readOnly: profile.readOnly,
      requiresOperatorApproval: profile.requiresOperatorApproval,
    },
    catalogueSourceRevision: catalogue.sourceRevision,
    catalogueFingerprint: catalogue.fingerprint,
    selectedToolsets,
    catalogueMissingToolsets,
    catalogueAddedToolsets,
    additionalTools,
    excludedTools,
    omittedAdditionalTools,
    toolNames: tools.map((tool) => tool.name),
  };

  return deepFreeze({
    profile,
    catalogueSourceRevision: catalogue.sourceRevision,
    catalogueFingerprint: catalogue.fingerprint,
    selectionFingerprint: sha256(stableJson(canonical)),
    selectedToolsets,
    catalogueMissingToolsets,
    catalogueAddedToolsets,
    additionalTools,
    excludedTools,
    omittedAdditionalTools,
    tools,
  });
}

function snapshotCatalogueInput(value: unknown): GitHubToolCatalogueInput {
  return snapshotCatalogueJson(
    value,
    "GitHub tool catalogue",
    0,
    { nodes: 0, bytes: 0 },
  ) as GitHubToolCatalogueInput;
}

function snapshotCatalogueJson(
  value: unknown,
  label: string,
  depth: number,
  state: CatalogueJsonState,
): unknown {
  state.nodes += 1;
  if (state.nodes > maximumCatalogueJsonNodes) {
    throw new RangeError(
      `GitHub tool catalogue exceeds ${maximumCatalogueJsonNodes} JSON nodes`,
    );
  }
  if (depth > maximumCatalogueJsonDepth) {
    throw new RangeError(
      `GitHub tool catalogue exceeds JSON depth ${maximumCatalogueJsonDepth}`,
    );
  }
  if (value === null) {
    reserveCatalogueJsonBytes(state, 4);
    return null;
  }
  if (typeof value === "string") {
    return snapshotCatalogueString(value, label, state);
  }
  if (typeof value === "boolean") {
    reserveCatalogueJsonBytes(state, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label} contains a non-finite number`);
    }
    const normalized = Object.is(value, -0) ? 0 : value;
    reserveCatalogueJsonBytes(
      state,
      Buffer.byteLength(JSON.stringify(normalized), "utf8"),
    );
    return normalized;
  }
  if (!value || typeof value !== "object") {
    throw new RangeError(`${label} contains a non-JSON value`);
  }
  if (Array.isArray(value)) {
    return snapshotCatalogueArray(value, label, depth, state);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must contain only plain JSON objects`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors);
  reserveCatalogueJsonBytes(state, 2 + Math.max(0, entries.length - 1));
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of entries) {
    snapshotCatalogueString(key, `${label} field name`, state);
    reserveCatalogueJsonBytes(state, 1);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(
        `${label} field must be an enumerable data property`,
      );
    }
    result[key] = snapshotCatalogueJson(
      descriptor.value,
      `${label} value`,
      depth + 1,
      state,
    );
  }
  return result;
}

function snapshotCatalogueArray(
  value: unknown[],
  label: string,
  depth: number,
  state: CatalogueJsonState,
): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError(`${label} arrays must use the default array prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} array contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !("value" in lengthDescriptor)) {
    throw new RangeError(`${label} array length is invalid`);
  }
  const length = lengthDescriptor.value;
  if (
    !Number.isSafeInteger(length)
    || length < 0
    || length > maximumCatalogueJsonNodes
  ) {
    throw new RangeError(`${label} array length is invalid`);
  }
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      throw new RangeError(`${label} array contains unknown field ${key}`);
    }
  }
  reserveCatalogueJsonBytes(state, 2 + Math.max(0, length - 1));
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) {
      throw new RangeError(`${label} array must be dense`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(
        `${label} array must contain enumerable data entries`,
      );
    }
    result.push(snapshotCatalogueJson(
      descriptor.value,
      `${label} entry`,
      depth + 1,
      state,
    ));
  }
  return result;
}

function snapshotCatalogueString(
  value: string,
  label: string,
  state: CatalogueJsonState,
): string {
  const rawBytes = Buffer.byteLength(value, "utf8");
  if (rawBytes > maximumCatalogueJsonStringBytes) {
    throw new RangeError(
      `${label} exceeds ${maximumCatalogueJsonStringBytes} UTF-8 bytes`,
    );
  }
  reserveCatalogueJsonBytes(
    state,
    Buffer.byteLength(JSON.stringify(value), "utf8"),
  );
  return value;
}

function reserveCatalogueJsonBytes(
  state: CatalogueJsonState,
  bytes: number,
): void {
  if (
    !Number.isSafeInteger(bytes)
    || bytes < 0
    || state.bytes > maximumCatalogueJsonBytes - bytes
  ) {
    throw new RangeError(
      `GitHub tool catalogue exceeds ${maximumCatalogueJsonBytes} UTF-8 bytes`,
    );
  }
  state.bytes += bytes;
}

function admitSelectionInput(
  value: unknown,
): AdmittedGitHubToolsetProfileSelectionInput {
  const record = exactSelectionRecord(value);
  return {
    profile: record.profile as GitHubToolsetProfileName,
    providerMode: record.providerMode as GitHubProviderMode,
    additionalTools: canonicalToolList(
      record.additionalTools,
      "GitHub additional tool",
    ),
    excludedTools: canonicalToolList(
      record.excludedTools,
      "GitHub excluded tool",
    ),
  };
}

function exactSelectionRecord(value: unknown): Record<string, unknown> {
  const label = "GitHub toolset profile selection";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set<string>(selectionInputKeys);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) {
      throw new RangeError(`${label} contains unknown field ${key}`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(
        `${label} field ${key} must be an enumerable data property`,
      );
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredSelectionInputKeys) {
    if (!Object.hasOwn(descriptors, key)) {
      throw new RangeError(`${label} is missing field ${key}`);
    }
  }
  return result;
}

function additionalToolOmissionReason(
  tool: GitHubToolDefinition,
  providerMode: GitHubProviderMode,
  readOnly: boolean,
  excluded: ReadonlySet<string>,
): GitHubAdditionalToolOmissionReason | null {
  if (excluded.has(tool.name)) return "excluded";
  if (!reviewedToolsetAvailability.has(tool.toolset)) {
    return "toolset_pending_review";
  }
  if (!toolsetAvailable(tool.toolset, providerMode)) return "provider_unavailable";
  if (readOnly && !tool.readOnly) return "read_only";
  return null;
}

function toolsetAvailable(name: string, providerMode: GitHubProviderMode): boolean {
  const availability = reviewedToolsetAvailability.get(name);
  if (!availability) return false;
  return providerMode === "remote" || availability === "local_and_remote";
}

function canonicalToolList(
  value: unknown,
  label: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumToolOverrides) {
    throw new RangeError(`${label} list accepts at most ${maximumToolOverrides} values`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError(`${label} list must use the default array prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} list contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw new RangeError(`${label} list contains unknown field ${key}`);
    }
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) {
      throw new RangeError(`${label} list must be dense`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(
        `${label} list must contain enumerable data entries`,
      );
    }
    const raw = descriptor.value;
    if (typeof raw !== "string") throw new RangeError(`${label} must be a string`);
    const name = boundedText(raw, label, 128);
    if (name !== raw || !toolNamePattern.test(name)) {
      throw new RangeError(`${label} name is invalid`);
    }
    result.push(name);
  }
  result.sort(codeUnitCompare);
  if (new Set(result).size !== result.length) {
    throw new RangeError(`${label} list values must be unique`);
  }
  return result;
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
