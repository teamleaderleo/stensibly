import {
  compileGitHubOutboundTextPreflightV1 as compileBase,
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  type GitHubOutboundReferenceKind,
  type GitHubOutboundReferenceRule,
  type GitHubOutboundTextFindingV1,
  type GitHubOutboundTextPolicyV1,
  type GitHubOutboundTextPreflightInputV1,
  type GitHubOutboundTextPreflightResultV1,
} from "./github-outbound-text-preflight-base.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export { GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1 } from "./github-outbound-text-preflight-base.js";
export type {
  GitHubOutboundExternalReferenceDisposition,
  GitHubOutboundReferenceKind,
  GitHubOutboundReferenceRule,
  GitHubOutboundReferenceSource,
  GitHubOutboundTextField,
  GitHubOutboundTextFindingV1,
  GitHubOutboundTextPolicyV1,
  GitHubOutboundTextPreflightDecision,
  GitHubOutboundTextPreflightInputV1,
  GitHubOutboundTextPreflightResultV1,
} from "./github-outbound-text-preflight-base.js";

interface ParsedDirectReference {
  start: number;
  repositoryFullName: string;
  referenceKind: GitHubOutboundReferenceKind;
  itemNumber: number | null;
  commitIdentity: string | null;
  referenceIdentity: string;
}

const preflightInputKeys = [
  "schemaVersion",
  "policy",
  "repositoryFullName",
  "field",
  "text",
] as const;
const preflightPolicyKeys = [
  "version",
  "policyId",
  "controlledRepositories",
  "externalReferenceDisposition",
] as const;
const closingKeywordBeforeReferencePattern =
  /(?:^|[^\p{L}\p{N}\p{M}\p{Pc}])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:,*_~`-]*$/iu;
const candidateSchemePattern = /https?:/giu;
const rawCanonicalUrlPattern =
  /^(https?):\/\/((?:www\.)?github\.com\.?)(?::([0-9]+))?(\/[^?#]*)(?:[?#].*)?$/iu;
const encodedBytePattern = /%[0-9a-f]{2}/iu;
const itemIdentityPattern = /^[0-9]+$/u;
const commitIdentityPattern = /^[0-9a-f]{7,}$/iu;
const realisticCredentialPattern =
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;
const maximumCandidateCharacters = 4_096;
const maximumControlledRepositories = 32;
const maximumFindings = 100;
const maximumProviderItemNumber = 2_147_483_647;

type DataRecord = Record<string, unknown>;

/**
 * Preserves the settled shorthand/direct detector while adding complete URL
 * candidate admission for authority and WHATWG-normalized route spellings.
 */
export function compileGitHubOutboundTextPreflightV1(
  value: unknown,
): GitHubOutboundTextPreflightResultV1 {
  const snapshot = snapshotPreflightInput(value);
  const base = compileBase(snapshot);
  const text = snapshot.text;
  const disposition = snapshot.policy.externalReferenceDisposition;
  const controlled = new Set(snapshot.policy.controlledRepositories);
  const supplemental = detectNormalizedDirectReferences(text, controlled);
  if (supplemental.length === 0) return base;

  const lineStarts = buildLineStarts(text);
  const added = supplemental.map((reference) =>
    findingFromReference(
      base,
      text,
      lineStarts,
      reference,
      disposition === "require_authority",
    )
  );
  const findings = [...base.findings, ...added].sort((left, right) =>
    left.line - right.line || left.column - right.column
  );
  if (findings.length > maximumFindings) {
    throw new RangeError(
      `GitHub outbound text accepts at most ${maximumFindings} external references`,
    );
  }
  const decision = disposition === "require_authority"
    ? "requires_authority" as const
    : "reject" as const;
  const body = {
    version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policyId: base.policyId,
    policyFingerprint: base.policyFingerprint,
    repositoryFullName: base.repositoryFullName,
    field: base.field,
    textSha256: base.textSha256,
    textByteLength: base.textByteLength,
    textCharacterCount: base.textCharacterCount,
    decision,
    findings: Object.freeze(findings),
    inputFingerprint: base.inputFingerprint,
    authorizesProviderMutation: false as const,
    authorizesExternalInteraction: false as const,
    grantsAuthority: false as const,
  };
  return deepFreeze({
    ...body,
    resultFingerprint: fingerprintCanonicalRequest(body),
  });
}

function snapshotPreflightInput(
  value: unknown,
): GitHubOutboundTextPreflightInputV1 {
  const input = snapshotExactRecord(
    value,
    preflightInputKeys,
    "GitHub outbound text preflight input",
  );
  const policyInput = snapshotExactRecord(
    input.policy,
    preflightPolicyKeys,
    "GitHub outbound text policy",
  );
  const controlledRepositories = snapshotDenseDataArray(
    policyInput.controlledRepositories,
    "GitHub outbound controlled repositories",
    maximumControlledRepositories,
  );
  const policy = Object.freeze({
    version: policyInput.version,
    policyId: policyInput.policyId,
    controlledRepositories,
    externalReferenceDisposition: policyInput.externalReferenceDisposition,
  }) as unknown as GitHubOutboundTextPolicyV1;
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    policy,
    repositoryFullName: input.repositoryFullName,
    field: input.field,
    text: input.text,
  }) as unknown as GitHubOutboundTextPreflightInputV1;
}

function snapshotExactRecord<const K extends readonly string[]>(
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

function snapshotDenseDataArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must use Array.prototype`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new TypeError(`${label} must contain only dense data entries`);
  }
  const length = lengthDescriptor.value as number;
  if (length > maximum) {
    throw new RangeError(`${label} accepts at most ${maximum} entries`);
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain only dense data entries`);
    }
    entries.push(descriptor.value);
  }
  return Object.freeze(entries);
}

function detectNormalizedDirectReferences(
  text: string,
  controlled: ReadonlySet<string>,
): readonly ParsedDirectReference[] {
  const references: ParsedDirectReference[] = [];
  candidateSchemePattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = candidateSchemePattern.exec(text)) !== null) {
    const start = match.index;
    const candidate = extractCandidate(text, start);
    if (candidate.length === 0) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (!isGitHubHostname(parsed.hostname)) continue;
    const route = parseNormalizedRoute(parsed.pathname);
    if (route === null || controlled.has(route.repositoryFullName)) continue;

    assertRepositoryIdentityIsPublic(route.repositoryFullName);
    const raw = rawCanonicalUrlPattern.exec(candidate);
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.port.length > 0) {
      throw new RangeError(
        "GitHub outbound direct reference URL authority is invalid",
      );
    }
    if (route.containsEncodedIdentity) {
      throw new RangeError(
        "GitHub outbound direct reference contains percent-encoded path continuation",
      );
    }
    if (raw === null) {
      throw new RangeError(
        "GitHub outbound direct reference URL spelling is invalid",
      );
    }

    const rawScheme = raw[1]!.toLowerCase();
    const rawHost = raw[2]!;
    const rawPort = raw[3];
    const rawPath = raw[4]!;
    if (rawPath !== parsed.pathname) {
      throw new RangeError(
        "GitHub outbound direct reference URL spelling is invalid",
      );
    }
    if (
      rawPort !== undefined
      && !(
        (rawScheme === "https" && rawPort === "443")
        || (rawScheme === "http" && rawPort === "80")
      )
    ) {
      throw new RangeError(
        "GitHub outbound direct reference URL authority is invalid",
      );
    }

    if (rawPort === undefined && !rawHost.endsWith(".")) continue;
    references.push({
      start,
      repositoryFullName: route.repositoryFullName,
      referenceKind: route.referenceKind,
      itemNumber: route.itemNumber,
      commitIdentity: route.commitIdentity,
      referenceIdentity: route.referenceIdentity,
    });
    if (references.length > maximumFindings) {
      throw new RangeError(
        `GitHub outbound text accepts at most ${maximumFindings} external references`,
      );
    }
  }
  return Object.freeze(references);
}

function parseNormalizedRoute(pathname: string): Readonly<{
  repositoryFullName: string;
  referenceKind: GitHubOutboundReferenceKind;
  itemNumber: number | null;
  commitIdentity: string | null;
  referenceIdentity: string;
  containsEncodedIdentity: boolean;
}> | null {
  const rawSegments = pathname.split("/").slice(1);
  if (rawSegments.length !== 4) return null;
  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const [owner, repository, kindValue, identityValue] = segments as [
    string,
    string,
    string,
    string,
  ];
  const kind = kindValue.toLowerCase();
  let repositoryFullName: string;
  try {
    repositoryFullName = normalizeGitHubRepository(
      `${owner.toLowerCase()}/${repository.toLowerCase()}`,
    );
  } catch {
    return null;
  }
  const containsEncodedIdentity = rawSegments.some((segment) =>
    encodedBytePattern.test(segment)
  );

  if (kind === "commit") {
    if (!commitIdentityPattern.test(identityValue)) return null;
    const commitIdentity = identityValue.toLowerCase();
    return Object.freeze({
      repositoryFullName,
      referenceKind: "commit",
      itemNumber: null,
      commitIdentity,
      referenceIdentity: commitIdentity,
      containsEncodedIdentity,
    });
  }
  if (
    kind !== "issues"
    && kind !== "pull"
    && kind !== "discussions"
  ) return null;
  if (!itemIdentityPattern.test(identityValue)) return null;
  const itemNumber = providerItemNumber(identityValue);
  return Object.freeze({
    repositoryFullName,
    referenceKind: kind === "issues"
      ? "issue"
      : kind === "pull"
      ? "pull_request"
      : "discussion",
    itemNumber,
    commitIdentity: null,
    referenceIdentity: identityValue,
    containsEncodedIdentity,
  });
}

function findingFromReference(
  base: GitHubOutboundTextPreflightResultV1,
  text: string,
  lineStarts: readonly number[],
  reference: ParsedDirectReference,
  authorityRequired: boolean,
): GitHubOutboundTextFindingV1 {
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
    field: base.field,
    line: position.line,
    column: position.column,
    source: "direct_url" as const,
    referenceKind: reference.referenceKind,
    externalOwner,
    externalRepository,
    itemNumber: reference.itemNumber,
    commitPrefix: reference.commitIdentity?.slice(0, 4) ?? null,
    rule,
    authorityRequired,
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
}

function extractCandidate(text: string, start: number): string {
  let end = start;
  const limit = Math.min(text.length, start + maximumCandidateCharacters);
  while (end < limit) {
    const character = text[end]!;
    if (
      character === " "
      || character === '"'
      || character === "'"
      || character === "<"
      || character === ">"
      || character === "`"
      || character === "\u00a0"
    ) break;
    end += 1;
  }
  while (end > start && /[.,;!?)\]}]/u.test(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

function isGitHubHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return normalized === "github.com" || normalized === "www.github.com";
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

function providerItemNumber(value: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
      && parsed <= maximumProviderItemNumber
    ? parsed
    : null;
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
