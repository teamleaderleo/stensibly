import { createHash } from "node:crypto";

export const MCP_RELEASE_MANIFEST_SCHEMA_VERSION = 1;

const lowerBoundKeywords = [
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
] as const;
const upperBoundKeywords = [
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
] as const;
type NumericBoundDirection = "lower" | "upper";

export interface McpToolContract {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
}

export interface CanonicalMcpToolContract {
  name: string;
  description: string;
  annotations: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
}

export interface McpReleaseManifest {
  schemaVersion: typeof MCP_RELEASE_MANIFEST_SCHEMA_VERSION;
  digest: string;
  tools: CanonicalMcpToolContract[];
}

export type McpReleaseClassification =
  | "implementation-only"
  | "compatible-contract-change"
  | "new-actions"
  | "breaking-contract-change";

export type ChatGptRefreshAction =
  | "none"
  | "refresh-actions"
  | "refresh-and-approve-actions"
  | "preserve-compatibility-or-recreate";

export interface McpToolContractChange {
  name: string;
  kind: "added" | "removed" | "compatible" | "breaking";
  reasons: string[];
}

export interface McpReleaseDiff {
  classification: McpReleaseClassification;
  previousDigest: string;
  candidateDigest: string;
  refreshRequired: boolean;
  chatGptAction: ChatGptRefreshAction;
  changes: McpToolContractChange[];
}

export function createMcpReleaseManifest(
  tools: readonly McpToolContract[],
): McpReleaseManifest {
  const names = new Set<string>();
  const canonicalTools = tools.map((tool) => {
    const name = normalizeToolName(tool.name);
    if (names.has(name)) throw new Error(`Duplicate MCP tool name: ${name}`);
    names.add(name);
    if (!isRecord(tool.inputSchema)) {
      throw new Error(`MCP tool ${name} has no object input schema`);
    }
    return {
      name,
      description: normalizeDescription(tool.description),
      annotations: canonicalRecord(tool.annotations ?? {}),
      inputSchema: canonicalSchema(tool.inputSchema),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));

  const body: Omit<McpReleaseManifest, "digest"> = {
    schemaVersion: MCP_RELEASE_MANIFEST_SCHEMA_VERSION,
    tools: canonicalTools,
  };
  return {
    ...body,
    digest: `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`,
  };
}

export function diffMcpReleaseManifests(
  previous: McpReleaseManifest,
  candidate: McpReleaseManifest,
): McpReleaseDiff {
  const previousTools = new Map(previous.tools.map((tool) => [tool.name, tool]));
  const candidateTools = new Map(candidate.tools.map((tool) => [tool.name, tool]));
  const changes: McpToolContractChange[] = [];

  for (const name of [...previousTools.keys()].sort()) {
    if (!candidateTools.has(name)) {
      changes.push({
        name,
        kind: "removed",
        reasons: ["tool was removed or renamed"],
      });
    }
  }

  for (const name of [...candidateTools.keys()].sort()) {
    const next = candidateTools.get(name)!;
    const prior = previousTools.get(name);
    if (!prior) {
      changes.push({
        name,
        kind: "added",
        reasons: ["tool was added"],
      });
      continue;
    }
    if (canonicalJson(prior) === canonicalJson(next)) continue;

    const reasons: string[] = [];
    let breaking = false;
    if (prior.description !== next.description) reasons.push("description changed");
    if (canonicalJson(prior.annotations) !== canonicalJson(next.annotations)) {
      reasons.push("annotations changed");
    }
    if (canonicalJson(prior.inputSchema) !== canonicalJson(next.inputSchema)) {
      const compatibility = compareInputSchemas(prior.inputSchema, next.inputSchema);
      reasons.push(...compatibility.reasons);
      breaking ||= !compatibility.compatible;
    }
    changes.push({
      name,
      kind: breaking ? "breaking" : "compatible",
      reasons: unique(reasons.length ? reasons : ["tool contract changed"]),
    });
  }

  changes.sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
  const classification = classifyChanges(changes);
  return {
    classification,
    previousDigest: previous.digest,
    candidateDigest: candidate.digest,
    refreshRequired: classification !== "implementation-only",
    chatGptAction: chatGptAction(classification),
    changes,
  };
}

function classifyChanges(changes: readonly McpToolContractChange[]): McpReleaseClassification {
  if (changes.some((change) => change.kind === "removed" || change.kind === "breaking")) {
    return "breaking-contract-change";
  }
  if (changes.some((change) => change.kind === "added")) return "new-actions";
  if (changes.length) return "compatible-contract-change";
  return "implementation-only";
}

function chatGptAction(classification: McpReleaseClassification): ChatGptRefreshAction {
  switch (classification) {
    case "implementation-only": return "none";
    case "compatible-contract-change": return "refresh-actions";
    case "new-actions": return "refresh-and-approve-actions";
    case "breaking-contract-change": return "preserve-compatibility-or-recreate";
  }
}

function compareInputSchemas(
  previous: Record<string, unknown>,
  candidate: Record<string, unknown>,
): { compatible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const compatible = schemaAcceptsPreviousInputs(previous, candidate, "$", reasons);
  if (compatible && !reasons.length) reasons.push("input schema changed compatibly");
  return { compatible, reasons: unique(reasons) };
}

function schemaAcceptsPreviousInputs(
  previous: Record<string, unknown>,
  candidate: Record<string, unknown>,
  path: string,
  reasons: string[],
): boolean {
  if (canonicalJson(previous) === canonicalJson(candidate)) return true;
  let compatible = true;

  const previousTypes = schemaTypes(previous.type);
  const candidateTypes = schemaTypes(candidate.type);
  if (candidateTypes && (!previousTypes || !isSuperset(candidateTypes, previousTypes))) {
    reasons.push(`${path}: accepted JSON types were narrowed`);
    compatible = false;
  }

  const previousEnum = schemaSet(previous.enum);
  const candidateEnum = schemaSet(candidate.enum);
  if (candidateEnum && (!previousEnum || !isSuperset(candidateEnum, previousEnum))) {
    reasons.push(`${path}: enum values were narrowed`);
    compatible = false;
  } else if (previousEnum && (!candidateEnum || candidateEnum.size > previousEnum.size)) {
    reasons.push(`${path}: enum values were broadened`);
  }

  if (Object.hasOwn(candidate, "const")) {
    if (!Object.hasOwn(previous, "const") || canonicalJson(candidate.const) !== canonicalJson(previous.const)) {
      reasons.push(`${path}: const constraint was added or changed`);
      compatible = false;
    }
  } else if (Object.hasOwn(previous, "const")) {
    reasons.push(`${path}: const constraint was removed`);
  }

  const previousRequired = stringSet(previous.required);
  const candidateRequired = stringSet(candidate.required) ?? new Set<string>();
  if (previousRequired) {
    for (const key of candidateRequired) {
      if (!previousRequired.has(key)) {
        reasons.push(`${path}.${key}: optional input became required`);
        compatible = false;
      }
    }
  } else if (candidateRequired.size) {
    for (const key of candidateRequired) reasons.push(`${path}.${key}: new required input`);
    compatible = false;
  }

  const previousProperties = recordValue(previous.properties);
  const candidateProperties = recordValue(candidate.properties);
  if (previousProperties) {
    for (const [key, priorProperty] of Object.entries(previousProperties)) {
      const nextProperty = candidateProperties?.[key];
      if (!isRecord(priorProperty) || !isRecord(nextProperty)) {
        if (canonicalJson(priorProperty) !== canonicalJson(nextProperty)) {
          reasons.push(`${path}.${key}: accepted property was removed or replaced`);
          compatible = false;
        }
        continue;
      }
      compatible = schemaAcceptsPreviousInputs(
        priorProperty,
        nextProperty,
        `${path}.${key}`,
        reasons,
      ) && compatible;
    }
  }
  if (candidateProperties) {
    for (const key of Object.keys(candidateProperties)) {
      if (!previousProperties || !Object.hasOwn(previousProperties, key)) {
        reasons.push(`${path}.${key}: optional property was added`);
      }
    }
  }

  compatible = compareAdditionalProperties(previous, candidate, path, reasons) && compatible;

  for (const keyword of lowerBoundKeywords) {
    compatible = compareNumericBound(
      previous,
      candidate,
      keyword,
      "lower",
      path,
      reasons,
    ) && compatible;
  }
  for (const keyword of upperBoundKeywords) {
    compatible = compareNumericBound(
      previous,
      candidate,
      keyword,
      "upper",
      path,
      reasons,
    ) && compatible;
  }

  for (const keyword of ["pattern", "format", "multipleOf", "uniqueItems"] as const) {
    if (Object.hasOwn(candidate, keyword) && canonicalJson(candidate[keyword]) !== canonicalJson(previous[keyword])) {
      reasons.push(`${path}: ${keyword} constraint was added or changed`);
      compatible = false;
    }
  }

  const conservativeKeywords = [
    "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependentRequired",
    "dependentSchemas", "propertyNames", "patternProperties", "contains", "minContains",
    "maxContains", "unevaluatedProperties", "unevaluatedItems", "prefixItems", "items",
  ];
  for (const keyword of conservativeKeywords) {
    if (canonicalJson(previous[keyword]) !== canonicalJson(candidate[keyword])) {
      reasons.push(`${path}: ${keyword} changed and requires compatibility review`);
      compatible = false;
    }
  }

  return compatible;
}

function compareAdditionalProperties(
  previous: Record<string, unknown>,
  candidate: Record<string, unknown>,
  path: string,
  reasons: string[],
): boolean {
  const prior = previous.additionalProperties;
  const next = candidate.additionalProperties;
  if (canonicalJson(prior) === canonicalJson(next)) return true;

  if (next === false) {
    reasons.push(`${path}: additional properties are no longer accepted`);
    return false;
  }
  if (prior === false && (next === undefined || next === true || isRecord(next))) {
    reasons.push(`${path}: additional properties were broadened`);
    return true;
  }
  if (isRecord(next)) {
    if (!isRecord(prior)) {
      reasons.push(`${path}.*: unrestricted additional properties became schema-constrained`);
      return false;
    }
    return schemaAcceptsPreviousInputs(prior, next, `${path}.*`, reasons);
  }
  if (next === undefined || next === true) {
    if (isRecord(prior)) reasons.push(`${path}: additional-property schema was removed`);
    return true;
  }

  reasons.push(`${path}: additionalProperties changed and requires compatibility review`);
  return false;
}

function compareNumericBound(
  previous: Record<string, unknown>,
  candidate: Record<string, unknown>,
  keyword: string,
  direction: NumericBoundDirection,
  path: string,
  reasons: string[],
): boolean {
  const prior = numeric(previous[keyword]);
  const next = numeric(candidate[keyword]);
  if (next === undefined) return true;
  if (prior === undefined) {
    reasons.push(`${path}: ${keyword} became more restrictive`);
    return false;
  }

  const moreRestrictive = direction === "lower" ? next > prior : next < prior;
  if (moreRestrictive) {
    reasons.push(`${path}: ${keyword} became more restrictive`);
    return false;
  }

  const relaxed = direction === "lower" ? next < prior : next > prior;
  if (relaxed) reasons.push(`${path}: ${keyword} was relaxed`);
  return true;
}

function canonicalSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return canonicalRecord(schema, true);
}

function canonicalRecord(
  record: Record<string, unknown>,
  schemaAware = false,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, canonicalValue(value, schemaAware ? key : undefined)]),
  );
}

function canonicalValue(value: unknown, schemaKey?: string): unknown {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalValue(entry));
    if (["required", "type", "enum", "allOf", "anyOf", "oneOf"].includes(schemaKey ?? "")) {
      return entries.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    }
    return entries;
  }
  if (isRecord(value)) return canonicalRecord(value, true);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("MCP manifest cannot contain non-finite numbers");
  }
  if (["string", "number", "boolean"].includes(typeof value) || value === null) return value;
  throw new Error(`MCP manifest contains unsupported value type: ${typeof value}`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function normalizeToolName(value: string): string {
  const name = value.trim();
  if (!/^[a-z][a-z0-9._-]{0,119}$/.test(name)) {
    throw new Error(`Invalid MCP tool name: ${value}`);
  }
  return name;
}

function normalizeDescription(value: string | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim();
}

function schemaTypes(value: unknown): Set<string> | undefined {
  if (typeof value === "string") return new Set([value]);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return new Set(value);
  }
  return undefined;
}

function schemaSet(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  return new Set(value.map((entry) => canonicalJson(entry)));
}

function stringSet(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return new Set(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSuperset(candidate: Set<string>, previous: Set<string>): boolean {
  for (const value of previous) if (!candidate.has(value)) return false;
  return true;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
