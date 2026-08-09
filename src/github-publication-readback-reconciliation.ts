import { normalizeRepositoryRemote } from "./project-contract.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import {
  GitHubProviderAuthorityError,
  GitHubProviderBindingError,
  type GitHubBranchResult,
  type GitHubProjectRepositoryBinding,
  type GitHubProviderAuthorityDecision,
  type GitHubProviderBindingStore,
  type GitHubProviderConnection,
  type GitHubProviderProjectReader,
  type GitHubProviderReceipt,
  type GitHubProviderReceiptStore,
  type GitHubProviderRequestContext,
  type GitHubPublicationProviderAdapter,
  type GitHubPublicationProviderOperation,
  type GitHubPullRequestResult,
} from "./github-provider-contracts.js";
import { admitGitHubProviderReceipt } from "./github-provider-receipt-admission.js";
import {
  boundedBody,
  boundedText,
  canonicalBody,
  normalizeGitHubRepository,
  projectSlug,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

export interface GitHubPublicationReadbackReconciliationDependencies {
  projects: GitHubProviderProjectReader;
  bindings: GitHubProviderBindingStore;
  authority: {
    authorizeGitHubOperation(input: {
      project: string;
      repositoryFullName: string;
      operation: GitHubPublicationProviderOperation;
      actorId: string;
      clientId: string;
      capabilityGrantId?: string;
      approvalId?: string;
    }): Promise<GitHubProviderAuthorityDecision>;
  };
  adapter: GitHubPublicationProviderAdapter;
  receipts: GitHubProviderReceiptStore;
  now?: () => string;
}

export interface GitHubBranchPublicationReadbackInput
  extends GitHubProviderRequestContext {
  branch: string;
  fromCommitSha: string;
  idempotencyKey: string;
}

export interface GitHubPullRequestPublicationReadbackInput
  extends GitHubProviderRequestContext {
  title: string;
  body?: string;
  head: string;
  base: string;
  expectedHeadSha: string;
  expectedBaseSha: string;
  draft?: boolean;
  idempotencyKey: string;
}

interface ResolvedScope {
  project: string;
  repositoryFullName: string;
  attachment: ProjectAttachmentRecord;
  binding: GitHubProjectRepositoryBinding;
  connection: GitHubProviderConnection;
  authority: GitHubProviderAuthorityDecision;
}

interface ExpectedReceiptIdentity {
  project: string;
  repositoryFullName: string;
  operation: GitHubPublicationProviderOperation;
  target: string;
  actorId: string;
  clientId: string;
  connectionId: string;
  installationId: string;
  bindingId: string;
  attachmentId: string;
  attachmentSnapshotSha256: string;
  capabilityGrantId: string | null;
  approvalId: string | null;
  idempotencyKey: string;
  parametersSha256: string;
}

/**
 * Settles ambiguous branch and pull-request publication receipts from current
 * canonical GitHub observations. Every method is read-only at the provider
 * boundary. Uncertain or mismatching observations leave the receipt pending.
 */
export class GitHubPublicationReadbackReconciler {
  readonly #projects: GitHubProviderProjectReader;
  readonly #bindings: GitHubProviderBindingStore;
  readonly #authority: GitHubPublicationReadbackReconciliationDependencies["authority"];
  readonly #adapter: GitHubPublicationProviderAdapter;
  readonly #receipts: GitHubProviderReceiptStore;
  readonly #now: () => string;

  constructor(dependencies: GitHubPublicationReadbackReconciliationDependencies) {
    this.#projects = dependencies.projects;
    this.#bindings = dependencies.bindings;
    this.#authority = dependencies.authority;
    this.#adapter = dependencies.adapter;
    this.#receipts = dependencies.receipts;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async reconcileBranch(
    input: GitHubBranchPublicationReadbackInput,
  ): Promise<GitHubProviderReceipt> {
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    const branch = branchName(input.branch);
    const fromCommitSha = commitSha(input.fromCommitSha, "Branch source commit");
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "GitHub provider idempotency key",
      240,
    );
    const scope = await this.#resolveScope(input, "github_create_branch");
    const receipt = await this.#loadReceipt(scope.project, idempotencyKey);
    const expected = this.#expectedIdentity({
      context: input,
      scope,
      operation: "github_create_branch",
      target: `${repositoryFullName}:refs/heads/${branch}`,
      idempotencyKey,
      parameters: { branch, fromCommitSha },
    });
    assertReceiptIdentity(receipt, expected);
    assertPendingOrSettledBranchResult(receipt, branch, fromCommitSha);
    if (receipt.state !== "pending_reconciliation") return receipt;

    let observed: GitHubBranchResult | null;
    try {
      observed = await this.#adapter.getBranch({
        repositoryFullName,
        branch,
      });
    } catch {
      return receipt;
    }
    if (
      observed === null
      || observed.name !== branch
      || observed.ref !== `refs/heads/${branch}`
      || observed.commitSha !== fromCommitSha
      || observed.sourceRevision !== fromCommitSha
    ) {
      return receipt;
    }
    return await this.#settle(receipt, observed);
  }

  async reconcilePullRequest(
    input: GitHubPullRequestPublicationReadbackInput,
  ): Promise<GitHubProviderReceipt> {
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    const title = boundedText(input.title, "GitHub pull request title", 256);
    const body = input.body === undefined
      ? undefined
      : boundedBody(input.body, "GitHub pull request body", 128 * 1024);
    const head = branchName(input.head);
    const base = branchName(input.base);
    if (head === base) {
      throw new RangeError("GitHub pull request head and base must differ");
    }
    const expectedHeadSha = commitSha(
      input.expectedHeadSha,
      "Expected pull request head commit",
    );
    const expectedBaseSha = commitSha(
      input.expectedBaseSha,
      "Expected pull request base commit",
    );
    const draft = input.draft ?? false;
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "GitHub provider idempotency key",
      240,
    );
    const scope = await this.#resolveScope(input, "github_create_pull_request");
    const receipt = await this.#loadReceipt(scope.project, idempotencyKey);
    const expected = this.#expectedIdentity({
      context: input,
      scope,
      operation: "github_create_pull_request",
      target: `${repositoryFullName}:pull:new:${head}->${base}`,
      idempotencyKey,
      parameters: {
        title,
        body: body ?? null,
        head,
        base,
        expectedHeadSha,
        expectedBaseSha,
        draft,
      },
    });
    assertReceiptIdentity(receipt, expected);
    const retained = assertPendingOrSettledPullRequestResult(receipt, {
      title,
      body: body ?? "",
      head,
      base,
      expectedHeadSha,
      expectedBaseSha,
      draft,
    });
    if (receipt.state !== "pending_reconciliation") return receipt;
    if (retained === null) return receipt;

    let observed: GitHubPullRequestResult;
    try {
      observed = await this.#adapter.getPullRequest({
        repositoryFullName,
        pullRequestNumber: retained.number,
      });
    } catch {
      return receipt;
    }
    if (!samePullRequestIdentityAndPublication(observed, retained, {
      title,
      body: body ?? "",
      head,
      base,
      expectedHeadSha,
      expectedBaseSha,
      draft,
    })) {
      return receipt;
    }
    return await this.#settle(receipt, observed);
  }

  async #loadReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt> {
    const raw = await this.#receipts.getGitHubProviderReceipt(
      project,
      idempotencyKey,
    );
    if (!raw) {
      throw new GitHubPublicationReadbackReceiptUnavailableError();
    }
    return admitGitHubProviderReceipt(raw);
  }

  #expectedIdentity(input: {
    context: GitHubProviderRequestContext;
    scope: ResolvedScope;
    operation: GitHubPublicationProviderOperation;
    target: string;
    idempotencyKey: string;
    parameters: unknown;
  }): ExpectedReceiptIdentity {
    return {
      project: input.scope.project,
      repositoryFullName: input.scope.repositoryFullName,
      operation: input.operation,
      target: input.target,
      actorId: boundedText(
        input.context.actorId,
        "GitHub provider actor ID",
        120,
      ),
      clientId: boundedText(
        input.context.clientId,
        "GitHub provider client ID",
        240,
      ),
      connectionId: input.scope.connection.id,
      installationId: input.scope.connection.installationId,
      bindingId: input.scope.binding.id,
      attachmentId: input.scope.attachment.id,
      attachmentSnapshotSha256: input.scope.attachment.snapshot.snapshotSha256,
      capabilityGrantId: input.scope.authority.capabilityGrantId
        ?? input.context.capabilityGrantId
        ?? null,
      approvalId: input.scope.authority.approvalId
        ?? input.context.approvalId
        ?? null,
      idempotencyKey: input.idempotencyKey,
      parametersSha256: sha256(stableJson({
        operation: input.operation,
        target: input.target,
        parameters: input.parameters,
      })),
    };
  }

  async #settle(
    receipt: GitHubProviderReceipt,
    result: GitHubBranchResult | GitHubPullRequestResult,
  ): Promise<GitHubProviderReceipt> {
    const checkedAt = this.#now();
    const updated = await this.#receipts.updateGitHubProviderReceipt({
      ...receipt,
      state: "reconciled",
      updatedAt: checkedAt,
      result,
      verification: {
        state: "passed",
        checkedAt,
        sourceRevision: result.sourceRevision,
      },
      error: null,
      recovery: { nextAction: "none" },
    });
    return admitGitHubProviderReceipt(updated);
  }

  async #resolveScope(
    context: GitHubProviderRequestContext,
    operation: GitHubPublicationProviderOperation,
  ): Promise<ResolvedScope> {
    const project = projectSlug(context.project);
    const repositoryFullName = normalizeGitHubRepository(context.repository);
    const attachment = await this.#projects.getProjectAttachment(project);
    if (!attachment) {
      throw new GitHubProviderBindingError(
        `Project ${project} has no accepted repository attachment`,
      );
    }
    const declared = attachment.snapshot.contract.repositories
      .map((repository) => normalizeRepositoryRemote(repository))
      .filter((repository): repository is string => repository !== null)
      .map((repository) => repository.toLowerCase());
    if (!declared.includes(repositoryFullName)) {
      throw new GitHubProviderBindingError(
        `Repository ${repositoryFullName} is outside the accepted project attachment`,
      );
    }
    const binding = await this.#bindings.getGitHubProjectRepositoryBinding(
      project,
      repositoryFullName,
    );
    if (!binding || binding.status !== "active") {
      throw new GitHubProviderBindingError(
        `Repository ${repositoryFullName} has no active GitHub provider binding`,
      );
    }
    if (
      binding.project !== project
      || normalizeGitHubRepository(binding.repositoryFullName) !== repositoryFullName
      || binding.attachmentId !== attachment.id
      || binding.attachmentSnapshotSha256 !== attachment.snapshot.snapshotSha256
    ) {
      throw new GitHubProviderBindingError(
        "GitHub provider binding is stale against the accepted project attachment",
      );
    }
    const connection = await this.#bindings.getGitHubProviderConnection(
      binding.connectionId,
    );
    if (!connection || connection.status !== "active") {
      throw new GitHubProviderBindingError(
        "GitHub provider connection is unavailable or inactive",
      );
    }
    if (
      !connection.repositoryFullNames
        .map(normalizeGitHubRepository)
        .includes(repositoryFullName)
    ) {
      throw new GitHubProviderBindingError(
        `GitHub installation ${connection.installationId} no longer exposes ${repositoryFullName}`,
      );
    }
    const authority = await this.#authority.authorizeGitHubOperation({
      project,
      repositoryFullName,
      operation,
      actorId: boundedText(context.actorId, "GitHub provider actor ID", 120),
      clientId: boundedText(context.clientId, "GitHub provider client ID", 240),
      ...(context.capabilityGrantId
        ? {
          capabilityGrantId: boundedText(
            context.capabilityGrantId,
            "Capability grant ID",
            240,
          ),
        }
        : {}),
      ...(context.approvalId
        ? { approvalId: boundedText(context.approvalId, "Approval ID", 240) }
        : {}),
    });
    if (!authority.allowed) {
      throw new GitHubProviderAuthorityError(
        authority.reason?.trim()
          || `Operation ${operation} is outside current authority`,
      );
    }
    return {
      project,
      repositoryFullName,
      attachment,
      binding,
      connection,
      authority,
    };
  }
}

export class GitHubPublicationReadbackReceiptUnavailableError extends Error {
  readonly code = "github_publication_receipt_unavailable";

  constructor() {
    super("GitHub publication receipt is unavailable for reconciliation");
    this.name = "GitHubPublicationReadbackReceiptUnavailableError";
  }
}

function assertReceiptIdentity(
  receipt: GitHubProviderReceipt,
  expected: ExpectedReceiptIdentity,
): void {
  if (
    receipt.version !== 1
    || receipt.project !== expected.project
    || receipt.provider !== "github"
    || receipt.repositoryFullName !== expected.repositoryFullName
    || receipt.operation !== expected.operation
    || receipt.target !== expected.target
    || receipt.actorId !== expected.actorId
    || receipt.clientId !== expected.clientId
    || receipt.connectionId !== expected.connectionId
    || receipt.installationId !== expected.installationId
    || receipt.bindingId !== expected.bindingId
    || receipt.attachmentId !== expected.attachmentId
    || receipt.attachmentSnapshotSha256 !== expected.attachmentSnapshotSha256
    || receipt.capabilityGrantId !== expected.capabilityGrantId
    || receipt.approvalId !== expected.approvalId
    || receipt.idempotencyKey !== expected.idempotencyKey
    || receipt.parametersSha256 !== expected.parametersSha256
    || receipt.attemptCount !== 1
  ) {
    throw new GitHubPublicationReadbackIdentityError();
  }
}

export class GitHubPublicationReadbackIdentityError extends Error {
  readonly code = "github_publication_readback_identity_mismatch";

  constructor() {
    super("GitHub publication reconciliation identity changed");
    this.name = "GitHubPublicationReadbackIdentityError";
  }
}

function assertPendingOrSettledBranchResult(
  receipt: GitHubProviderReceipt,
  branch: string,
  fromCommitSha: string,
): void {
  if (receipt.result === null) return;
  if (
    receipt.result.kind !== "branch"
    || receipt.result.name !== branch
    || receipt.result.ref !== `refs/heads/${branch}`
    || receipt.result.commitSha !== fromCommitSha
    || receipt.result.sourceRevision !== fromCommitSha
  ) {
    throw new GitHubPublicationReadbackIdentityError();
  }
}

interface ExpectedPullRequestPublication {
  title: string;
  body: string;
  head: string;
  base: string;
  expectedHeadSha: string;
  expectedBaseSha: string;
  draft: boolean;
}

function assertPendingOrSettledPullRequestResult(
  receipt: GitHubProviderReceipt,
  expected: ExpectedPullRequestPublication,
): GitHubPullRequestResult | null {
  if (receipt.result === null) return null;
  if (receipt.result.kind !== "pull_request") {
    throw new GitHubPublicationReadbackIdentityError();
  }
  assertPullRequestPublicationFields(receipt.result, expected);
  return receipt.result;
}

function samePullRequestIdentityAndPublication(
  observed: GitHubPullRequestResult,
  retained: GitHubPullRequestResult,
  expected: ExpectedPullRequestPublication,
): boolean {
  try {
    assertPullRequestPublicationFields(observed, expected);
  } catch {
    return false;
  }
  return observed.number === retained.number
    && observed.providerNodeId === retained.providerNodeId
    && observed.canonicalUrl === retained.canonicalUrl
    && observed.createdAt === retained.createdAt;
}

function assertPullRequestPublicationFields(
  result: GitHubPullRequestResult,
  expected: ExpectedPullRequestPublication,
): void {
  const canonical = canonicalBody(expected.body);
  if (
    result.title !== expected.title
    || result.head !== expected.head
    || result.headSha !== expected.expectedHeadSha
    || result.base !== expected.base
    || result.baseSha !== expected.expectedBaseSha
    || result.draft !== expected.draft
    || result.state !== "open"
    || result.bodyRevision.sha256 !== sha256(canonical)
    || result.bodyRevision.byteLength !== Buffer.byteLength(canonical, "utf8")
    || result.containsBody !== false
  ) {
    throw new GitHubPublicationReadbackIdentityError();
  }
}

function branchName(value: string): string {
  const branch = boundedText(value, "GitHub branch", 240);
  if (
    branch === "@"
    || branch === "HEAD"
    || branch.startsWith("refs/heads/")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.startsWith("-")
    || branch.includes("//")
    || branch.includes("..")
    || branch.includes("@{")
    || /[~^:?*\[\\\s]/u.test(branch)
  ) {
    throw new RangeError("GitHub branch is invalid");
  }
  const segments = branch.split("/");
  if (segments.some((segment) =>
    !segment
    || segment === "."
    || segment === ".."
    || segment.startsWith(".")
    || segment.endsWith(".")
    || segment.endsWith(".lock")
  )) {
    throw new RangeError("GitHub branch is invalid");
  }
  return branch;
}

function commitSha(value: string, label: string): string {
  const sha = boundedText(value, label, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) {
    throw new RangeError(`${label} is invalid`);
  }
  return sha;
}
