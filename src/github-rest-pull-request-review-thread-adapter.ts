import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import {
  parseGitHubDelegatedReadArguments,
} from "./github-delegated-read-contracts.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import {
  GitHubRestPullRequestDiffAdapter,
  type GitHubRestPullRequestDiffAdapterOptions,
} from "./github-rest-pull-request-diff-adapter.js";
import { parseStrictJson } from "./strict-json.js";

export interface GitHubRestPullRequestReviewThreadAdapterOptions
  extends GitHubRestPullRequestDiffAdapterOptions {}

interface AdmittedReviewThreadCall {
  arguments: Readonly<{ pr_number: number }>;
  repositoryFullName: string;
}

interface ProviderPage {
  payload: unknown;
  providerRequestId?: string;
}

interface ParsedPage {
  totalCount: number;
  threads: readonly Readonly<Record<string, unknown>>[];
  hasNextPage: boolean;
  endCursor: string | null;
  commentCount: number;
}

const githubApiVersion = "2022-11-28";
const threadPageSize = 25;
const commentPageSize = 20;
const maximumThreadPages = 4;
const maximumThreads = threadPageSize * maximumThreadPages;
const maximumComments = 400;
const providerResponseMaximumBytes = 256 * 1024;
const delegatedResultMaximumBytes = 256 * 1024;
const maximumReviewBodyCharacters = 16 * 1024;
const unsafeTextPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const credentialShapedPublicIdentityPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+|gh[pousr]_|github_pat_|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_|xox[baprs]-|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;
const credentialShapedRetainedContentPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+[A-Za-z0-9._~+\/-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?=$|[\s:./=,;'"()\[\]{}@#_-])/imu;
const urlPattern = /https?:\/\/[^\s<>()\[\]{}]+/giu;

const reviewThreadQuery = `query PullRequestReviewThreads(
  $owner: String!
  $repository: String!
  $number: Int!
  $threadFirst: Int!
  $threadAfter: String
  $commentFirst: Int!
) {
  repository(owner: $owner, name: $repository) {
    nameWithOwner
    pullRequest(number: $number) {
      number
      reviewThreads(first: $threadFirst, after: $threadAfter) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          startDiffSide
          resolvedBy {
            login
          }
          comments(first: $commentFirst) {
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              bodyText
              createdAt
              updatedAt
              author {
                login
              }
              replyTo {
                id
              }
              pullRequestReview {
                id
                state
                submittedAt
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Additive native GraphQL extension for bounded pull-request review-thread reads.
 * Repository, immutable-file, PR metadata, and PR diff/patch calls remain owned by
 * the inherited adapters.
 */
export class GitHubRestPullRequestReviewThreadAdapter
  extends GitHubRestPullRequestDiffAdapter
{
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #graphqlUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestPullRequestReviewThreadAdapterOptions) {
    super(options);
    this.#connectionId = exactIdentity(
      options.connectionId,
      "GitHub delegated connection ID",
      240,
    );
    this.#installationId = exactIdentity(
      options.installationId,
      "GitHub delegated installation ID",
      64,
    );
    this.#credentialRef = exactCredentialReference(options.credentialRef);
    this.#tokenProvider = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#graphqlUrl = graphqlEndpoint(this.#apiBaseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  override async callReadTool(
    input: Parameters<GitHubDelegatedReadAdapter["callReadTool"]>[0],
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const envelope = exactDataRecord(
      input,
      [
        "tool",
        "arguments",
        "repositoryFullName",
        "connectionId",
        "installationId",
        "credentialRef",
        "catalogueFingerprint",
      ],
      [
        "tool",
        "arguments",
        "repositoryFullName",
        "connectionId",
        "installationId",
        "credentialRef",
        "catalogueFingerprint",
      ],
      "GitHub delegated adapter call",
    );

    if (envelope.tool !== "list_pull_request_review_threads") {
      return super.callReadTool({
        tool: envelope.tool as string,
        arguments: envelope.arguments as Record<string, unknown>,
        repositoryFullName: envelope.repositoryFullName as string,
        connectionId: envelope.connectionId as string,
        installationId: envelope.installationId as string,
        credentialRef: envelope.credentialRef as string,
        catalogueFingerprint: envelope.catalogueFingerprint as string,
      });
    }

    const admitted = this.#admitReviewThreadCall(envelope);
    const token = await this.#tokenProvider.getInstallationToken({
      repositoryFullName: admitted.repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    });
    return this.#listReviewThreads(admitted, token.token);
  }

  #admitReviewThreadCall(
    envelope: Record<string, unknown>,
  ): AdmittedReviewThreadCall {
    if (
      envelope.connectionId !== this.#connectionId
      || envelope.installationId !== this.#installationId
      || envelope.credentialRef !== this.#credentialRef
    ) {
      throw rejected(
        "github_delegated_adapter_binding_mismatch",
        "GitHub delegated adapter call did not match its admitted connection binding",
      );
    }
    const repositoryFullName = exactRepository(envelope.repositoryFullName);
    exactFingerprint(envelope.catalogueFingerprint);

    let parsed: Record<string, unknown>;
    try {
      parsed = parseGitHubDelegatedReadArguments(
        "list_pull_request_review_threads",
        envelope.arguments,
      );
    } catch {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        "GitHub delegated review-thread arguments were invalid",
      );
    }
    return Object.freeze({
      repositoryFullName,
      arguments: Object.freeze({
        pr_number: positiveInputInteger(
          parsed.pr_number,
          "GitHub pull request number",
        ),
      }),
    });
  }

  async #listReviewThreads(
    admitted: AdmittedReviewThreadCall,
    token: string,
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const threads: Readonly<Record<string, unknown>>[] = [];
    const threadIds = new Set<string>();
    const commentIds = new Set<string>();
    const seenCursors = new Set<string>();
    const providerRequestIds: string[] = [];
    let expectedTotal: number | undefined;
    let after: string | null = null;
    let pageCount = 0;
    let commentCount = 0;

    while (true) {
      if (pageCount >= maximumThreadPages) {
        throw rejected(
          "github_delegated_provider_result_too_large",
          `GitHub delegated review threads exceed ${maximumThreadPages} pages`,
        );
      }
      const provider = await this.#postGraphqlPage(
        admitted,
        token,
        after,
      );
      pageCount += 1;
      if (provider.providerRequestId) {
        providerRequestIds.push(provider.providerRequestId);
      }
      const page = parseReviewThreadPage(
        provider.payload,
        admitted.repositoryFullName,
        admitted.arguments.pr_number,
        threadIds,
        commentIds,
      );
      expectedTotal ??= page.totalCount;
      if (page.totalCount !== expectedTotal) {
        throw rejected(
          "github_delegated_provider_invalid_response",
          "GitHub delegated review-thread totals changed across pages",
        );
      }
      threads.push(...page.threads);
      commentCount += page.commentCount;
      if (threads.length > maximumThreads || commentCount > maximumComments) {
        throw rejected(
          "github_delegated_provider_result_too_large",
          "GitHub delegated review-thread result exceeds its entry budget",
        );
      }
      if (!page.hasNextPage) break;
      if (!page.endCursor || seenCursors.has(page.endCursor)) {
        throw rejected(
          "github_delegated_provider_invalid_response",
          "GitHub delegated review-thread pagination cursor was invalid",
        );
      }
      seenCursors.add(page.endCursor);
      after = page.endCursor;
    }

    if (threads.length !== expectedTotal) {
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated review-thread count did not match provider pagination",
      );
    }

    const result = Object.freeze({
      repositoryFullName: admitted.repositoryFullName,
      number: admitted.arguments.pr_number,
      threadCount: threads.length,
      commentCount,
      pageCount,
      providerRequestIds: Object.freeze([...providerRequestIds]),
      threads: Object.freeze([...threads]),
    });
    if (Buffer.byteLength(stableJson(result), "utf8") > delegatedResultMaximumBytes) {
      throw rejected(
        "github_delegated_provider_result_too_large",
        "GitHub delegated review-thread result exceeds the retained result budget",
      );
    }
    return Object.freeze({
      result,
      ...(providerRequestIds[0]
        ? { providerRequestId: providerRequestIds[0] }
        : {}),
    });
  }

  async #postGraphqlPage(
    admitted: AdmittedReviewThreadCall,
    token: string,
    after: string | null,
  ): Promise<ProviderPage> {
    const [owner, repository] = admitted.repositoryFullName.split("/") as [
      string,
      string,
    ];
    const body = JSON.stringify({
      operationName: "PullRequestReviewThreads",
      query: reviewThreadQuery,
      variables: {
        owner,
        repository,
        number: admitted.arguments.pr_number,
        threadFirst: threadPageSize,
        threadAfter: after,
        commentFirst: commentPageSize,
      },
    });

    let response: Response;
    try {
      response = await this.#fetch(this.#graphqlUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": githubApiVersion,
        },
        body,
        redirect: "error",
      });
    } catch {
      throw rejected(
        "github_delegated_provider_request_failed",
        "GitHub delegated provider request failed before a response was available",
      );
    }

    if (response.status !== 200) {
      await discardResponseBody(response);
      if (!response.ok) throw providerHttpError(response.status);
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated provider did not return an exact complete response",
      );
    }
    if (response.redirected || response.url !== this.#graphqlUrl) {
      await discardResponseBody(response);
      throw rejected(
        "github_delegated_provider_identity_mismatch",
        "GitHub delegated GraphQL response did not match the accepted endpoint",
      );
    }
    if (!jsonContentType(response.headers.get("content-type"))) {
      await discardResponseBody(response);
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated provider returned an unsupported GraphQL content type",
      );
    }

    let providerRequestId: string | undefined;
    try {
      providerRequestId = providerRequestIdentity(
        response.headers.get("x-github-request-id"),
      );
    } catch (error) {
      await discardResponseBody(response);
      throw error;
    }
    const payload = await readBoundedJson(
      response,
      providerResponseMaximumBytes,
    );
    return Object.freeze({
      payload,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
  }
}

function parseReviewThreadPage(
  value: unknown,
  repositoryFullName: string,
  pullRequestNumber: number,
  threadIds: Set<string>,
  commentIds: Set<string>,
): ParsedPage {
  const root = providerRecord(
    value,
    ["data", "errors", "extensions"],
    ["data"],
    "GitHub GraphQL response",
  );
  if (root.errors !== undefined) {
    const errors = denseArray(root.errors, "GitHub GraphQL errors", 20);
    if (errors.length > 0) {
      throw rejected(
        "github_delegated_provider_rejected",
        "GitHub delegated GraphQL request was rejected",
      );
    }
  }
  const data = providerRecord(
    root.data,
    ["repository"],
    ["repository"],
    "GitHub GraphQL data",
  );
  if (data.repository === null) throw resourceAbsent();
  const repository = providerRecord(
    data.repository,
    ["nameWithOwner", "pullRequest"],
    ["nameWithOwner", "pullRequest"],
    "GitHub GraphQL repository",
  );
  if (exactRepository(repository.nameWithOwner) !== repositoryFullName) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated GraphQL repository did not match the accepted repository",
    );
  }
  if (repository.pullRequest === null) throw resourceAbsent();
  const pullRequest = providerRecord(
    repository.pullRequest,
    ["number", "reviewThreads"],
    ["number", "reviewThreads"],
    "GitHub GraphQL pull request",
  );
  if (
    positiveProviderInteger(
      pullRequest.number,
      "GitHub pull request number",
    ) !== pullRequestNumber
  ) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated GraphQL response did not match the requested pull request",
    );
  }
  const connection = providerRecord(
    pullRequest.reviewThreads,
    ["totalCount", "pageInfo", "nodes"],
    ["totalCount", "pageInfo", "nodes"],
    "GitHub review-thread connection",
  );
  const totalCount = nonNegativeProviderInteger(
    connection.totalCount,
    "GitHub review-thread total count",
  );
  if (totalCount > maximumThreads) {
    throw rejected(
      "github_delegated_provider_result_too_large",
      `GitHub delegated review threads exceed ${maximumThreads} entries`,
    );
  }
  const pageInfo = providerRecord(
    connection.pageInfo,
    ["hasNextPage", "endCursor"],
    ["hasNextPage", "endCursor"],
    "GitHub review-thread page info",
  );
  const hasNextPage = booleanValue(
    pageInfo.hasNextPage,
    "GitHub review-thread next-page flag",
  );
  const endCursor = nullableCursor(pageInfo.endCursor);
  if (hasNextPage && !endCursor) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated review-thread pagination cursor was absent",
    );
  }

  const nodes = denseArray(
    connection.nodes,
    "GitHub review-thread nodes",
    threadPageSize,
  );
  if (hasNextPage && nodes.length === 0) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated review-thread page was empty before completion",
    );
  }
  const threads: Readonly<Record<string, unknown>>[] = [];
  let commentCount = 0;
  for (const node of nodes) {
    const parsed = reviewThread(node, threadIds, commentIds);
    commentCount += (parsed.comments as readonly unknown[]).length;
    threads.push(parsed);
  }
  return Object.freeze({
    totalCount,
    threads: Object.freeze(threads),
    hasNextPage,
    endCursor,
    commentCount,
  });
}

function reviewThread(
  value: unknown,
  threadIds: Set<string>,
  commentIds: Set<string>,
): Readonly<Record<string, unknown>> {
  const record = providerRecord(
    value,
    [
      "id",
      "isResolved",
      "isOutdated",
      "path",
      "line",
      "originalLine",
      "startLine",
      "originalStartLine",
      "diffSide",
      "startDiffSide",
      "resolvedBy",
      "comments",
    ],
    [
      "id",
      "isResolved",
      "isOutdated",
      "path",
      "line",
      "originalLine",
      "startLine",
      "originalStartLine",
      "diffSide",
      "startDiffSide",
      "resolvedBy",
      "comments",
    ],
    "GitHub review thread",
  );
  const id = uniqueNodeId(record.id, threadIds, "GitHub review-thread ID");
  const resolved = booleanValue(
    record.isResolved,
    "GitHub review-thread resolved flag",
  );
  const outdated = booleanValue(
    record.isOutdated,
    "GitHub review-thread outdated flag",
  );
  const resolvedByLogin = nullableActorLogin(record.resolvedBy);
  if (resolved !== (resolvedByLogin !== null)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub review-thread resolution identity was inconsistent",
    );
  }
  const line = nullablePositiveInteger(
    record.line,
    "GitHub review-thread line",
  );
  const originalLine = nullablePositiveInteger(
    record.originalLine,
    "GitHub review-thread original line",
  );
  const startLine = nullablePositiveInteger(
    record.startLine,
    "GitHub review-thread start line",
  );
  const originalStartLine = nullablePositiveInteger(
    record.originalStartLine,
    "GitHub review-thread original start line",
  );
  const side = diffSide(record.diffSide, "GitHub review-thread side");
  const startSide = nullableDiffSide(
    record.startDiffSide,
    "GitHub review-thread start side",
  );
  if ((startLine === null) !== (startSide === null)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub review-thread start coordinates were inconsistent",
    );
  }
  if (startLine !== null && line !== null && startLine > line) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub review-thread line range was reversed",
    );
  }
  if (
    originalStartLine !== null
    && originalLine !== null
    && originalStartLine > originalLine
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub review-thread original line range was reversed",
    );
  }

  const commentsConnection = providerRecord(
    record.comments,
    ["totalCount", "pageInfo", "nodes"],
    ["totalCount", "pageInfo", "nodes"],
    "GitHub review-thread comments",
  );
  const commentsTotal = nonNegativeProviderInteger(
    commentsConnection.totalCount,
    "GitHub review-thread comment count",
  );
  if (commentsTotal > commentPageSize) {
    throw rejected(
      "github_delegated_provider_result_too_large",
      `GitHub delegated review-thread comments exceed ${commentPageSize} entries per thread`,
    );
  }
  const commentsPageInfo = providerRecord(
    commentsConnection.pageInfo,
    ["hasNextPage", "endCursor"],
    ["hasNextPage", "endCursor"],
    "GitHub review-thread comment page info",
  );
  if (
    booleanValue(
      commentsPageInfo.hasNextPage,
      "GitHub review-thread comment next-page flag",
    )
  ) {
    throw rejected(
      "github_delegated_provider_result_too_large",
      "GitHub delegated nested review-thread comment pagination is unsupported",
    );
  }
  nullableCursor(commentsPageInfo.endCursor);
  const commentNodes = denseArray(
    commentsConnection.nodes,
    "GitHub review-thread comment nodes",
    commentPageSize,
  );
  if (commentNodes.length !== commentsTotal) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub review-thread comment count did not match its nodes",
    );
  }
  const comments = commentNodes.map((comment) =>
    reviewComment(comment, commentIds)
  );

  return Object.freeze({
    id,
    resolved,
    outdated,
    path: repositoryFilePath(record.path),
    line,
    originalLine,
    startLine,
    originalStartLine,
    side,
    startSide,
    resolvedByLogin,
    comments: Object.freeze(comments),
  });
}

function reviewComment(
  value: unknown,
  commentIds: Set<string>,
): Readonly<Record<string, unknown>> {
  const record = providerRecord(
    value,
    [
      "id",
      "bodyText",
      "createdAt",
      "updatedAt",
      "author",
      "replyTo",
      "pullRequestReview",
    ],
    [
      "id",
      "bodyText",
      "createdAt",
      "updatedAt",
      "author",
      "replyTo",
      "pullRequestReview",
    ],
    "GitHub review-thread comment",
  );
  const id = uniqueNodeId(record.id, commentIds, "GitHub review comment ID");
  const body = minimizedReviewBody(record.bodyText);
  const createdAt = exactTimestamp(
    record.createdAt,
    "GitHub review comment created timestamp",
  );
  const updatedAt = exactTimestamp(
    record.updatedAt,
    "GitHub review comment updated timestamp",
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub review comment timestamps were reversed",
    );
  }
  return Object.freeze({
    id,
    authorLogin: nullableActorLogin(record.author),
    body: body.text,
    bodySha256: body.digest,
    bodyCharacterCount: body.characterCount,
    bodyWasMinimized: body.minimized,
    createdAt,
    updatedAt,
    replyToId: nullableNodeReference(record.replyTo, "GitHub review reply identity"),
    review: nullableReview(record.pullRequestReview),
  });
}

function nullableReview(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  const record = providerRecord(
    value,
    ["id", "state", "submittedAt", "author"],
    ["id", "state", "submittedAt", "author"],
    "GitHub pull request review",
  );
  const state = reviewState(record.state);
  const submittedAt = nullableTimestamp(
    record.submittedAt,
    "GitHub pull request review submitted timestamp",
  );
  if (state === "PENDING" && submittedAt !== null) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub pending review carried a submitted timestamp",
    );
  }
  return Object.freeze({
    id: nodeId(record.id, "GitHub pull request review ID"),
    state,
    submittedAt,
    authorLogin: nullableActorLogin(record.author),
  });
}

function minimizedReviewBody(value: unknown): Readonly<{
  text: string;
  digest: string;
  characterCount: number;
  minimized: boolean;
}> {
  if (typeof value !== "string" || value.length === 0) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub review comment body was invalid",
    );
  }
  const characterCount = [...value].length;
  if (
    characterCount > maximumReviewBodyCharacters
    || Buffer.byteLength(value, "utf8") > maximumReviewBodyCharacters * 4
    || unsafeTextPattern.test(value)
    || credentialShapedRetainedContentPattern.test(value)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub review comment body was unsafe to retain",
    );
  }
  const text = value.replace(urlPattern, "[url omitted]");
  return Object.freeze({
    text,
    digest: sha256(value),
    characterCount,
    minimized: text !== value,
  });
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      await discardResponseBody(response);
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated GraphQL response length was invalid",
      );
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      await discardResponseBody(response);
      throw rejected(
        "github_delegated_provider_result_too_large",
        `GitHub delegated provider response exceeds ${maximumBytes} bytes`,
      );
    }
  }
  if (!response.body) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider returned an empty GraphQL response",
    );
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw rejected(
      "github_delegated_provider_response_failed",
      "GitHub delegated provider response could not be read",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failure: GitHubProviderRejectedError | undefined;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      if (!(read.value instanceof Uint8Array)) {
        throw rejected(
          "github_delegated_provider_invalid_response",
          "GitHub delegated GraphQL response body was invalid",
        );
      }
      total += read.value.byteLength;
      if (total > maximumBytes) {
        throw rejected(
          "github_delegated_provider_result_too_large",
          `GitHub delegated provider response exceeds ${maximumBytes} bytes`,
        );
      }
      chunks.push(read.value);
    }
  } catch (error) {
    failure = error instanceof GitHubProviderRejectedError
      ? error
      : rejected(
        "github_delegated_provider_response_failed",
        "GitHub delegated provider response could not be read",
      );
    try {
      await reader.cancel();
    } catch {
      // Preserve the original fixed read/admission failure.
    }
  }
  try {
    reader.releaseLock();
  } catch {
    failure ??= rejected(
      "github_delegated_provider_response_failed",
      "GitHub delegated provider response could not be read",
    );
  }
  if (failure) throw failure;

  const bytes = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated GraphQL response was not valid UTF-8",
    );
  }
  try {
    return parseStrictJson(text, {
      maxBytes: maximumBytes,
      maxDepth: 20,
      maxStringLength: maximumReviewBodyCharacters,
      maxObjectKeys: 64,
      maxArrayLength: 256,
      prefix: "GITHUB_REVIEW_THREADS",
    });
  } catch {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider returned invalid GraphQL JSON",
    );
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the fixed status/content/identity diagnostic.
  }
}

function providerRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was not an object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} did not use a plain object`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} contained a symbol field`,
    );
  }
  const allowed = new Set(allowedFields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) {
      throw rejected(
        "github_delegated_provider_invalid_response",
        `${label} contained an unknown field`,
      );
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw rejected(
        "github_delegated_provider_invalid_response",
        `${label} fields were invalid`,
      );
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(result, key)) {
      throw rejected(
        "github_delegated_provider_invalid_response",
        `${label} was missing a required field`,
      );
    }
  }
  return result;
}

function denseArray(
  value: unknown,
  label: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw rejected(
        "github_delegated_provider_invalid_response",
        `${label} was sparse`,
      );
    }
  }
  return value;
}

function exactDataRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} must use a plain or null prototype`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} contains a symbol field`,
    );
  }
  const allowed = new Set(allowedFields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        `${label} has an unknown field`,
      );
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        `${label} fields must be enumerable data properties`,
      );
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(result, key)) {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        `${label} is missing a required field`,
      );
    }
  }
  return result;
}

function exactRepository(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > 4_096
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated repository must use exact printable ASCII",
    );
  }
  try {
    return normalizeGitHubRepository(value).toLowerCase();
  } catch {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated repository identity is invalid",
    );
  }
}

function exactFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated catalogue fingerprint is invalid",
    );
  }
  return value;
}

function exactCredentialReference(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}$/.test(value)
  ) {
    throw new RangeError(
      "GitHub delegated credential reference must use env:// or secret://",
    );
  }
  return value;
}

function exactIdentity(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function positiveInputInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function positiveProviderInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function nonNegativeProviderInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  return positiveProviderInteger(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function nodeId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > 240
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
    || credentialShapedPublicIdentityPattern.test(value)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function uniqueNodeId(
  value: unknown,
  seen: Set<string>,
  label: string,
): string {
  const id = nodeId(value, label);
  if (seen.has(id)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was duplicated`,
    );
  }
  seen.add(id);
  return id;
}

function nullableNodeReference(value: unknown, label: string): string | null {
  if (value === null) return null;
  const record = providerRecord(value, ["id"], ["id"], label);
  return nodeId(record.id, label);
}

function nullableActorLogin(value: unknown): string | null {
  if (value === null) return null;
  const record = providerRecord(
    value,
    ["login"],
    ["login"],
    "GitHub actor identity",
  );
  const login = record.login;
  if (
    typeof login !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)
    || credentialShapedPublicIdentityPattern.test(login)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub actor login was invalid",
    );
  }
  return login;
}

function repositoryFilePath(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > 4_096
    || Buffer.byteLength(value, "utf8") > 4_096
    || value !== value.replace(/\\/g, "/")
    || value.startsWith("/")
    || value.endsWith("/")
    || unsafeTextPattern.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub review-thread path was invalid",
    );
  }
  return value;
}

function diffSide(value: unknown, label: string): "LEFT" | "RIGHT" {
  if (value !== "LEFT" && value !== "RIGHT") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function nullableDiffSide(
  value: unknown,
  label: string,
): "LEFT" | "RIGHT" | null {
  if (value === null) return null;
  return diffSide(value, label);
}

function reviewState(
  value: unknown,
): "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" {
  if (
    value !== "APPROVED"
    && value !== "CHANGES_REQUESTED"
    && value !== "COMMENTED"
    && value !== "DISMISSED"
    && value !== "PENDING"
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub pull request review state was invalid",
    );
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was absent`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return date.toISOString();
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  return exactTimestamp(value, label);
}

function nullableCursor(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !value
    || value.length > 1_024
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
    || credentialShapedPublicIdentityPattern.test(value)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub GraphQL pagination cursor was invalid",
    );
  }
  return value;
}

function providerRequestIdentity(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (
    !value
    || value.length > 240
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
    || credentialShapedPublicIdentityPattern.test(value)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub provider request identity was invalid",
    );
  }
  return value;
}

function jsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const media = value.split(";", 1)[0]?.trim().toLowerCase();
  return media === "application/json"
    || media === "application/graphql-response+json";
}

function normalizedApiBaseUrl(value: string): string {
  const url = new URL(value);
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && url.hostname === "localhost";
  if (!secure && !localHttp) {
    throw new RangeError("GitHub delegated API base URL must use HTTPS");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function graphqlEndpoint(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  const suffix = "/api/v3";
  if (url.pathname.endsWith(suffix)) {
    url.pathname = `${url.pathname.slice(0, -suffix.length)}/api/graphql`;
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/graphql`;
  }
  return url.toString();
}

function providerHttpError(status: number): GitHubProviderRejectedError {
  const message = `GitHub delegated provider request failed (HTTP ${status})`;
  if (status === 401) {
    return rejected("github_delegated_credential_rejected", message);
  }
  if (status === 403) {
    return rejected("github_delegated_permission_denied", message);
  }
  if (status === 404) {
    return rejected("github_delegated_resource_absent", message);
  }
  if (status === 409 || status === 422) {
    return rejected("github_delegated_request_rejected", message);
  }
  if (status === 429 || status >= 500) {
    return rejected("github_delegated_provider_temporarily_unavailable", message);
  }
  return rejected("github_delegated_provider_rejected", message);
}

function resourceAbsent(): GitHubProviderRejectedError {
  return rejected(
    "github_delegated_resource_absent",
    "GitHub delegated review-thread resource is unavailable",
  );
}

function rejected(code: string, message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(code, message);
}
