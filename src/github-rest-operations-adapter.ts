import type { GitHubInstallationTokenProvider } from "./github-app-installation-token.js";
import { receiverSafeFetch } from "./fetch-implementation.js";
import type {
  GitHubBranchTidyPlan,
  GitHubLandInspection,
  GitHubOperationsProvider,
} from "./github-operations.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { parseStrictJson } from "./strict-json.js";

export interface GitHubRestOperationsAdapterOptions {
  tokenProvider: GitHubInstallationTokenProvider;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const apiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;
const shaPattern = /^[a-f0-9]{40}$/;

export class GitHubRestOperationsAdapter implements GitHubOperationsProvider {
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: GitHubRestOperationsAdapterOptions) {
    this.#tokens = options.tokenProvider;
    this.#base = apiBase(options.apiBaseUrl ?? "https://api.github.com");
    this.#fetch = receiverSafeFetch(options.fetch);
    this.#now = options.now ?? Date.now;
  }

  async readBranchHead(repositoryFullName: string, branch: string): Promise<string> {
    const repository = normalizeGitHubRepository(repositoryFullName);
    const token = await this.#tokens.getInstallationToken({
      repositoryFullName: repository,
      permission: { name: "contents", access: "read" },
    });
    const response = await this.#json(
      "GET",
      `${repoPath(repository)}/git/ref/heads/${encodeURIComponent(canonicalBranch(branch))}`,
      token.token,
    );
    const body = record(response.payload, "branch reference");
    const object = record(body.object, "branch reference object");
    return providerSha(object.sha, "branch head SHA");
  }

  async planBranchTidy(input: {
    repositoryFullName: string;
    defaultBranch: string;
    defaultBranchSha: string;
    minimumAgeDays: number;
    maximumBranches: number;
  }): Promise<GitHubBranchTidyPlan> {
    const repository = normalizeGitHubRepository(input.repositoryFullName);
    const defaultBranch = canonicalBranch(input.defaultBranch);
    const defaultBranchSha = inputSha(input.defaultBranchSha, "default branch SHA");
    const minimumAgeDays = boundedInteger(input.minimumAgeDays, "minimum age days", 0, 3650);
    const maximumBranches = boundedInteger(input.maximumBranches, "maximum branches", 1, 50);
    const token = await this.#tokens.getInstallationToken({
      repositoryFullName: repository,
      permission: { name: "contents", access: "read" },
    });
    const pullToken = await this.#tokens.getInstallationToken({
      repositoryFullName: repository,
      permission: { name: "pull_requests", access: "read" },
    });
    const branches = await this.#pages(
      `${repoPath(repository)}/branches?per_page=100&page=1`,
      token.token,
      5,
      maximumBranches + 1,
    );
    const pulls = await this.#pages(
      `${repoPath(repository)}/pulls?state=open&per_page=100&page=1`,
      pullToken.token,
      5,
    );
    if (pulls.length > 500) throw new Error("GitHub branch tidy scan exceeds 500 open pull requests");
    const openByBranch = new Map<string, number[]>();
    for (const value of pulls) {
      const pull = record(value, "open pull request");
      const number = positiveInteger(pull.number, "pull request number");
      const head = record(pull.head, "pull request head");
      const repo = head.repo === null ? null : record(head.repo, "pull request head repository");
      if (!repo || normalizeGitHubRepository(exactText(repo.full_name, "repository", 140)) !== repository) continue;
      const ref = canonicalBranch(head.ref);
      const numbers = openByBranch.get(ref) ?? [];
      numbers.push(number);
      openByBranch.set(ref, numbers);
    }
    const candidates = branches
      .map((value) => branchRecord(value))
      .filter((branch) => branch.name !== defaultBranch)
      .slice(0, maximumBranches);
    const observedAt = timestamp(this.#now());
    const nowMs = Date.parse(observedAt);
    const evaluated: Array<GitHubBranchTidyPlan["candidates"][number]> = [];
    for (const branch of candidates) {
      const [comparisonResponse, commitResponse] = await Promise.all([
        this.#json(
          "GET",
          `${repoPath(repository)}/compare/${defaultBranchSha}...${branch.sha}`,
          token.token,
        ),
        this.#json("GET", `${repoPath(repository)}/commits/${branch.sha}`, token.token),
      ]);
      const comparison = record(comparisonResponse.payload, "branch comparison");
      const aheadBy = nonNegativeInteger(comparison.ahead_by, "ahead count");
      const behindBy = nonNegativeInteger(comparison.behind_by, "behind count");
      const commit = record(commitResponse.payload, "branch commit");
      const commitBody = record(commit.commit, "branch commit body");
      const committer = record(commitBody.committer, "branch commit committer");
      const headCommittedAt = providerTimestamp(committer.date, "branch commit time");
      const ageDays = Math.max(0, Math.floor((nowMs - Date.parse(headCommittedAt)) / 86_400_000));
      const openPullRequests = Object.freeze([...(openByBranch.get(branch.name) ?? [])].sort((a, b) => a - b));
      const reasons: string[] = [];
      if (branch.protected) reasons.push("protected_branch");
      if (openPullRequests.length > 0) reasons.push("open_pull_request");
      if (aheadBy > 0) reasons.push("unique_commits");
      if (ageDays < minimumAgeDays) reasons.push("too_recent");
      if (reasons.length === 0) reasons.push("merged_or_fully_contained");
      evaluated.push(Object.freeze({
        branch: branch.name,
        expectedSha: branch.sha,
        protected: branch.protected,
        openPullRequests,
        aheadBy,
        behindBy,
        headCommittedAt,
        ageDays,
        eligible: reasons.length === 1 && reasons[0] === "merged_or_fully_contained",
        reasons: Object.freeze(reasons),
        recovery: Object.freeze({ kind: "recreate_branch" as const, branch: branch.name, commitSha: branch.sha }),
      }));
    }
    evaluated.sort((left, right) =>
      left.branch < right.branch ? -1 : left.branch > right.branch ? 1 : 0
    );
    return Object.freeze({
      version: 1,
      repositoryFullName: repository,
      defaultBranch,
      defaultBranchSha,
      observedAt,
      minimumAgeDays,
      scannedBranchCount: branches.length,
      candidates: Object.freeze(evaluated),
      eligibleCount: evaluated.filter((entry) => entry.eligible).length,
      reviewCount: evaluated.filter((entry) => !entry.eligible).length,
      authorizesMutation: false,
    });
  }

  async inspectPullRequest(repositoryFullName: string, number: number): Promise<GitHubLandInspection> {
    const repository = normalizeGitHubRepository(repositoryFullName);
    const pullRequestNumber = boundedInteger(number, "pull request number", 1, 2_147_483_647);
    const token = await this.#tokens.getInstallationToken({
      repositoryFullName: repository,
      permission: { name: "pull_requests", access: "read" },
    });
    const response = await this.#json(
      "GET",
      `${repoPath(repository)}/pulls/${pullRequestNumber}`,
      token.token,
    );
    const pull = record(response.payload, "pull request");
    if (positiveInteger(pull.number, "pull request number") !== pullRequestNumber) {
      throw new Error("GitHub pull request identity did not match");
    }
    const base = record(pull.base, "pull request base");
    const head = record(pull.head, "pull request head");
    const baseRepo = record(base.repo, "pull request base repository");
    if (normalizeGitHubRepository(exactText(baseRepo.full_name, "repository", 140)) !== repository) {
      throw new Error("GitHub pull request repository did not match");
    }
    return Object.freeze({
      repositoryFullName: repository,
      number: pullRequestNumber,
      state: pull.state === "open" ? "open" : pull.state === "closed" ? "closed" : invalidState(),
      draft: boolean(pull.draft, "pull request draft"),
      merged: boolean(pull.merged, "pull request merged"),
      headRef: canonicalBranch(head.ref),
      headSha: providerSha(head.sha, "pull request head SHA"),
      baseRef: canonicalBranch(base.ref),
      baseSha: providerSha(base.sha, "pull request base SHA"),
      mergeable: pull.mergeable === null ? null : boolean(pull.mergeable, "pull request mergeable"),
      mergeableState: exactText(pull.mergeable_state, "pull request mergeable state", 64),
      mergeCommitSha: pull.merge_commit_sha === null
        ? null
        : providerSha(pull.merge_commit_sha, "pull request merge commit SHA"),
    });
  }

  async readMergeCommit(repositoryFullName: string, mergeCommitSha: string) {
    const repository = normalizeGitHubRepository(repositoryFullName);
    const commitSha = inputSha(mergeCommitSha, "merge commit SHA");
    const token = await this.#tokens.getInstallationToken({
      repositoryFullName: repository,
      permission: { name: "contents", access: "read" },
    });
    const response = await this.#json(
      "GET",
      `${repoPath(repository)}/git/commits/${commitSha}`,
      token.token,
    );
    const commit = record(response.payload, "merge commit");
    if (providerSha(commit.sha, "merge commit SHA") !== commitSha) {
      throw new Error("GitHub merge commit identity did not match");
    }
    if (!Array.isArray(commit.parents) || commit.parents.length < 1 || commit.parents.length > 2) {
      throw new Error("GitHub merge commit parents were invalid");
    }
    const parentShas = commit.parents.map((value) =>
      providerSha(record(value, "merge commit parent").sha, "merge commit parent SHA")
    );
    return Object.freeze({ commitSha, parentShas: Object.freeze(parentShas) });
  }

  async mergePullRequest(input: {
    repositoryFullName: string;
    number: number;
    expectedHeadSha: string;
    method: "merge" | "squash";
  }): Promise<{ mergeCommitSha: string; providerRequestId: string | null }> {
    const repository = normalizeGitHubRepository(input.repositoryFullName);
    const number = boundedInteger(input.number, "pull request number", 1, 2_147_483_647);
    const expectedHeadSha = inputSha(input.expectedHeadSha, "expected head SHA");
    const token = await this.#tokens.getInstallationToken({
      repositoryFullName: repository,
      permission: { name: "pull_requests", access: "write" },
    });
    const response = await this.#json(
      "PUT",
      `${repoPath(repository)}/pulls/${number}/merge`,
      token.token,
      { sha: expectedHeadSha, merge_method: input.method },
    );
    const result = record(response.payload, "pull request merge response");
    if (result.merged !== true) throw new Error("GitHub did not accept the pull request merge");
    return Object.freeze({
      mergeCommitSha: providerSha(result.sha, "merge commit SHA"),
      providerRequestId: response.requestId,
    });
  }

  async #pages(
    path: string,
    token: string,
    maximumPages: number,
    maximumItems?: number,
  ): Promise<unknown[]> {
    const output: unknown[] = [];
    let next: string | null = `${this.#base}/${path}`;
    const template = new URL(next);
    const visited = new Set<string>();
    for (let page = 1; next !== null; page += 1) {
      if (page > maximumPages || visited.has(next)) {
        throw new Error("GitHub operation pagination exceeded its bound");
      }
      visited.add(next);
      const response = await this.#requestUrl("GET", next, token);
      if (!Array.isArray(response.payload)) throw new Error("GitHub operation page was invalid");
      const linkedNext = nextLink(response.link, this.#base, template, page);
      if (maximumItems === undefined) {
        output.push(...response.payload);
      } else {
        const remaining = maximumItems - output.length;
        output.push(...response.payload.slice(0, Math.max(0, remaining)));
        if (output.length >= maximumItems) return output;
      }
      next = linkedNext;
    }
    return output;
  }

  #json(method: "GET" | "PUT", path: string, token: string, body?: unknown) {
    return this.#requestUrl(method, `${this.#base}/${path}`, token, body);
  }

  async #requestUrl(method: "GET" | "PUT", url: string, token: string, body?: unknown) {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": apiVersion,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("GitHub operation request failed before a response was available");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub operation provider returned HTTP ${response.status}`);
    }
    const mediaType = response.headers.get("content-type");
    if (mediaType && !mediaType.toLowerCase().includes("json")) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("GitHub operation provider returned an unsupported content type");
    }
    const payload = await boundedJson(response);
    return Object.freeze({
      payload,
      requestId: providerRequestId(response.headers.get("x-github-request-id")),
      link: response.headers.get("link"),
    });
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumResponseBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("GitHub operation response exceeded its byte bound");
  }
  if (!response.body) throw new Error("GitHub operation provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read().catch(() => {
        throw new Error("GitHub operation response stream failed");
      });
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        throw new Error("GitHub operation provider returned an invalid response stream");
      }
      total += item.value.byteLength;
      if (total > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("GitHub operation response exceeded its byte bound");
      }
      chunks.push(item.value.slice());
    }
  } finally {
    try { reader.releaseLock(); } catch { /* best-effort standard Response cleanup */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("GitHub operation response was not valid UTF-8");
  }
  return parseStrictJson(text, {
    maxBytes: maximumResponseBytes,
    maxDepth: 32,
    maxStringLength: 256 * 1024,
    maxObjectKeys: 512,
    maxArrayLength: 1_000,
    prefix: "GITHUB_OPERATION_RESPONSE",
  });
}

function branchRecord(value: unknown) {
  const branch = record(value, "branch");
  const commit = record(branch.commit, "branch commit");
  return Object.freeze({
    name: canonicalBranch(branch.name),
    sha: providerSha(commit.sha, "branch SHA"),
    protected: boolean(branch.protected, "branch protected flag"),
  });
}

function nextLink(
  value: string | null,
  base: string,
  template: URL,
  currentPage: number,
): string | null {
  if (!value) return null;
  const match = value.split(",").map((part) => part.trim())
    .map((part) => /^<([^>]+)>;\s*rel="([a-z]+)"$/.exec(part))
    .find((entry) => entry?.[2] === "next");
  if (!match) return null;
  const url = new URL(match[1]!);
  const root = new URL(base);
  if (url.protocol !== root.protocol || url.host !== root.host || url.username || url.password || url.hash) {
    throw new Error("GitHub operation pagination escaped the API origin");
  }
  const page = url.searchParams.get("page");
  if (
    url.pathname !== template.pathname
    || page === null
    || !/^\d+$/.test(page)
    || Number(page) !== currentPage + 1
    || url.searchParams.size !== template.searchParams.size
  ) throw new Error("GitHub operation pagination changed the accepted request");
  for (const [key, expected] of template.searchParams) {
    if (key !== "page" && url.searchParams.get(key) !== expected) {
      throw new Error("GitHub operation pagination changed the accepted request");
    }
  }
  return url.toString();
}

function repoPath(repository: string): string {
  const [owner, name] = repository.split("/");
  return `repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
}

function apiBase(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash) {
    throw new Error("GitHub operations API base URL is invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`GitHub ${label} was invalid`);
  return value as Record<string, unknown>;
}

function canonicalBranch(value: unknown): string {
  const branch = exactText(value, "branch", 512);
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("..") || branch.includes("@{")
    || /[~^:?*\[\\\u0000-\u001f\u007f]/u.test(branch)) {
    throw new Error("GitHub branch name was invalid");
  }
  return branch;
}

function inputSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new Error(`GitHub ${label} was invalid`);
  return value;
}

function providerSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Fa-f0-9]{40}$/.test(value)) throw new Error(`GitHub ${label} was invalid`);
  return value.toLowerCase();
}

function positiveInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`GitHub ${label} was invalid`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`GitHub ${label} was invalid`);
  return value;
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`GitHub ${label} was invalid`);
  return value;
}

function providerTimestamp(value: unknown, label: string): string {
  const text = exactText(value, label, 64);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`GitHub ${label} was invalid`);
  return new Date(milliseconds).toISOString();
}

function timestamp(value: number): string {
  if (!Number.isFinite(value)) throw new Error("GitHub operation time was invalid");
  return new Date(value).toISOString();
}

function providerRequestId(value: string | null): string | null {
  return value && /^[A-Za-z0-9:-]{1,240}$/.test(value) ? value : null;
}

function invalidState(): never {
  throw new Error("GitHub pull request state was invalid");
}
