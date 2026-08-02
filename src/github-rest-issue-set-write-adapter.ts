import type { GitHubIssueContextInput } from "./github-issue-context.js";
import type {
  GitHubIssueProviderAdapter,
  GitHubIssueProviderPage,
} from "./github-provider-contracts.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import {
  boundedText,
  canonicalLogins,
  canonicalStringList,
  normalizeGitHubRepository,
} from "./github-provider-validation.js";
import {
  GitHubRestIssueWriteAdapter,
  type GitHubRestIssueWriteAdapterOptions,
} from "./github-rest-issue-write-adapter.js";

export interface GitHubRestIssueSetWriteAdapterOptions
  extends GitHubRestIssueWriteAdapterOptions {}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;

/**
 * Extends the verified create/update/comment adapter with the four exact
 * label and assignee mutations. Mutation responses are admitted first, then
 * one independent issue read is required before returning. The service still
 * performs its own resulting-set readback; a failure there remains ambiguous.
 */
export class GitHubRestIssueSetWriteAdapter
  implements GitHubIssueProviderAdapter
{
  readonly #base: GitHubRestIssueWriteAdapter;
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #pendingIssueReadbacks = new Map<string, number>();

  constructor(options: GitHubRestIssueSetWriteAdapterOptions) {
    this.#base = new GitHubRestIssueWriteAdapter(options);
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  listIssues(
    input: Parameters<GitHubIssueProviderAdapter["listIssues"]>[0],
  ): Promise<GitHubIssueProviderPage> {
    return this.#base.listIssues(input);
  }

  searchIssues(
    input: Parameters<GitHubIssueProviderAdapter["searchIssues"]>[0],
  ): Promise<GitHubIssueProviderPage> {
    return this.#base.searchIssues(input);
  }

  async getIssue(
    input: Parameters<GitHubIssueProviderAdapter["getIssue"]>[0],
  ): Promise<GitHubIssueContextInput> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInteger(input.issueNumber, "GitHub issue number");
    const postMutation = consumePending(
      this.#pendingIssueReadbacks,
      issueReadbackKey(repositoryFullName, issueNumber),
    );
    try {
      return await this.#base.getIssue({ repositoryFullName, issueNumber });
    } catch (error) {
      if (postMutation) throw ambiguousVerificationError();
      throw error;
    }
  }

  createIssue: GitHubIssueProviderAdapter["createIssue"] = (input) =>
    this.#base.createIssue(input);

  updateIssue: GitHubIssueProviderAdapter["updateIssue"] = (input) =>
    this.#base.updateIssue(input);

  addIssueComment: GitHubIssueProviderAdapter["addIssueComment"] = (input) =>
    this.#base.addIssueComment(input);

  getIssueComment: GitHubIssueProviderAdapter["getIssueComment"] = (input) =>
    this.#base.getIssueComment(input);

  async addIssueLabels(
    input: Parameters<GitHubIssueProviderAdapter["addIssueLabels"]>[0],
  ) {
    const labels = canonicalStringList(input.labels, 100, 100);
    if (labels.length === 0) {
      throw new RangeError("GitHub issue label mutation requires at least one label");
    }
    return await this.#mutateIssueSet({
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      urlSuffix: "labels",
      method: "POST",
      body: { labels },
      operation: "add issue labels",
      expectedShape: "array",
    });
  }

  async removeIssueLabel(
    input: Parameters<GitHubIssueProviderAdapter["removeIssueLabel"]>[0],
  ) {
    const label = boundedText(input.label, "GitHub issue label", 100);
    return await this.#mutateIssueSet({
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      urlSuffix: `labels/${encodeURIComponent(label)}`,
      method: "DELETE",
      operation: "remove issue label",
      expectedShape: "array",
    });
  }

  async addIssueAssignees(
    input: Parameters<GitHubIssueProviderAdapter["addIssueAssignees"]>[0],
  ) {
    const assignees = canonicalLogins(input.assignees);
    if (assignees.length === 0) {
      throw new RangeError(
        "GitHub issue assignee mutation requires at least one assignee",
      );
    }
    return await this.#mutateIssueSet({
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      urlSuffix: "assignees",
      method: "POST",
      body: { assignees },
      operation: "add issue assignees",
      expectedShape: "record",
    });
  }

  async removeIssueAssignees(
    input: Parameters<GitHubIssueProviderAdapter["removeIssueAssignees"]>[0],
  ) {
    const assignees = canonicalLogins(input.assignees);
    if (assignees.length === 0) {
      throw new RangeError(
        "GitHub issue assignee mutation requires at least one assignee",
      );
    }
    return await this.#mutateIssueSet({
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      urlSuffix: "assignees",
      method: "DELETE",
      body: { assignees },
      operation: "remove issue assignees",
      expectedShape: "record",
    });
  }

  async #mutateIssueSet(input: {
    repositoryFullName: string;
    issueNumber: number;
    urlSuffix: string;
    method: "POST" | "DELETE";
    body?: Record<string, unknown>;
    operation: string;
    expectedShape: "array" | "record";
  }): Promise<{ issue: GitHubIssueContextInput; providerRequestId: string }> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInteger(input.issueNumber, "GitHub issue number");
    const response = await this.#requestMutation({
      repositoryFullName,
      url: new URL(
        `${issueUrl(this.#apiBaseUrl, repositoryFullName, issueNumber)}/${input.urlSuffix}`,
      ),
      method: input.method,
      ...(input.body ? { body: input.body } : {}),
      operation: input.operation,
      expectedShape: input.expectedShape,
    });

    let issue: GitHubIssueContextInput;
    try {
      issue = await this.#base.getIssue({ repositoryFullName, issueNumber });
    } catch {
      throw ambiguousVerificationError();
    }
    markPending(
      this.#pendingIssueReadbacks,
      issueReadbackKey(repositoryFullName, issueNumber),
    );
    return { issue, providerRequestId: response.requestId };
  }

  async #requestMutation(input: {
    repositoryFullName: string;
    url: URL;
    method: "POST" | "DELETE";
    body?: Record<string, unknown>;
    operation: string;
    expectedShape: "array" | "record";
  }): Promise<{ requestId: string }> {
    const credential = await this.#tokens.getInstallationToken({
      repositoryFullName: input.repositoryFullName,
      issues: "write",
    });
    let response: Response;
    try {
      response = await this.#fetch(input.url, {
        method: input.method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential.token}`,
          ...(input.body ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": githubApiVersion,
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      });
    } catch {
      throw ambiguousTransportError(input.operation);
    }

    const text = await boundedResponseText(response, input.operation);
    if (!response.ok) {
      if (
        response.status >= 500
        || response.status === 408
        || response.status === 429
      ) {
        throw ambiguousTransportError(input.operation);
      }
      throw new GitHubProviderRejectedError(
        "github_provider_request_rejected",
        `GitHub rejected ${input.operation}`,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw ambiguousMutationResult(input.operation);
    }
    if (
      (input.expectedShape === "array" && !Array.isArray(value))
      || (input.expectedShape === "record" && !isRecord(value))
    ) {
      throw ambiguousMutationResult(input.operation);
    }
    const requestId = admittedRequestId(
      response.headers.get("x-github-request-id"),
    );
    if (!requestId) throw ambiguousMutationResult(input.operation);
    return { requestId };
  }
}

function issueCollectionUrl(apiBaseUrl: string, repositoryFullName: string): URL {
  const [owner, repository] = repositoryParts(repositoryFullName);
  return new URL(
    `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`,
  );
}

function issueUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  issueNumber: number,
): URL {
  return new URL(`${issueCollectionUrl(apiBaseUrl, repositoryFullName)}/${issueNumber}`);
}

async function boundedResponseText(
  response: Response,
  operation: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maximumResponseBytes) {
      throw ambiguousTransportError(operation);
    }
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw ambiguousTransportError(operation);
  }
  if (Buffer.byteLength(text, "utf8") > maximumResponseBytes) {
    throw ambiguousTransportError(operation);
  }
  return text;
}

function admittedRequestId(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
    ? normalized
    : null;
}

function normalizedApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub API base URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("GitHub API base URL is invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function repositoryParts(repositoryFullName: string): [string, string] {
  const [owner, repository] = repositoryFullName.split("/");
  if (!owner || !repository) {
    throw new RangeError("Use a GitHub owner/repository identifier");
  }
  return [owner, repository];
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function markPending(store: Map<string, number>, key: string): void {
  store.set(key, (store.get(key) ?? 0) + 1);
}

function consumePending(store: Map<string, number>, key: string): boolean {
  const count = store.get(key) ?? 0;
  if (count === 0) return false;
  if (count === 1) store.delete(key);
  else store.set(key, count - 1);
  return true;
}

function issueReadbackKey(
  repositoryFullName: string,
  issueNumber: number,
): string {
  return `${repositoryFullName}#${issueNumber}`;
}

function ambiguousTransportError(operation: string): Error {
  return new Error(`GitHub ${operation} outcome requires reconciliation`);
}

function ambiguousMutationResult(operation: string): Error {
  return new Error(
    `GitHub ${operation} succeeded without an admissible exact response; reconcile before retry`,
  );
}

function ambiguousVerificationError(): Error {
  return new Error(
    "GitHub issue readback could not confirm the mutation; reconcile before retry",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
