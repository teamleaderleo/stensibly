import { sha256, stableJson } from "./canonical-json.js";
import {
  buildGitHubIssueContext,
  buildGitHubIssueReference,
  type GitHubIssueContext,
  type GitHubIssueContextInput,
} from "./github-issue-context.js";
import { normalizeRepositoryRemote } from "./project-contract.js";
import {
  GitHubProviderBindingError,
  type GitHubIssueComment,
  type GitHubIssueCommentInput,
} from "./github-provider-contracts.js";

export { sha256, stableJson };

const unsafeDisplayTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function buildScopedGitHubIssueContext(
  input: GitHubIssueContextInput,
  expectedRepositoryFullName: string,
): GitHubIssueContext {
  const context = buildGitHubIssueContext(input);
  const expected = normalizeGitHubRepository(expectedRepositoryFullName);
  if (context.reference.repositoryFullName !== expected) {
    throw new GitHubProviderBindingError(
      `GitHub provider returned ${context.reference.repositoryFullName} for bound repository ${expected}`,
    );
  }
  return context;
}

export function buildScopedGitHubIssueComment(
  input: GitHubIssueCommentInput,
  expectedRepositoryFullName: string,
  expectedIssueNumber: number,
): GitHubIssueComment {
  const repositoryFullName = normalizeGitHubRepository(expectedRepositoryFullName);
  const issueNumber = positiveInteger(expectedIssueNumber, "GitHub issue number");
  if (positiveInteger(input.issueNumber, "GitHub issue comment issue number") !== issueNumber) {
    throw new GitHubProviderBindingError(
      `GitHub provider returned a comment for issue ${input.issueNumber}, not ${issueNumber}`,
    );
  }
  const id = boundedText(input.id, "GitHub issue comment ID", 240);
  const canonicalUrl = canonicalCommentUrl(
    input.canonicalUrl,
    repositoryFullName,
    issueNumber,
    id,
  );
  const body = canonicalBody(input.body);
  return Object.freeze({
    id,
    issueNumber,
    canonicalUrl,
    createdAt: canonicalTimestamp(
      input.createdAt,
      "GitHub issue comment created time",
    ),
    updatedAt: canonicalTimestamp(
      input.updatedAt,
      "GitHub issue comment updated time",
    ),
    sourceRevision: boundedText(
      input.sourceRevision,
      "GitHub issue comment source revision",
      512,
    ),
    bodyRevision: {
      byteLength: Buffer.byteLength(body, "utf8"),
      sha256: sha256(body),
    },
    containsBody: false as const,
  });
}

export function normalizeGitHubRepository(value: string): string {
  const normalized = normalizeRepositoryRemote(value);
  if (!normalized || !/^[^/]+\/[^/]+$/.test(normalized)) {
    throw new RangeError("Use one canonical GitHub owner/repository identifier");
  }
  const [owner, repository] = normalized.split("/");
  return buildGitHubIssueReference({
    owner: owner!,
    repository: repository!,
    number: 1,
  }).repositoryFullName;
}

export function projectSlug(value: string): string {
  const project = boundedText(value, "Project slug", 80);
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(project)) {
    throw new RangeError("Use a lowercase project slug");
  }
  return project;
}

export function canonicalStringList(
  values: readonly string[],
  maximum: number,
  valueMaximum: number,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new RangeError(`GitHub provider list accepts at most ${maximum} values`);
  }
  const result = values.map((value) => boundedText(
    value,
    "GitHub provider list value",
    valueMaximum,
  ));
  if (new Set(result).size !== result.length) {
    throw new RangeError("GitHub provider list values must be unique");
  }
  return result.sort(codeUnitCompare);
}

export function canonicalLogins(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 100) {
    throw new RangeError("GitHub assignee list accepts at most 100 values");
  }
  const result = values.map((value) => {
    const login = boundedText(value, "GitHub login", 39).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login) || login.includes("--")) {
      throw new RangeError(`GitHub login is invalid: ${value}`);
    }
    return login;
  });
  if (new Set(result).size !== result.length) {
    throw new RangeError("GitHub assignees must be unique");
  }
  return result.sort(codeUnitCompare);
}

export function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError("GitHub issue page limit must be between 1 and 100");
  }
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

export function boundedText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  if (unsafeDisplayTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsafe characters`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || [...normalized].length > maximum) {
    throw new RangeError(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

export function boundedBody(
  value: string,
  label: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  const normalized = canonicalBody(value);
  if (!normalized.trim()) throw new RangeError(`${label} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new RangeError(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  if (/\u0000/.test(normalized)) throw new RangeError(`${label} contains NUL bytes`);
  return normalized;
}

export function canonicalBody(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function canonicalTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new RangeError(`${label} must be an ISO UTC timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function canonicalCommentUrl(
  value: string,
  repositoryFullName: string,
  issueNumber: number,
  commentId: string,
): string {
  const text = boundedText(value, "GitHub issue comment URL", 4_096);
  const url = new URL(text);
  const expectedPath = `/${repositoryFullName}/issues/${issueNumber}`;
  const expectedHash = `#issuecomment-${commentId}`;
  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "github.com"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.pathname.toLowerCase() !== expectedPath
    || url.hash !== expectedHash
  ) {
    throw new GitHubProviderBindingError(
      `GitHub provider returned a comment URL outside ${repositoryFullName}#${issueNumber}`,
    );
  }
  return `https://github.com${expectedPath}${expectedHash}`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
