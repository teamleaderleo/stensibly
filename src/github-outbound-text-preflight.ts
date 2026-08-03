import { sha256 } from "./canonical-json.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1 = 1 as const;

export type GitHubOutboundTextField =
  | "title"
  | "body"
  | "comment"
  | "review"
  | "inline_review";

export type GitHubOutboundExternalReferenceDisposition =
  | "reject"
  | "require_authority";

export type GitHubOutboundTextPreflightDecision =
  | "pass"
  | "reject"
  | "requires_authority";

export type GitHubOutboundReferenceKind =
  | "issue"
  | "pull_request"
  | "issue_or_pull_request"
  | "discussion"
  | "commit";

export type GitHubOutboundReferenceSource =
  | "direct_url"
  | "repository_shorthand"
  | "commit_shorthand";

export type GitHubOutboundReferenceRule =
  | "external_reference"
  | "external_closing_reference";

export interface GitHubOutboundTextPolicyV1 {
  version: typeof GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1;
  policyId: string;
  controlledRepositories: readonly string[];
  externalReferenceDisposition: GitHubOutboundExternalReferenceDisposition;
}

export interface GitHubOutboundTextPreflightInputV1 {
  schemaVersion: typeof GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1;
  policy: GitHubOutboundTextPolicyV1;
  repositoryFullName: string;
  field: GitHubOutboundTextField;
  text: string;
}

export interface GitHubOutboundTextFindingV1 {
  version: typeof GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1;
  field: GitHubOutboundTextField;
  line: number;
  column: number;
  source: GitHubOutboundReferenceSource;
  referenceKind: GitHubOutboundReferenceKind;
  externalOwner: string;
  externalRepository: string;
  itemNumber: number | null;
  commitPrefix: string | null;
  rule: GitHubOutboundReferenceRule;
  authorityRequired: boolean;
  findingFingerprint: string;
}

export interface GitHubOutboundTextPreflightResultV1 {
  version: typeof GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1;
  policyId: string;
  policyFingerprint: string;
  repositoryFullName: string;
  field: GitHubOutboundTextField;
  textSha256: string;
  textByteLength: number;
  textCharacterCount: number;
  decision: GitHubOutboundTextPreflightDecision;
  findings: readonly GitHubOutboundTextFindingV1[];
  inputFingerprint: string;
  resultFingerprint: string;
  authorizesProviderMutation: false;
  authorizesExternalInteraction: false;
  grantsAuthority: false;
}

interface DetectedReference {
  start: number;
  end: number;
  source: GitHubOutboundReferenceSource;
  referenceKind: GitHubOutboundReferenceKind;
  repositoryFullName: string;
  itemNumber: number | null;
  commitIdentity: string | null;
  referenceIdentity: string;
}

const inputKeys = [
  "schemaVersion",
  "policy",
  "repositoryFullName",
  "field",
  "text",
] as const;
const policyKeys = [
  "version",
  "policyId",
  "controlledRepositories",
  "externalReferenceDisposition",
] as const;
const allowedFields = new Set<GitHubOutboundTextField>([
  "title",
  "body",
  "comment",
  "review",
  "inline_review",
]);
const allowedDispositions =
  new Set<GitHubOutboundExternalReferenceDisposition>([
    "reject",
    "require_authority",
  ]);
const policyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const unsafeTextPattern =
  /[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const realisticCredentialPattern =
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;
const closingKeywordBeforeReferencePattern =
  /(?:^|[^\p{L}\p{N}\p{M}\p{Pc}])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:,*_~`-]*$/iu;
const commitReferenceIdentityPattern = /^[0-9a-f]{7,}$/iu;
const maximumTextBytes = 128 * 1024;
const maximumControlledRepositories = 32;
const maximumFindings = 100;
const maximumProviderItemNumber = 2_147_483_647;

type DataRecord = Record<string, unknown>;

/**
 * Evaluates exact outbound GitHub text without performing or authorizing a
 * provider mutation. Diagnostics deliberately separate repository identity
 * fields and never retain the source text or a complete external reference.
 *
 * Text is byte-exact: LF, CRLF, lone CR, trailing whitespace, and final-newline
 * state are neither normalized nor inferred. LF alone advances the diagnostic
 * line number; CR remains an exact character in the current line.
 */
export function compileGitHubOutboundTextPreflightV1(
  value: unknown,
): GitHubOutboundTextPreflightResultV1 {
  const input = exactRecord(
    value,
    inputKeys,
    "GitHub outbound text preflight input",
  );
  if (input.schemaVersion !== GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1) {
    throw new RangeError("GitHub outbound text preflight schemaVersion must equal 1");
  }

  const policy = admitPolicy(input.policy);
  const repositoryFullName = canonicalRepository(
    input.repositoryFullName,
    "GitHub outbound target repository",
  );
  if (!policy.controlledRepositories.includes(repositoryFullName)) {
    throw new RangeError(
      "GitHub outbound target repository must be controlled by the active policy",
    );
  }
  const field = outboundField(input.field);
  const text = exactOutboundText(input.text);
  const textSha256 = sha256(text);
  const textByteLength = Buffer.byteLength(text, "utf8");
  const textCharacterCount = [...text].length;
  const inputFingerprint = fingerprintCanonicalRequest({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policyFingerprint: policy.policyFingerprint,
    repositoryFullName,
    field,
    textSha256,
    textByteLength,
    textCharacterCount,
  });

  const controlled = new Set(policy.controlledRepositories);
  const lineStarts = buildLineStarts(text);
  const detected = detectReferences(text)
    .filter((reference) => !controlled.has(reference.repositoryFullName));
  if (detected.length > maximumFindings) {
    throw new RangeError(
      `GitHub outbound text accepts at most ${maximumFindings} external references`,
    );
  }

  const findings = detected.map((reference) => {
    const position = sourcePosition(text, lineStarts, reference.start);
    const [externalOwner, externalRepository] =
      reference.repositoryFullName.split("/") as [string, string];
    const lineStart = lineStarts[position.line - 1] ?? 0;
    const prefix = text.slice(lineStart, reference.start);
    const rule: GitHubOutboundReferenceRule =
      closingKeywordBeforeReferencePattern.test(prefix)
        ? "external_closing_reference"
        : "external_reference";
    const body = {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      field,
      line: position.line,
      column: position.column,
      source: reference.source,
      referenceKind: reference.referenceKind,
      externalOwner,
      externalRepository,
      itemNumber: reference.itemNumber,
      commitPrefix: reference.commitIdentity?.slice(0, 4) ?? null,
      rule,
      authorityRequired:
        policy.externalReferenceDisposition === "require_authority",
    };
    const referenceDigest = fingerprintCanonicalRequest({
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      repositoryFullName: reference.repositoryFullName,
      referenceKind: reference.referenceKind,
      referenceIdentity: reference.referenceIdentity,
    });
    return deepFreeze({
      ...body,
      findingFingerprint: fingerprintCanonicalRequest({
        ...body,
        referenceDigest,
      }),
    });
  });

  const decision: GitHubOutboundTextPreflightDecision = findings.length === 0
    ? "pass"
    : policy.externalReferenceDisposition === "require_authority"
    ? "requires_authority"
    : "reject";
  const body = {
    version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policyId: policy.policyId,
    policyFingerprint: policy.policyFingerprint,
    repositoryFullName,
    field,
    textSha256,
    textByteLength,
    textCharacterCount,
    decision,
    findings: Object.freeze(findings),
    inputFingerprint,
    authorizesProviderMutation: false as const,
    authorizesExternalInteraction: false as const,
    grantsAuthority: false as const,
  };
  return deepFreeze({
    ...body,
    resultFingerprint: fingerprintCanonicalRequest(body),
  });
}

function admitPolicy(value: unknown): Readonly<{
  version: 1;
  policyId: string;
  controlledRepositories: readonly string[];
  externalReferenceDisposition: GitHubOutboundExternalReferenceDisposition;
  policyFingerprint: string;
}> {
  const input = exactRecord(value, policyKeys, "GitHub outbound text policy");
  if (input.version !== GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1) {
    throw new RangeError("GitHub outbound text policy version must equal 1");
  }
  const policyId = canonicalPolicyId(
    input.policyId,
    "GitHub outbound text policy ID",
    160,
  );
  const controlledRepositories = canonicalRepositoryList(
    input.controlledRepositories,
  );
  if (!allowedDispositions.has(
    input.externalReferenceDisposition as GitHubOutboundExternalReferenceDisposition,
  )) {
    throw new RangeError(
      "GitHub outbound external-reference disposition is unsupported",
    );
  }
  const externalReferenceDisposition =
    input.externalReferenceDisposition as GitHubOutboundExternalReferenceDisposition;
  const body = {
    version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policyId,
    controlledRepositories,
    externalReferenceDisposition,
  };
  return deepFreeze({
    ...body,
    policyFingerprint: fingerprintCanonicalRequest(body),
  });
}

function canonicalRepositoryList(value: unknown): readonly string[] {
  const values = denseDataArray(
    value,
    "GitHub outbound controlled repositories",
    maximumControlledRepositories,
  );
  if (values.length === 0) {
    throw new RangeError(
      "GitHub outbound policy requires at least one controlled repository",
    );
  }
  const repositories = values.map((entry, index) =>
    canonicalRepository(
      entry,
      `GitHub outbound controlled repository ${index}`,
    )
  );
  if (new Set(repositories).size !== repositories.length) {
    throw new RangeError(
      "GitHub outbound controlled repositories must be unique",
    );
  }
  const sorted = [...repositories].sort(codeUnitCompare);
  if (sorted.some((repository, index) => repository !== repositories[index])) {
    throw new RangeError(
      "GitHub outbound controlled repositories must use canonical sorted order",
    );
  }
  return Object.freeze(repositories);
}

function detectReferences(text: string): readonly DetectedReference[] {
  const references: DetectedReference[] = [];
  const occupied: Array<readonly [number, number]> = [];
  const directItemReferencePattern =
    /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/(issues|pull|discussions)\/([0-9]+)(?![\p{L}\p{N}\p{M}\p{Pc}~-])/giu;
  const directCommitReferencePattern =
    /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/commit\/([0-9a-f]{7,})(?![\p{L}\p{N}\p{M}\p{Pc}~-])/giu;
  const repositoryShorthandPattern =
    /(?:^|[^\p{L}\p{N}\p{M}\p{Pc}.~/?#@!$&*+=%-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})#([1-9][0-9]*)(?![\p{L}\p{N}\p{M}\p{Pc}~\/?#@!$&*+=%-])/gu;
  const commitShorthandPattern =
    /(?:^|[^\p{L}\p{N}\p{M}\p{Pc}.~/?#@!$&*+=%-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})@([0-9a-f]{7,})(?![\p{L}\p{N}\p{M}\p{Pc}~\/?#@!$&*+=%-])/giu;

  for (const match of text.matchAll(directItemReferencePattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const repositoryFullName = detectedRepository(match[1], match[2]);
    if (!repositoryFullName) continue;
    const itemIdentity = match[4]!;
    const pathKind = match[3]!.toLowerCase();
    references.push({
      start,
      end,
      source: "direct_url",
      referenceKind: pathKind === "issues"
        ? "issue"
        : pathKind === "pull"
        ? "pull_request"
        : "discussion",
      repositoryFullName,
      itemNumber: providerItemNumber(itemIdentity),
      commitIdentity: null,
      referenceIdentity: itemIdentity,
    });
    occupied.push([start, end]);
  }

  for (const match of text.matchAll(directCommitReferencePattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const repositoryFullName = detectedRepository(match[1], match[2]);
    if (!repositoryFullName) continue;
    const commitIdentity = match[3]!.toLowerCase();
    if (!commitReferenceIdentityPattern.test(commitIdentity)) continue;
    references.push({
      start,
      end,
      source: "direct_url",
      referenceKind: "commit",
      repositoryFullName,
      itemNumber: null,
      commitIdentity,
      referenceIdentity: commitIdentity,
    });
    occupied.push([start, end]);
  }

  for (const match of text.matchAll(repositoryShorthandPattern)) {
    const leadingLength = match[0].length
      - `${match[1]}/${match[2]}#${match[3]}`.length;
    const start = match.index + leadingLength;
    const end = match.index + match[0].length;
    if (overlaps(occupied, start, end)) continue;
    const repositoryFullName = detectedRepository(match[1], match[2]);
    if (!repositoryFullName) continue;
    const itemIdentity = match[3]!;
    references.push({
      start,
      end,
      source: "repository_shorthand",
      referenceKind: "issue_or_pull_request",
      repositoryFullName,
      itemNumber: providerItemNumber(itemIdentity),
      commitIdentity: null,
      referenceIdentity: itemIdentity,
    });
    occupied.push([start, end]);
  }

  for (const match of text.matchAll(commitShorthandPattern)) {
    const leadingLength = match[0].length
      - `${match[1]}/${match[2]}@${match[3]}`.length;
    const start = match.index + leadingLength;
    const end = match.index + match[0].length;
    if (overlaps(occupied, start, end)) continue;
    const repositoryFullName = detectedRepository(match[1], match[2]);
    if (!repositoryFullName) continue;
    const commitIdentity = match[3]!.toLowerCase();
    if (!commitReferenceIdentityPattern.test(commitIdentity)) continue;
    references.push({
      start,
      end,
      source: "commit_shorthand",
      referenceKind: "commit",
      repositoryFullName,
      itemNumber: null,
      commitIdentity,
      referenceIdentity: commitIdentity,
    });
    occupied.push([start, end]);
  }

  return Object.freeze(references.sort((left, right) =>
    left.start - right.start || left.end - right.end
  ));
}

function detectedRepository(
  owner: string | undefined,
  repository: string | undefined,
): string | null {
  if (!owner || !repository) return null;
  let repositoryFullName: string;
  try {
    repositoryFullName = normalizeGitHubRepository(
      `${owner.toLowerCase()}/${repository.toLowerCase()}`,
    );
  } catch {
    return null;
  }
  assertRepositoryIdentityIsPublic(repositoryFullName);
  return repositoryFullName;
}

function providerItemNumber(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
      && parsed <= maximumProviderItemNumber
    ? parsed
    : null;
}

function overlaps(
  occupied: readonly (readonly [number, number])[],
  start: number,
  end: number,
): boolean {
  return occupied.some(([left, right]) => start < right && end > left);
}

function buildLineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return Object.freeze(starts);
}

function sourcePosition(
  text: string,
  lineStarts: readonly number[],
  index: number,
): Readonly<{ line: number; column: number }> {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle]! <= index) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  const lineStart = lineStarts[lineIndex]!;
  return Object.freeze({
    line: lineIndex + 1,
    column: [...text.slice(lineStart, index)].length + 1,
  });
}

function canonicalRepository(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError(`${label} is invalid`);
  }
  const repository = normalizeGitHubRepository(value);
  if (repository !== value) {
    throw new RangeError(`${label} must use canonical lowercase identity`);
  }
  assertRepositoryIdentityIsPublic(repository);
  return repository;
}

function assertRepositoryIdentityIsPublic(repositoryFullName: string): void {
  const [owner, repository] = repositoryFullName.split("/") as [string, string];
  if (
    realisticCredentialPattern.test(owner)
    || realisticCredentialPattern.test(repository)
    || realisticCredentialPattern.test(repositoryFullName)
  ) {
    throw new RangeError(
      "GitHub outbound repository identity is credential-shaped",
    );
  }
}

function outboundField(value: unknown): GitHubOutboundTextField {
  if (!allowedFields.has(value as GitHubOutboundTextField)) {
    throw new RangeError("GitHub outbound text field is unsupported");
  }
  return value as GitHubOutboundTextField;
}

function exactOutboundText(value: unknown): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximumTextBytes
    || unsafeTextPattern.test(value)
    || hasUnpairedSurrogate(value)
  ) {
    throw new RangeError("GitHub outbound text is invalid or exceeds its byte budget");
  }
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalPolicyId(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || !policyIdPattern.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function denseDataArray(
  value: unknown,
  label: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must use Array.prototype`);
  }
  if (value.length > maximum) {
    throw new RangeError(`${label} accepts at most ${maximum} entries`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) =>
    typeof key !== "string"
    || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key))
  )) {
    throw new TypeError(`${label} must contain only dense data entries`);
  }
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain only dense data entries`);
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  label: string,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) =>
    typeof key !== "string" || !(keys as readonly string[]).includes(key)
  )) {
    throw new TypeError(`${label} contains unknown fields`);
  }
  if (ownKeys.length !== keys.length) {
    throw new TypeError(`${label} is missing required fields`);
  }
  const output = Object.create(null) as DataRecord;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
