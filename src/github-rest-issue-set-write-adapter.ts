import type { GitHubIssueContextInput } from "./github-issue-context.js";
import type {
  GitHubIssueProviderAdapter,
  GitHubIssueProviderPage,
} from "./github-provider-contracts.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import { GitHubProviderPostEffectError } from "./github-provider-post-effect-error.js";
import {
  discardGitHubProviderResponse,
  readBoundedGitHubProviderResponseText,
} from "./github-provider-bounded-response.js";
import {
  boundedText,
  canonicalLogins,
  canonicalStringList,
  normalizeGitHubRepository,
} from "./github-provider-validation.js";
import {
  GitHubRestIssueProviderAdapter,
} from "./github-rest-issue-adapter.js";
import {
  GitHubRestIssueWriteAdapter,
  type GitHubRestIssueWriteAdapterOptions,
} from "./github-rest-issue-write-adapter.js";

export interface GitHubRestIssueSetWriteAdapterOptions
  extends GitHubRestIssueWriteAdapterOptions {}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;
const maximumAssigneesPerMutation = 10;

/**
 * Extends the first typed issue writes with exact label and assignee
 * mutations. Mutation adapters are ephemeral and read adapters never execute
 * mutations, so process-local verification markers cannot cross operations.
 * The provider service owns final post-effect ambiguity classification.
 */
export class GitHubRestIssueSetWriteAdapter
  implements GitHubIssueProviderAdapter
{
  readonly #writeOptions: GitHubRestIssueWriteAdapterOptions;
  readonly #reads: GitHubRestIssueProviderAdapter;
  readonly #commentReads: GitHubRestIssueWriteAdapter;
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestIssueSetWriteAdapterOptions) {
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#writeOptions = Object.freeze({
      tokenProvider: options.tokenProvider,
      apiBaseUrl: this.#apiBaseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.#reads = new GitHubRestIssueProviderAdapter(this.#writeOptions);
    this.#commentReads = new GitHubRestIssueWriteAdapter(this.#writeOptions);
  }

  listIssues(
    input: Parameters<GitHubIssueProviderAdapter["listIssues"]>[0],
  ): Promise<GitHubIssueProviderPage> {
    return this.#reads.listIssues(input);
  }

  searchIssues(
    input: Parameters<GitHubIssueProviderAdapter["searchIssues"]>[0],
  ): Promise<GitHubIssueProviderPage> {
    return this.#reads.searchIssues(input);
  }

  getIssue(
    input: Parameters<GitHubIssueProviderAdapter["getIssue"]>[0],
  ): Promise<GitHubIssueContextInput> {
    return this.#reads.getIssue(input);
  }

  createIssue: GitHubIssueProviderAdapter["createIssue"] = (input) =>
    this.#mutationAdapter().createIssue(input);

  updateIssue: GitHubIssueProviderAdapter["updateIssue"] = (input) =>
    this.#mutationAdapter().updateIssue(input);

  addIssueComment: GitHubIssueProviderAdapter["addIssueComment"] = (input) =>
    this.#mutationAdapter().addIssueComment(input);

  getIssueComment: GitHubIssueProviderAdapter["getIssueComment"] = (input) =>
    this.#commentReads.getIssueComment(input);

  async addIssueLabels(
    input: Parameters<GitHubIssueProviderAdapter["addIssueLabels"]>[0],
  ) {
    const labels = canonicalStringList(input.labels, 100, 100);
    if (labels.length === 0) {
      throw new RangeError("GitHub issue label mutation requires at least one label");
    }
    const result = await this.#mutateIssueSet({
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      urlSuffix: "labels",
      method: "POST",
      body: { labels },
      operation: "add issue labels",
      admitResponse: (value) => {
        const actual = admitLabelResponse(value, "add issue labels");
        if (!labels.every((label) => actual.includes(label))) {
          throw ambiguousMutationResult("add issue labels");
        }
      },
    });
    return result;
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
      admitResponse: (value) => {
        const actual = admitLabelResponse(value, "remove issue label");
        if (actual.includes(label)) {
          throw ambiguousMutationResult("remove issue label");
        }
      },
    });
  }

  async addIssueAssignees(
    input: Parameters<GitHubIssueProviderAdapter["addIssueAssignees"]>[0],
  ) {
    const assignees = canonicalLogins(input.assignees);
    requireAssigneeMutationCount(assignees);
    return await this.#mutateIssueSet({
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      urlSuffix: "assignees",
      method: "POST",
      body: { assignees },
      operation: "add issue assignees",
      admitResponse: (value, repositoryFullName, issueNumber) => {
        const actual = admitAssigneeIssueResponse(
          value,
          repositoryFullName,
          issueNumber,
          this.#apiBaseUrl,
          "add issue assignees",
        );
        if (!assignees.every((login) => actual.includes(login))) {
          throw ambiguousMutationResult("add issue assignees");
        }
      },
    });
  }

  async removeIssueAssignees(
    input: Parameters<GitHubIssueProviderAdapter["removeIssueAssignees"]>[0],
  ) {
    const assignees = canonicalLogins(input.assignees);
    requireAssigneeMutationCount(assignees);
    return await this.#mutateIssueSet({
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      urlSuffix: "assignees",
      method: "DELETE",
      body: { assignees },
      operation: "remove issue assignees",
      admitResponse: (value, repositoryFullName, issueNumber) => {
        const actual = admitAssigneeIssueResponse(
          value,
          repositoryFullName,
          issueNumber,
          this.#apiBaseUrl,
          "remove issue assignees",
        );
        if (assignees.some((login) => actual.includes(login))) {
          throw ambiguousMutationResult("remove issue assignees");
        }
      },
    });
  }

  #mutationAdapter(): GitHubRestIssueWriteAdapter {
    return new GitHubRestIssueWriteAdapter(this.#writeOptions);
  }

  async #mutateIssueSet(input: {
    repositoryFullName: string;
    issueNumber: number;
    urlSuffix: string;
    method: "POST" | "DELETE";
    body?: Record<string, unknown>;
    operation: string;
    admitResponse: (
      value: unknown,
      repositoryFullName: string,
      issueNumber: number,
    ) => void;
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
    });
    admitMutationResponse(input.operation, response.requestId, () =>
      input.admitResponse(response.value, repositoryFullName, issueNumber)
    );

    let issue: GitHubIssueContextInput;
    try {
      issue = await this.#reads.getIssue({ repositoryFullName, issueNumber });
    } catch {
      throw new GitHubProviderPostEffectError(response.requestId);
    }
    return { issue, providerRequestId: response.requestId };
  }

  async #requestMutation(input: {
    repositoryFullName: string;
    url: URL;
    method: "POST" | "DELETE";
    body?: Record<string, unknown>;
    operation: string;
  }): Promise<{ requestId: string; value: unknown }> {
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

    const requestId = admittedRequestId(
      response.headers.get("x-github-request-id"),
    );
    if (!response.ok) {
      await discardGitHubProviderResponse(response);
      if (
        response.status >= 500
        || response.status === 408
        || response.status === 429
      ) {
        if (requestId) throw new GitHubProviderPostEffectError(requestId);
        throw ambiguousTransportError(input.operation);
      }
      throw new GitHubProviderRejectedError(
        "github_provider_request_rejected",
        `GitHub rejected ${input.operation}`,
      );
    }

    let text: string;
    try {
      text = await readBoundedGitHubProviderResponseText(
        response,
        maximumResponseBytes,
      );
    } catch {
      if (requestId) throw new GitHubProviderPostEffectError(requestId);
      throw ambiguousTransportError(input.operation);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      if (requestId) throw new GitHubProviderPostEffectError(requestId);
      throw ambiguousMutationResult(input.operation);
    }
    if (!requestId) throw ambiguousMutationResult(input.operation);
    return { requestId, value };
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

function requireAssigneeMutationCount(assignees: string[]): void {
  if (
    assignees.length === 0
    || assignees.length > maximumAssigneesPerMutation
  ) {
    throw new RangeError(
      "GitHub issue assignee mutation requires 1 to 10 unique assignees",
    );
  }
}

function admitLabelResponse(value: unknown, operation: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw ambiguousMutationResult(operation);
  }
  const labels = value.map((entry) => {
    if (typeof entry === "string") {
      return boundedResponseTextValue(entry, "GitHub label", 100, operation);
    }
    if (isRecord(entry)) {
      return boundedResponseTextValue(entry.name, "GitHub label", 100, operation);
    }
    throw ambiguousMutationResult(operation);
  });
  return canonicalStringList(labels, 100, 100);
}

function admitAssigneeIssueResponse(
  value: unknown,
  repositoryFullName: string,
  issueNumber: number,
  apiBaseUrl: string,
  operation: string,
): string[] {
  if (!isRecord(value) || value.pull_request !== undefined) {
    throw ambiguousMutationResult(operation);
  }
  if (value.number !== issueNumber) {
    throw ambiguousMutationResult(operation);
  }
  assertIssueRepository(
    value.repository_url,
    repositoryFullName,
    apiBaseUrl,
    operation,
  );
  if (!Array.isArray(value.assignees) || value.assignees.length > 100) {
    throw ambiguousMutationResult(operation);
  }
  const assignees = value.assignees.map((entry) => {
    if (!isRecord(entry)) throw ambiguousMutationResult(operation);
    return boundedResponseTextValue(
      entry.login,
      "GitHub assignee",
      39,
      operation,
    ).toLowerCase();
  });
  return canonicalLogins(assignees);
}

function assertIssueRepository(
  value: unknown,
  repositoryFullName: string,
  apiBaseUrl: string,
  operation: string,
): void {
  if (typeof value !== "string") throw ambiguousMutationResult(operation);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw ambiguousMutationResult(operation);
  }
  const base = new URL(apiBaseUrl);
  const [owner, repository] = repositoryParts(repositoryFullName);
  const expectedPath = `${base.pathname.replace(/\/$/, "")}/repos/${owner}/${repository}`;
  if (
    url.origin !== base.origin
    || url.pathname.toLowerCase() !== expectedPath.toLowerCase()
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw ambiguousMutationResult(operation);
  }
}

function admitMutationResponse(
  _operation: string,
  providerRequestId: string,
  admit: () => void,
): void {
  try {
    admit();
  } catch {
    throw new GitHubProviderPostEffectError(providerRequestId);
  }
}

function boundedResponseTextValue(
  value: unknown,
  label: string,
  maximum: number,
  operation: string,
): string {
  if (typeof value !== "string") throw ambiguousMutationResult(operation);
  try {
    return boundedText(value, label, maximum);
  } catch {
    throw ambiguousMutationResult(operation);
  }
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

function ambiguousTransportError(operation: string): Error {
  return new Error(`GitHub ${operation} outcome requires reconciliation`);
}

function ambiguousMutationResult(operation: string): Error {
  return new Error(
    `GitHub ${operation} succeeded without an admissible exact response; reconcile before retry`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
