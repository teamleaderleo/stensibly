import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const DELIVERY_DESK_SCHEMA_VERSION = 1 as const;
export const DELIVERY_STATES = ["land-now", "final-gate", "polish", "decision"] as const;
export const DELIVERY_RISK_TIERS = ["tier_0", "tier_1", "tier_2", "tier_3"] as const;
export const DELIVERY_DISPOSITIONS = [
  "accept",
  "pending",
  "repair",
  "hold",
  "decision_required",
] as const;
export const DELIVERY_EVIDENCE_KINDS = [
  "local_command",
  "github_ci",
  "review",
  "deployment",
  "carrier_execution",
] as const;
export const DELIVERY_CARRIER_KINDS = ["workflow", "branch", "pull_request"] as const;
export const DELIVERY_HOSTED_STATES = [
  "not_applicable",
  "not_deployed",
  "deployed_unverified",
  "deployed_verified",
  "unknown",
] as const;
export const DELIVERY_INVALIDATIONS = [
  "head_changed",
  "required_input_changed",
  "review_changed",
  "evidence_changed",
  "carrier_changed",
] as const;

export type DeliveryState = typeof DELIVERY_STATES[number];
export type DeliveryRiskTier = typeof DELIVERY_RISK_TIERS[number];
export type DeliveryDisposition = typeof DELIVERY_DISPOSITIONS[number];
export type DeliveryEvidenceKind = typeof DELIVERY_EVIDENCE_KINDS[number];
export type DeliveryCarrierKind = typeof DELIVERY_CARRIER_KINDS[number];
export type DeliveryHostedState = typeof DELIVERY_HOSTED_STATES[number];
export type DeliveryInvalidation = typeof DELIVERY_INVALIDATIONS[number];

export interface DeliveryDeskIssueReference {
  repository: string;
  number: number;
  url: string;
}

export interface DeliveryDeskImplementationReference {
  repository: string;
  pullRequestNumber: number;
  url: string;
  branch: string;
  headSha: string;
}

export interface DeliveryDeskEvidence {
  kind: DeliveryEvidenceKind;
  reference: string;
  observedAt: string;
  fingerprint: string;
}

export interface DeliveryDeskCarrier {
  kind: DeliveryCarrierKind;
  reference: string;
  headSha: string;
  removable: boolean;
}

export interface DeliveryDeskEntry {
  schemaVersion: typeof DELIVERY_DESK_SCHEMA_VERSION;
  issue: DeliveryDeskIssueReference;
  implementation: DeliveryDeskImplementationReference;
  selectedState: DeliveryState;
  riskTier: DeliveryRiskTier;
  evidence: DeliveryDeskEvidence[];
  disposition: DeliveryDisposition;
  remainingGate: string;
  owner: string | null;
  carrier: DeliveryDeskCarrier | null;
  hostedState: DeliveryHostedState;
  requiredInputFingerprint: string;
  reviewFingerprint: string | null;
}

export interface DeliveryDeskProjection {
  schemaVersion: typeof DELIVERY_DESK_SCHEMA_VERSION;
  observedAt: string;
  entries: DeliveryDeskEntry[];
  projectionFingerprint: string;
}

export interface DeliveryDeskCurrentFacts {
  implementationHead: string;
  requiredInputFingerprint: string;
  reviewFingerprint: string | null;
  evidenceFingerprints: string[];
  carrierHeadSha: string | null;
}

export interface DeliveryDeskEvaluation {
  issueNumber: number;
  selectedState: DeliveryState;
  effectiveState: DeliveryState;
  invalidations: DeliveryInvalidation[];
  landingEligible: boolean;
  authorizesIntegration: false;
  remainingGate: string;
}

const stateOrder = new Map<DeliveryState, number>([
  ["land-now", 0],
  ["final-gate", 1],
  ["polish", 2],
  ["decision", 3],
]);

export function createDeliveryDeskProjection(input: {
  observedAt: unknown;
  entries: unknown;
}): DeliveryDeskProjection {
  const observedAt = canonicalTimestamp(input.observedAt, "Delivery Desk observation time");
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 50) {
    throw new Error("Delivery Desk entries must contain between 1 and 50 records");
  }
  const entries = input.entries.map(parseDeliveryDeskEntry).sort(compareEntries);
  assertUniqueEntries(entries);
  const withoutFingerprint = {
    schemaVersion: DELIVERY_DESK_SCHEMA_VERSION,
    observedAt,
    entries,
  };
  return deepFreeze({
    ...withoutFingerprint,
    projectionFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

export function parseDeliveryDeskProjection(input: unknown): DeliveryDeskProjection {
  const record = requireRecord(input, "Delivery Desk projection");
  rejectUnknownKeys(
    record,
    ["schemaVersion", "observedAt", "entries", "projectionFingerprint"],
    "Delivery Desk projection",
  );
  if (record.schemaVersion !== DELIVERY_DESK_SCHEMA_VERSION) {
    throw new Error("Delivery Desk projection schema version is unsupported");
  }
  const projection = createDeliveryDeskProjection({
    observedAt: record.observedAt,
    entries: record.entries,
  });
  const suppliedEntries = (record.entries as unknown[]).map(parseDeliveryDeskEntry);
  const suppliedOrder = suppliedEntries.map((entry) => deliveryDeskIssueKey(entry.issue));
  const canonicalOrder = projection.entries.map((entry) => deliveryDeskIssueKey(entry.issue));
  if (JSON.stringify(suppliedOrder) !== JSON.stringify(canonicalOrder)) {
    throw new Error("Delivery Desk entries must be in canonical finish-line order");
  }
  const suppliedFingerprint = sha256(
    record.projectionFingerprint,
    "Delivery Desk projection fingerprint",
  );
  if (suppliedFingerprint !== projection.projectionFingerprint) {
    throw new Error("Delivery Desk projection fingerprint does not match its contents");
  }
  return projection;
}

export function parseDeliveryDeskEntry(input: unknown): DeliveryDeskEntry {
  const record = requireRecord(input, "Delivery Desk entry");
  rejectUnknownKeys(
    record,
    [
      "schemaVersion",
      "issue",
      "implementation",
      "selectedState",
      "riskTier",
      "evidence",
      "disposition",
      "remainingGate",
      "owner",
      "carrier",
      "hostedState",
      "requiredInputFingerprint",
      "reviewFingerprint",
    ],
    "Delivery Desk entry",
  );
  if (record.schemaVersion !== DELIVERY_DESK_SCHEMA_VERSION) {
    throw new Error("Delivery Desk entry schema version is unsupported");
  }
  const issue = parseIssueReference(record.issue);
  const implementation = parseImplementationReference(record.implementation);
  if (issue.repository !== implementation.repository) {
    throw new Error("Delivery Desk issue and implementation repositories must match");
  }
  const selectedState = closedValue(
    record.selectedState,
    DELIVERY_STATES,
    "Delivery Desk state",
  );
  const riskTier = closedValue(record.riskTier, DELIVERY_RISK_TIERS, "Delivery Desk risk tier");
  const disposition = closedValue(
    record.disposition,
    DELIVERY_DISPOSITIONS,
    "Delivery Desk disposition",
  );
  const evidence = parseEvidence(record.evidence);
  const carrier = record.carrier === null ? null : parseCarrier(record.carrier);
  const entry: DeliveryDeskEntry = {
    schemaVersion: DELIVERY_DESK_SCHEMA_VERSION,
    issue,
    implementation,
    selectedState,
    riskTier,
    evidence,
    disposition,
    remainingGate: boundedText(record.remainingGate, "Delivery Desk remaining gate", 320),
    owner: record.owner === null
      ? null
      : boundedIdentifier(record.owner, "Delivery Desk owner", 120),
    carrier,
    hostedState: closedValue(
      record.hostedState,
      DELIVERY_HOSTED_STATES,
      "Delivery Desk hosted state",
    ),
    requiredInputFingerprint: sha256(
      record.requiredInputFingerprint,
      "Delivery Desk required-input fingerprint",
    ),
    reviewFingerprint: record.reviewFingerprint === null
      ? null
      : sha256(record.reviewFingerprint, "Delivery Desk review fingerprint"),
  };
  validateStateInvariants(entry);
  return deepFreeze(entry);
}

export function parseDeliveryDeskCurrentFacts(input: unknown): DeliveryDeskCurrentFacts {
  const record = requireRecord(input, "Delivery Desk current facts");
  rejectUnknownKeys(
    record,
    [
      "implementationHead",
      "requiredInputFingerprint",
      "reviewFingerprint",
      "evidenceFingerprints",
      "carrierHeadSha",
    ],
    "Delivery Desk current facts",
  );
  if (!Array.isArray(record.evidenceFingerprints) || record.evidenceFingerprints.length > 100) {
    throw new Error("Delivery Desk current evidence fingerprints are invalid");
  }
  const evidenceFingerprints = record.evidenceFingerprints.map((value) =>
    sha256(value, "Delivery Desk current evidence fingerprint")
  ).sort();
  if (new Set(evidenceFingerprints).size !== evidenceFingerprints.length) {
    throw new Error("Delivery Desk current evidence fingerprints must be unique");
  }
  return deepFreeze({
    implementationHead: commitSha(record.implementationHead, "Delivery Desk current head"),
    requiredInputFingerprint: sha256(
      record.requiredInputFingerprint,
      "Delivery Desk current required-input fingerprint",
    ),
    reviewFingerprint: record.reviewFingerprint === null
      ? null
      : sha256(record.reviewFingerprint, "Delivery Desk current review fingerprint"),
    evidenceFingerprints,
    carrierHeadSha: record.carrierHeadSha === null
      ? null
      : commitSha(record.carrierHeadSha, "Delivery Desk current carrier head"),
  });
}

export function currentFactsFromDeliveryDeskEntry(
  entryInput: unknown,
): DeliveryDeskCurrentFacts {
  const entry = parseDeliveryDeskEntry(entryInput);
  return deepFreeze({
    implementationHead: entry.implementation.headSha,
    requiredInputFingerprint: entry.requiredInputFingerprint,
    reviewFingerprint: entry.reviewFingerprint,
    evidenceFingerprints: entry.evidence.map((item) => item.fingerprint).sort(),
    carrierHeadSha: entry.carrier?.headSha ?? null,
  });
}

export function evaluateDeliveryDeskEntry(
  entryInput: unknown,
  factsInput: unknown,
): DeliveryDeskEvaluation {
  const entry = parseDeliveryDeskEntry(entryInput);
  const facts = parseDeliveryDeskCurrentFacts(factsInput);
  const invalidations: DeliveryInvalidation[] = [];
  if (entry.implementation.headSha !== facts.implementationHead) {
    invalidations.push("head_changed");
  }
  if (entry.requiredInputFingerprint !== facts.requiredInputFingerprint) {
    invalidations.push("required_input_changed");
  }
  if (entry.reviewFingerprint !== facts.reviewFingerprint) {
    invalidations.push("review_changed");
  }
  const expectedEvidence = entry.evidence.map((item) => item.fingerprint).sort();
  if (JSON.stringify(expectedEvidence) !== JSON.stringify(facts.evidenceFingerprints)) {
    invalidations.push("evidence_changed");
  }
  if ((entry.carrier?.headSha ?? null) !== facts.carrierHeadSha) {
    invalidations.push("carrier_changed");
  }

  let effectiveState = entry.selectedState;
  if (invalidations.length > 0) {
    effectiveState = entry.selectedState === "decision"
      || entry.disposition === "hold"
      || entry.disposition === "decision_required"
      ? "decision"
      : "polish";
  }
  const landingEligible = effectiveState === "land-now"
    && invalidations.length === 0
    && entry.disposition === "accept"
    && entry.carrier === null;
  return deepFreeze({
    issueNumber: entry.issue.number,
    selectedState: entry.selectedState,
    effectiveState,
    invalidations,
    landingEligible,
    authorizesIntegration: false,
    remainingGate: entry.remainingGate,
  });
}

export function renderDeliveryDeskMarkdown(
  projectionInput: unknown,
  factsByIssue: Readonly<Record<string, unknown>> = {},
): string {
  const projection = parseDeliveryDeskProjection(projectionInput);
  const lines = [
    "# Delivery Desk",
    "",
    `Observed at: \`${projection.observedAt}\``,
    `Projection: \`${projection.projectionFingerprint}\``,
    "",
    "> This projection is informational. It grants no merge, deployment, provider, credential, external-contact, or mutation authority.",
    "",
    "| State | Canonical issue | Implementation | Tier | Evidence | Disposition | Remaining gate | Owner | Carrier | Hosted | Invalidations |",
    "| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of projection.entries) {
    const key = deliveryDeskIssueKey(entry.issue);
    const facts = key in factsByIssue
      ? factsByIssue[key]
      : currentFactsFromDeliveryDeskEntry(entry);
    const evaluation = evaluateDeliveryDeskEntry(entry, facts);
    lines.push([
      `| **${evaluation.effectiveState}**`,
      `[${entry.issue.repository}#${entry.issue.number}](${entry.issue.url})`,
      `[#${entry.implementation.pullRequestNumber}](${entry.implementation.url}) \`${entry.implementation.headSha.slice(0, 12)}\``,
      entry.riskTier,
      String(entry.evidence.length),
      entry.disposition,
      escapeTable(entry.remainingGate),
      entry.owner ? `\`${escapeTable(entry.owner)}\`` : "unclaimed",
      entry.carrier ? `${entry.carrier.kind}: \`${escapeTable(entry.carrier.reference)}\`` : "none",
      entry.hostedState,
      evaluation.invalidations.length ? evaluation.invalidations.join(", ") : "none",
    ].join(" | ") + " |");
  }
  lines.push(
    "",
    "Entries leave this desk after integration closeout, explicit hold, supersession, or completion. Canonical issues and pull requests remain the source of truth.",
    "",
  );
  return lines.join("\n");
}

export function deliveryDeskIssueKey(issue: DeliveryDeskIssueReference): string {
  return `${issue.repository}#${issue.number}`;
}

function parseIssueReference(input: unknown): DeliveryDeskIssueReference {
  const record = requireRecord(input, "Delivery Desk issue reference");
  rejectUnknownKeys(record, ["repository", "number", "url"], "Delivery Desk issue reference");
  const repository = repositoryName(record.repository, "Delivery Desk issue repository");
  const number = positiveInteger(record.number, "Delivery Desk issue number");
  const url = boundedText(record.url, "Delivery Desk issue URL", 300);
  const expected = `https://github.com/${repository}/issues/${number}`;
  if (url !== expected) throw new Error("Delivery Desk issue URL is not canonical");
  return { repository, number, url };
}

function parseImplementationReference(input: unknown): DeliveryDeskImplementationReference {
  const record = requireRecord(input, "Delivery Desk implementation reference");
  rejectUnknownKeys(
    record,
    ["repository", "pullRequestNumber", "url", "branch", "headSha"],
    "Delivery Desk implementation reference",
  );
  const repository = repositoryName(
    record.repository,
    "Delivery Desk implementation repository",
  );
  const pullRequestNumber = positiveInteger(
    record.pullRequestNumber,
    "Delivery Desk implementation pull request number",
  );
  const url = boundedText(record.url, "Delivery Desk implementation URL", 300);
  const expected = `https://github.com/${repository}/pull/${pullRequestNumber}`;
  if (url !== expected) throw new Error("Delivery Desk implementation URL is not canonical");
  return {
    repository,
    pullRequestNumber,
    url,
    branch: branchName(record.branch),
    headSha: commitSha(record.headSha, "Delivery Desk implementation head"),
  };
}

function parseEvidence(input: unknown): DeliveryDeskEvidence[] {
  if (!Array.isArray(input) || input.length > 100) {
    throw new Error("Delivery Desk evidence must be a bounded array");
  }
  const suppliedEvidence = input.map((item) => {
    const record = requireRecord(item, "Delivery Desk evidence");
    rejectUnknownKeys(
      record,
      ["kind", "reference", "observedAt", "fingerprint"],
      "Delivery Desk evidence",
    );
    return {
      kind: closedValue(record.kind, DELIVERY_EVIDENCE_KINDS, "Delivery Desk evidence kind"),
      reference: boundedText(record.reference, "Delivery Desk evidence reference", 240),
      observedAt: canonicalTimestamp(record.observedAt, "Delivery Desk evidence time"),
      fingerprint: sha256(record.fingerprint, "Delivery Desk evidence fingerprint"),
    };
  });
  const fingerprints = suppliedEvidence.map((item) => item.fingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("Delivery Desk evidence fingerprints must be unique");
  }
  const evidence = [...suppliedEvidence].sort(compareEvidence);
  if (
    JSON.stringify(suppliedEvidence.map((item) => item.fingerprint))
    !== JSON.stringify(evidence.map((item) => item.fingerprint))
  ) {
    throw new Error("Delivery Desk evidence must be in canonical order");
  }
  return evidence;
}

function parseCarrier(input: unknown): DeliveryDeskCarrier {
  const record = requireRecord(input, "Delivery Desk carrier");
  rejectUnknownKeys(
    record,
    ["kind", "reference", "headSha", "removable"],
    "Delivery Desk carrier",
  );
  if (typeof record.removable !== "boolean") {
    throw new Error("Delivery Desk carrier removable flag must be boolean");
  }
  return {
    kind: closedValue(record.kind, DELIVERY_CARRIER_KINDS, "Delivery Desk carrier kind"),
    reference: boundedText(record.reference, "Delivery Desk carrier reference", 240),
    headSha: commitSha(record.headSha, "Delivery Desk carrier head"),
    removable: record.removable,
  };
}

function validateStateInvariants(entry: DeliveryDeskEntry): void {
  if (
    entry.reviewFingerprint !== null
    && !entry.evidence.some((evidence) =>
      evidence.kind === "review"
      && evidence.fingerprint === entry.reviewFingerprint
    )
  ) {
    throw new Error("Delivery Desk review fingerprint must match retained review evidence");
  }
  if (entry.selectedState === "land-now") {
    if (entry.disposition !== "accept" || entry.carrier !== null || entry.evidence.length === 0) {
      throw new Error("land-now requires accepted evidence and no execution carrier");
    }
    if (entry.reviewFingerprint === null) {
      throw new Error("land-now requires an exact review fingerprint");
    }
  }
  if (entry.selectedState === "final-gate") {
    if (!(["accept", "pending"] as DeliveryDisposition[]).includes(entry.disposition)) {
      throw new Error("final-gate requires an accepted or pending disposition");
    }
    if (entry.evidence.length === 0) {
      throw new Error("final-gate requires executed evidence");
    }
  }
  if (entry.selectedState === "polish") {
    if (!(["repair", "pending"] as DeliveryDisposition[]).includes(entry.disposition)) {
      throw new Error("polish requires a repair or pending disposition");
    }
  }
  if (entry.selectedState === "decision") {
    if (!(["hold", "decision_required"] as DeliveryDisposition[]).includes(entry.disposition)) {
      throw new Error("decision requires a hold or explicit decision disposition");
    }
  }
}

function assertUniqueEntries(entries: DeliveryDeskEntry[]): void {
  const issues = entries.map((entry) => deliveryDeskIssueKey(entry.issue));
  if (new Set(issues).size !== issues.length) {
    throw new Error("Delivery Desk canonical issues must be unique");
  }
  const implementations = entries.map((entry) =>
    `${entry.implementation.repository}#${entry.implementation.pullRequestNumber}`
  );
  if (new Set(implementations).size !== implementations.length) {
    throw new Error("Delivery Desk implementations must be unique");
  }
}

function compareEntries(left: DeliveryDeskEntry, right: DeliveryDeskEntry): number {
  const stateDelta = stateOrder.get(left.selectedState)! - stateOrder.get(right.selectedState)!;
  if (stateDelta !== 0) return stateDelta;
  const repositoryDelta = compareText(left.issue.repository, right.issue.repository);
  return repositoryDelta || left.issue.number - right.issue.number;
}

function compareEvidence(left: DeliveryDeskEvidence, right: DeliveryDeskEvidence): number {
  return compareText(left.kind, right.kind)
    || compareText(left.reference, right.reference)
    || compareText(left.observedAt, right.observedAt)
    || compareText(left.fingerprint, right.fingerprint);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryName(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.toLowerCase()) {
    throw new Error(`${label} must be a lowercase owner/repository`);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const [, repository] = value.split("/");
  if (!repository || repository === "." || repository === ".." || repository.includes("..")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function branchName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new Error("Delivery Desk branch is invalid");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.endsWith("/")
    || value.includes("//")
    || value.includes("..")
    || value.includes("@{")
  ) {
    throw new Error("Delivery Desk branch is invalid");
  }
  return value;
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 identity`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must be bounded text`);
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} contains unsafe characters`);
  }
  if (value.normalize("NFKC").trim() !== value) {
    throw new Error(`${label} must be canonical text`);
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string, maximum: number): string {
  const text = boundedText(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a canonical UTC timestamp`);
  const canonical = new Date(parsed).toISOString();
  const supplied = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  if (canonical !== supplied) throw new Error(`${label} must be a canonical UTC timestamp`);
  return canonical;
}

function closedValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Values[number];
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !known.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown[0]}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function escapeTable(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
