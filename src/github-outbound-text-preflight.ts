import {
  compileGitHubOutboundTextPreflightV1 as compileBase,
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  type GitHubOutboundReferenceKind,
  type GitHubOutboundReferenceRule,
  type GitHubOutboundTextFindingV1,
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
const maximumFindings = 100;
const maximumProviderItemNumber = 2_147_483_647;

/**
 * Preserves the settled shorthand/direct detector while adding complete URL
 * candidate admission for authority and WHATWG-normalized route spellings.
 */
export function compileGitHubOutboundTextPreflightV1(
  value: unknown,
): GitHubOutboundTextPreflightResultV1 {
  const base = compileBase(value);
  const text = dataProperty(value, "text") as string;
  const policy = dataProperty(value, "policy");
  const disposition = dataProperty(policy, "externalReferenceDisposition") as
    | "reject"
    | "require_authority";
  const controlledValues = dataProperty(policy, "controlledRepositories") as
    readonly string[];
  const controlled = new Set(controlledValues);
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

    const raw = rawCanonicalUrlPattern.exec(candidate);
    const encodedRouteRepository = raw === null
      ? null
      : parseEncodedRouteRepository(parsed.pathname);
    if (
      encodedRouteRepository !== null
      && !controlled.has(encodedRouteRepository)
    ) {
      assertRepositoryIdentityIsPublic(encodedRouteRepository);
      if (
        parsed.username.length > 0
        || parsed.password.length > 0
        || parsed.port.length > 0
      ) {
        throw new RangeError(
          "GitHub outbound direct reference URL authority is invalid",
        );
      }
      throw new RangeError(
        "GitHub outbound direct reference contains percent-encoded path continuation",
      );
    }

    const route = parseNormalizedRoute(parsed.pathname);
    if (route === null || controlled.has(route.repositoryFullName)) continue;

    assertRepositoryIdentityIsPublic(route.repositoryFullName);
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

function parseEncodedRouteRepository(pathname: string): string | null {
  const rawSegments = pathname.split("/").slice(1);
  if (
    rawSegments.length !== 4
    || !rawSegments.some((segment) => encodedBytePattern.test(segment))
  ) return null;

  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const [owner, repository, kindValue] = segments as [
    string,
    string,
    string,
    string,
  ];
  const kind = kindValue.toLowerCase();
  if (
    kind !== "commit"
    && kind !== "issues"
    && kind !== "pull"
    && kind !== "discussions"
  ) return null;

  try {
    return normalizeGitHubRepository(
      `${owner.toLowerCase()}/${repository.toLowerCase()}`,
    );
  } catch {
    return null;
  }
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

function dataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
