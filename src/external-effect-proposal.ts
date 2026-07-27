import { createHash } from "node:crypto";

export const externalEffectClasses = [
  "github.issue.create",
  "github.issue.update",
  "github.comment.create",
  "github.pull_request.open",
  "github.merge",
  "deployment.start",
  "credential.change",
  "permission.change",
  "destructive.delete",
  "spend.commit",
] as const;

export type ExternalEffectClass = typeof externalEffectClasses[number];
export type ExternalEffectSensitivity = "public" | "internal" | "restricted";
export type ExternalEffectReversibility = "reversible" | "compensatable" | "irreversible";
export type ExternalEffectConsequence = "external_write" | "privileged_change" | "destructive" | "financial";
export type ExternalEffectCompensation = "none" | "provider_rollback" | "follow_up_effect" | "manual_reconciliation";
export type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | {
  [key: string]: CanonicalJsonValue;
};

export interface ExternalEffectRequesterInput {
  workspace: string;
  project: string;
  itemId: string;
  runId: string;
  actorId: string;
}

export interface ExternalEffectAuthorityFenceInput {
  resource: string;
  holderId: string;
  generation: number;
  expiresAt: string;
}

export interface ExternalEffectTargetInput {
  resource: string;
  subresource?: string;
  environment?: string;
}

export interface ExternalEffectProposalInput {
  proposalId: string;
  requester: ExternalEffectRequesterInput;
  authorityFence: ExternalEffectAuthorityFenceInput;
  effectClass: ExternalEffectClass;
  provider: string;
  accountBoundary: string;
  target: ExternalEffectTargetInput;
  payload: unknown;
  sensitivity: ExternalEffectSensitivity;
  reversibility: ExternalEffectReversibility;
  consequence: ExternalEffectConsequence;
  compensation: ExternalEffectCompensation;
  prerequisiteRefs: string[];
  evidenceRefs: string[];
  createdAt: string;
  expiresAt: string;
  supersedesProposalId?: string;
  correlationId?: string;
  causationId?: string;
}

export interface ExternalEffectProposal {
  version: 1;
  proposalId: string;
  requester: ExternalEffectRequesterInput;
  authorityFence: ExternalEffectAuthorityFenceInput;
  effectClass: ExternalEffectClass;
  provider: string;
  accountBoundary: string;
  target: {
    resource: string;
    subresource: string | null;
    environment: string | null;
  };
  payload: { [key: string]: CanonicalJsonValue };
  payloadFingerprint: string;
  sensitivity: ExternalEffectSensitivity;
  reversibility: ExternalEffectReversibility;
  consequence: ExternalEffectConsequence;
  compensation: ExternalEffectCompensation;
  prerequisiteRefs: string[];
  evidenceRefs: string[];
  createdAt: string;
  expiresAt: string;
  requestedUseCount: 1;
  supersedesProposalId: string | null;
  correlationId: string | null;
  causationId: string | null;
  preview: string;
  requiresHumanApproval: true;
  grantsApproval: false;
  authorizesExecution: false;
  secretsPermitted: false;
  fingerprint: string;
}

const limits = {
  proposalId: 160,
  workspace: 80,
  project: 80,
  itemId: 160,
  runId: 160,
  actorId: 160,
  authorityResource: 200,
  provider: 80,
  accountBoundary: 160,
  targetPart: 240,
  relationId: 160,
  reference: 240,
  references: 32,
  payloadBytes: 16 * 1024,
  payloadNodes: 8_192,
  payloadDepth: 8,
  payloadKeys: 64,
  payloadArray: 64,
  payloadString: 2_048,
  lifetimeMs: 7 * 24 * 60 * 60 * 1_000,
} as const;

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const slugPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const projectPattern = /^[a-z0-9][a-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const proposalPattern = /^effect_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const itemPattern = /^item_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const runPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const secretKeyPattern = /(secret|password|token|authorization|cookie|private.?key|credential)/iu;
const safeSecretReferenceSuffix = /(ref(?:erence)?|id|name|kind|class|scope)$/iu;
const obviousSecretValuePattern = /^(?:Bearer\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/u;
const forbiddenPayloadKeys = new Set(["__proto__", "constructor", "prototype"]);

const expectedConsequence: Readonly<Record<ExternalEffectClass, ExternalEffectConsequence>> = {
  "github.issue.create": "external_write",
  "github.issue.update": "external_write",
  "github.comment.create": "external_write",
  "github.pull_request.open": "external_write",
  "github.merge": "external_write",
  "deployment.start": "privileged_change",
  "credential.change": "privileged_change",
  "permission.change": "privileged_change",
  "destructive.delete": "destructive",
  "spend.commit": "financial",
};

interface PayloadBudget {
  nodes: number;
  bytes: number;
}

/**
 * Builds one exact, one-time Tier 3 effect proposal for later persistence and
 * human approval. The result is descriptive input only: it grants no approval,
 * authority, provider access, command acceptance, or execution permission.
 * Secret material is prohibited by contract; callers must supply references.
 */
export function buildExternalEffectProposal(
  input: ExternalEffectProposalInput,
): ExternalEffectProposal {
  const proposalId = boundedProposalId(input.proposalId, "Proposal ID");
  const requester = {
    workspace: boundedProject(input.requester.workspace, "Workspace", limits.workspace),
    project: boundedProject(input.requester.project, "Project", limits.project),
    itemId: boundedPrefixedIdentifier(input.requester.itemId, "Item ID", itemPattern, limits.itemId),
    runId: boundedPrefixedIdentifier(input.requester.runId, "Run ID", runPattern, limits.runId),
    actorId: boundedIdentifier(input.requester.actorId, "Requesting actor ID", limits.actorId),
  };
  const authorityFence = {
    resource: boundedIdentifier(
      input.authorityFence.resource,
      "Authority resource",
      limits.authorityResource,
    ),
    holderId: boundedIdentifier(
      input.authorityFence.holderId,
      "Authority holder ID",
      limits.actorId,
    ),
    generation: positiveGeneration(input.authorityFence.generation),
    expiresAt: canonicalTimestamp(input.authorityFence.expiresAt, "Authority expiry"),
  };
  if (authorityFence.resource !== `run:${requester.runId}`) {
    throw new RangeError("Authority resource must bind the requesting run");
  }
  if (authorityFence.holderId !== requester.actorId) {
    throw new RangeError("Authority holder must be the requesting actor");
  }

  const effectClass = exactEnum(input.effectClass, externalEffectClasses, "Effect class");
  const provider = boundedSlug(input.provider, "Provider", limits.provider);
  if (effectClass.startsWith("github.") && provider !== "github") {
    throw new RangeError("GitHub effects require the github provider");
  }
  const accountBoundary = boundedIdentifier(
    input.accountBoundary,
    "Provider account boundary",
    limits.accountBoundary,
  );
  const target = {
    resource: boundedIdentifier(input.target.resource, "Target resource", limits.targetPart),
    subresource: input.target.subresource === undefined
      ? null
      : boundedIdentifier(input.target.subresource, "Target subresource", limits.targetPart),
    environment: input.target.environment === undefined
      ? null
      : boundedSlug(input.target.environment, "Target environment", limits.targetPart),
  };
  if (effectClass === "deployment.start" && target.environment === null) {
    throw new RangeError("Deployment effects require an exact target environment");
  }

  const payload = canonicalPayload(input.payload);
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, "utf8") > limits.payloadBytes) {
    throw new RangeError(`Effect payload must be at most ${limits.payloadBytes} bytes`);
  }
  const payloadFingerprint = sha256(payloadJson);

  const sensitivity = exactEnum(
    input.sensitivity,
    ["public", "internal", "restricted"] as const,
    "Sensitivity",
  );
  const reversibility = exactEnum(
    input.reversibility,
    ["reversible", "compensatable", "irreversible"] as const,
    "Reversibility",
  );
  const consequence = exactEnum(
    input.consequence,
    ["external_write", "privileged_change", "destructive", "financial"] as const,
    "Consequence",
  );
  if (consequence !== expectedConsequence[effectClass]) {
    throw new RangeError(`Effect class ${effectClass} requires consequence ${expectedConsequence[effectClass]}`);
  }
  const compensation = exactEnum(
    input.compensation,
    ["none", "provider_rollback", "follow_up_effect", "manual_reconciliation"] as const,
    "Compensation",
  );
  if (reversibility === "irreversible" && compensation !== "none") {
    throw new RangeError("Irreversible effects cannot claim a compensation path");
  }
  if (reversibility !== "irreversible" && compensation === "none") {
    throw new RangeError("Reversible or compensatable effects require a compensation path");
  }

  const prerequisiteRefs = canonicalReferenceList(input.prerequisiteRefs, "Prerequisite");
  const evidenceRefs = canonicalReferenceList(input.evidenceRefs, "Evidence");
  const createdAt = canonicalTimestamp(input.createdAt, "Proposal creation time");
  const expiresAt = canonicalTimestamp(input.expiresAt, "Proposal expiry");
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= createdMs) {
    throw new RangeError("Proposal expiry must be later than creation time");
  }
  if (expiresMs - createdMs > limits.lifetimeMs) {
    throw new RangeError("Proposal lifetime must not exceed seven days");
  }
  if (expiresMs > Date.parse(authorityFence.expiresAt)) {
    throw new RangeError("Proposal expiry must not outlive its authority fence");
  }

  const supersedesProposalId = input.supersedesProposalId === undefined
    ? null
    : boundedProposalId(input.supersedesProposalId, "Superseded proposal ID");
  if (supersedesProposalId === proposalId) {
    throw new RangeError("A proposal cannot supersede itself");
  }
  const correlationId = optionalIdentifier(input.correlationId, "Correlation ID");
  const causationId = optionalIdentifier(input.causationId, "Causation ID");
  const preview = buildPreview({
    effectClass,
    provider,
    accountBoundary,
    target,
    payloadFingerprint,
    expiresAt,
  });

  const canonical = {
    version: 1 as const,
    proposalId,
    requester,
    authorityFence,
    effectClass,
    provider,
    accountBoundary,
    target,
    payload,
    payloadFingerprint,
    sensitivity,
    reversibility,
    consequence,
    compensation,
    prerequisiteRefs,
    evidenceRefs,
    createdAt,
    expiresAt,
    requestedUseCount: 1 as const,
    supersedesProposalId,
    correlationId,
    causationId,
    preview,
    requiresHumanApproval: true as const,
    grantsApproval: false as const,
    authorizesExecution: false as const,
    secretsPermitted: false as const,
  };
  return { ...canonical, fingerprint: sha256(JSON.stringify(canonical)) };
}

function canonicalPayload(value: unknown): { [key: string]: CanonicalJsonValue } {
  const budget: PayloadBudget = { nodes: 0, bytes: 0 };
  const canonical = canonicalJson(value, "payload", 0, new Set<object>(), budget);
  if (!isRecord(canonical)) {
    throw new RangeError("Effect payload must be a JSON object");
  }
  return canonical;
}

function canonicalJson(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
  budget: PayloadBudget,
): CanonicalJsonValue {
  if (depth > limits.payloadDepth) {
    throw new RangeError(`Effect ${path} exceeds the maximum depth`);
  }
  chargeNode(budget);
  if (value === null || typeof value === "boolean") {
    chargeSerializedValue(budget, value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`Effect ${path} numbers must be safe integers`);
    }
    chargeSerializedValue(budget, value);
    return value;
  }
  if (typeof value === "string") {
    const canonical = exactPayloadString(value, path);
    chargeSerializedValue(budget, canonical);
    return canonical;
  }
  if (typeof value !== "object" || value === undefined || ArrayBuffer.isView(value)) {
    throw new RangeError(`Effect ${path} must contain only JSON values`);
  }
  if (seen.has(value)) throw new RangeError("Effect payload must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return canonicalArray(value, path, depth, seen, budget);
    }
    return canonicalObject(value, path, depth, seen, budget);
  } finally {
    seen.delete(value);
  }
}

function canonicalArray(
  value: unknown[],
  path: string,
  depth: number,
  seen: Set<object>,
  budget: PayloadBudget,
): CanonicalJsonValue[] {
  if (value.length > limits.payloadArray) {
    throw new RangeError(`Effect ${path} arrays must contain at most ${limits.payloadArray} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`Effect ${path} arrays must not contain symbol properties`);
  }
  const keys = Object.keys(value);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || keys[index] !== String(index)) {
      throw new RangeError(`Effect ${path} arrays must be dense and contain no extra properties`);
    }
  }
  if (keys.length !== value.length) {
    throw new RangeError(`Effect ${path} arrays must be dense and contain no extra properties`);
  }

  chargeBytes(budget, 2);
  const result: CanonicalJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) chargeBytes(budget, 1);
    result.push(canonicalJson(value[index], `${path}[${index}]`, depth + 1, seen, budget));
  }
  return result;
}

function canonicalObject(
  value: object,
  path: string,
  depth: number,
  seen: Set<object>,
  budget: PayloadBudget,
): { [key: string]: CanonicalJsonValue } {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`Effect ${path} must use plain JSON objects`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`Effect ${path} objects must not contain symbol properties`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > limits.payloadKeys) {
    throw new RangeError(`Effect ${path} objects must contain at most ${limits.payloadKeys} keys`);
  }

  chargeBytes(budget, 2);
  const result: { [key: string]: CanonicalJsonValue } = {};
  const sortedKeys = keys.sort(compareCodePoints);
  for (let index = 0; index < sortedKeys.length; index += 1) {
    const rawKey = sortedKeys[index];
    const descriptor = rawKey === undefined ? undefined : descriptors[rawKey];
    if (!rawKey || !descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`Effect ${path} must contain only enumerable data properties`);
    }
    const key = exactPayloadKey(rawKey, path);
    if (index > 0) chargeBytes(budget, 1);
    chargeBytes(budget, encodedJsonBytes(key) + 1);
    result[key] = canonicalJson(descriptor.value, `${path}.${key}`, depth + 1, seen, budget);
  }
  return result;
}

function chargeNode(budget: PayloadBudget): void {
  budget.nodes += 1;
  if (budget.nodes > limits.payloadNodes) {
    throw new RangeError(
      `Effect payload exceeds the maximum validation node budget of ${limits.payloadNodes}`,
    );
  }
}

function chargeBytes(budget: PayloadBudget, bytes: number): void {
  budget.bytes += bytes;
  if (budget.bytes > limits.payloadBytes) {
    throw new RangeError(
      `Effect payload exceeds the maximum validation byte budget of ${limits.payloadBytes}`,
    );
  }
}

function chargeSerializedValue(
  budget: PayloadBudget,
  value: null | boolean | number | string,
): void {
  chargeBytes(budget, encodedJsonBytes(value));
}

function encodedJsonBytes(value: null | boolean | number | string): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new RangeError("Effect payload must contain only JSON values");
  }
  return Buffer.byteLength(serialized, "utf8");
}

function exactPayloadString(value: string, path: string): string {
  if (unsafeTextPattern.test(value)) {
    throw new RangeError(`Effect ${path} contains unsupported control characters`);
  }
  if ([...value].length > limits.payloadString) {
    throw new RangeError(`Effect ${path} must be at most ${limits.payloadString} characters`);
  }
  if (obviousSecretValuePattern.test(value.trimStart())) {
    throw new RangeError(`Effect ${path} appears to contain a secret value`);
  }
  return value;
}

function exactPayloadKey(value: string, path: string): string {
  if (unsafeTextPattern.test(value) || [...value].length === 0 || [...value].length > 80) {
    throw new RangeError(`Effect ${path} key is invalid`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value) || forbiddenPayloadKeys.has(value)) {
    throw new RangeError(`Effect ${path} keys must be bounded non-reserved identifiers`);
  }
  if (secretKeyPattern.test(value) && !safeSecretReferenceSuffix.test(value)) {
    throw new RangeError(`Effect ${path}.${value} may not contain secret-bearing data`);
  }
  return value;
}

function buildPreview(input: {
  effectClass: ExternalEffectClass;
  provider: string;
  accountBoundary: string;
  target: { resource: string; subresource: string | null; environment: string | null };
  payloadFingerprint: string;
  expiresAt: string;
}): string {
  const target = [input.target.resource, input.target.subresource, input.target.environment]
    .filter((value): value is string => value !== null)
    .join(" / ");
  return `${input.effectClass} via ${input.provider}/${input.accountBoundary} -> ${target}; ${input.payloadFingerprint}; expires ${input.expiresAt}`;
}

function canonicalReferenceList(values: string[], label: string): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > limits.references) {
    throw new RangeError(`${label} references must contain 1 to ${limits.references} entries`);
  }
  const normalized = values.map((value) => boundedIdentifier(value, `${label} reference`, limits.reference));
  const seen = new Set<string>();
  for (const value of normalized) {
    if (seen.has(value)) throw new RangeError(`${label} references contain duplicate entries`);
    seen.add(value);
  }
  return [...seen].sort(compareCodePoints);
}

function boundedProposalId(value: string, label: string): string {
  const normalized = boundedText(value, label, limits.proposalId);
  if (!proposalPattern.test(normalized)) {
    throw new RangeError(`${label} must start with effect_ and contain only identifier characters`);
  }
  return normalized;
}

function boundedPrefixedIdentifier(
  value: string,
  label: string,
  pattern: RegExp,
  maximumLength: number,
): string {
  const normalized = boundedText(value, label, maximumLength);
  if (!pattern.test(normalized)) throw new RangeError(`${label} has an invalid format`);
  return normalized;
}

function boundedIdentifier(value: string, label: string, maximumLength: number): string {
  const normalized = boundedText(value, label, maximumLength);
  if (!identifierPattern.test(normalized)) {
    throw new RangeError(`${label} contains unsupported characters`);
  }
  return normalized;
}

function boundedProject(value: string, label: string, maximumLength: number): string {
  const normalized = boundedText(value, label, maximumLength).toLowerCase();
  if (!projectPattern.test(normalized)) {
    throw new RangeError(`${label} must be a lowercase project slug`);
  }
  return normalized;
}

function boundedSlug(value: string, label: string, maximumLength: number): string {
  const normalized = boundedText(value, label, maximumLength).toLowerCase();
  if (!slugPattern.test(normalized)) throw new RangeError(`${label} must be a lowercase slug`);
  return normalized;
}

function boundedText(value: string, label: string, maximumLength: number): string {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new RangeError(`${label} must not be empty`);
  if ([...normalized].length > maximumLength) {
    throw new RangeError(`${label} must be at most ${maximumLength} characters`);
  }
  return normalized;
}

function optionalIdentifier(value: string | undefined, label: string): string | null {
  return value === undefined ? null : boundedIdentifier(value, label, limits.relationId);
}

function positiveGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Authority generation must be a positive safe integer");
  }
  return value;
}

function canonicalTimestamp(value: string, label: string): string {
  const normalized = boundedText(value, label, 64);
  if (!timestampPattern.test(normalized)) {
    throw new RangeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const canonical = new Date(milliseconds).toISOString();
  const comparableInput = normalized.includes(".")
    ? normalized
    : normalized.replace(/Z$/, ".000Z");
  if (canonical !== comparableInput) {
    throw new RangeError(`${label} must be a valid calendar timestamp`);
  }
  return canonical;
}

function exactEnum<const Values extends readonly string[]>(
  value: string,
  values: Values,
  label: string,
): Values[number] {
  if (!values.includes(value as Values[number])) throw new RangeError(`${label} is invalid`);
  return value as Values[number];
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: CanonicalJsonValue): value is { [key: string]: CanonicalJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
