import { randomUUID } from "node:crypto";
import { normalizeRepositoryRemote } from "./project-contract.js";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
  GitHubProviderProjectReader,
  GitHubProviderRejectedError,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import {
  boundedText,
  canonicalBody,
  normalizeGitHubRepository,
  positiveInteger,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const githubPullRequestReviewActions = [
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
] as const;
export type GitHubPullRequestReviewAction =
  typeof githubPullRequestReviewActions[number];
export type GitHubPullRequestReviewState =
  | "approved"
  | "changes_requested"
  | "commented";

export const MAXIMUM_GITHUB_PULL_REQUEST_REVIEW_BODY_BYTES = 64 * 1024;

export interface GitHubPullRequestReviewTarget {
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly updatedAt: string;
  readonly sourceRevision: string;
}

/** Transient provider read used for exact verification/reconciliation. */
export interface GitHubPullRequestReviewProviderReview {
  readonly id: string;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly commitSha: string;
  readonly state: GitHubPullRequestReviewState;
  readonly body: string;
  readonly authorLogin: string;
  readonly submittedAt: string;
}

export interface GitHubPullRequestReviewAdapter {
  getPullRequest(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestReviewTarget>;
  createReview(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    commitSha: string;
    action: GitHubPullRequestReviewAction;
    body: string;
  }): Promise<{
    review: GitHubPullRequestReviewProviderReview;
    providerRequestId?: string;
  }>;
  getReview(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    reviewId: string;
  }): Promise<GitHubPullRequestReviewProviderReview>;
  listReviews(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
  }): Promise<readonly GitHubPullRequestReviewProviderReview[]>;
}

export interface GitHubPullRequestReviewAuthorityDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly capabilityGrantId?: string;
  readonly approvalId?: string;
}

export interface GitHubPullRequestReviewAuthority {
  authorizeGitHubPullRequestReview(input: {
    project: string;
    repositoryFullName: string;
    pullRequestNumber: number;
    action: GitHubPullRequestReviewAction;
    actorId: string;
    clientId: string;
    capabilityGrantId?: string;
    approvalId?: string;
  }): Promise<GitHubPullRequestReviewAuthorityDecision>;
}

export interface GitHubPullRequestReviewProviderDependencies {
  readonly projects: GitHubProviderProjectReader;
  readonly bindings: GitHubProviderBindingStore;
  readonly authority: GitHubPullRequestReviewAuthority;
  readonly adapter: GitHubPullRequestReviewAdapter;
  readonly now?: () => string;
  readonly idFactory?: () => string;
}

export interface GitHubPullRequestReviewDispatchReceipt {
  readonly version: 1;
  readonly id: string;
  readonly effectId: string;
  readonly project: string;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly action: GitHubPullRequestReviewAction;
  readonly expectedTargetSourceRevision: string;
  readonly expectedHeadRevision: string;
  readonly visibleBodySha256: string;
  readonly visibleBodyByteLength: number;
  readonly providerBodySha256: string;
  readonly providerBodyByteLength: number;
  readonly webhookBodyRevisionSha256: string;
  readonly connectionId: string;
  readonly installationId: string;
  readonly bindingId: string;
  readonly attachmentId: string;
  readonly attachmentSnapshotSha256: string;
  readonly capabilityGrantId: string | null;
  readonly approvalId: string | null;
  readonly providerReviewId: string | null;
  readonly providerReviewState: GitHubPullRequestReviewState | null;
  readonly providerRequestId: string | null;
  readonly state:
    | "succeeded"
    | "replayed"
    | "reconciled"
    | "pending_reconciliation";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verification: {
    readonly state: "passed" | "pending";
    readonly checkedAt: string;
    readonly commitSha: string | null;
  };
  readonly recovery: {
    readonly nextAction: "none" | "reconcile_exact_review";
  };
  readonly receiptFingerprint: string;
}

interface ResolvedScope {
  readonly project: string;
  readonly repositoryFullName: string;
  readonly attachment: ProjectAttachmentRecord;
  readonly binding: GitHubProjectRepositoryBinding;
  readonly connection: GitHubProviderConnection;
  readonly authority: GitHubPullRequestReviewAuthorityDecision;
}

interface PreparedReview {
  readonly visibleBody: string;
  readonly providerBody: string;
  readonly visibleBodySha256: string;
  readonly visibleBodyByteLength: number;
  readonly providerBodySha256: string;
  readonly providerBodyByteLength: number;
  readonly webhookBodyRevisionSha256: string;
}

export class GitHubPullRequestReviewPendingReconciliationError extends Error {
  readonly name = "GitHubPullRequestReviewPendingReconciliationError";
  constructor(readonly receipt: GitHubPullRequestReviewDispatchReceipt) {
    super("GitHub pull request review requires exact reconciliation before another dispatch");
  }
}

export class GitHubPullRequestReviewStaleTargetError extends Error {
  readonly name = "GitHubPullRequestReviewStaleTargetError";
  constructor(readonly current: GitHubPullRequestReviewTarget) {
    super("GitHub pull request review target changed after proposal admission");
  }
}

export class GitHubPullRequestReviewBindingError extends Error {
  readonly name = "GitHubPullRequestReviewBindingError";
}

export class GitHubPullRequestReviewAuthorityError extends Error {
  readonly name = "GitHubPullRequestReviewAuthorityError";
}

/**
 * Creates the exact provider-facing review bytes. The marker is deliberately a
 * GitHub HTML comment: it is invisible in rendered prose, stable across
 * process restarts, and lets the provider itself act as the durable replay /
 * reconciliation index without conflating reviews with Conversation comments.
 */
export function prepareGitHubPullRequestReviewProviderBody(
  effectId: string,
  body: string,
): PreparedReview {
  const exactEffectId = reviewEffectId(effectId);
  const visibleBody = canonicalBody(exactReviewBody(body));
  const marker = `<!-- stensibly-review-effect:${exactEffectId} -->`;
  const providerBody = visibleBody ? `${visibleBody}\n\n${marker}` : marker;
  const visibleBodyByteLength = byteLength(visibleBody);
  const providerBodyByteLength = byteLength(providerBody);
  if (providerBodyByteLength > MAXIMUM_GITHUB_PULL_REQUEST_REVIEW_BODY_BYTES) {
    throw new RangeError("GitHub pull request review body is too large after effect binding");
  }
  return Object.freeze({
    visibleBody,
    providerBody,
    visibleBodySha256: sha256(visibleBody),
    visibleBodyByteLength,
    providerBodySha256: sha256(providerBody),
    providerBodyByteLength,
    webhookBodyRevisionSha256: sha256(stableJson({
      present: true,
      content: providerBody,
    })),
  });
}

export function githubPullRequestReviewTargetSourceRevision(input: {
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  state: "open" | "closed";
  draft: boolean;
  updatedAt: string;
}): string {
  return sha256(stableJson({
    repositoryFullName: normalizeGitHubRepository(input.repositoryFullName),
    pullRequestNumber: positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    ),
    headSha: fullRevision(input.headSha, "GitHub pull request head revision"),
    state: input.state,
    draft: input.draft,
    updatedAt: canonicalTimestamp(input.updatedAt, "GitHub pull request update time"),
  }));
}

export class GitHubPullRequestReviewProviderService {
  readonly #projects: GitHubProviderProjectReader;
  readonly #bindings: GitHubProviderBindingStore;
  readonly #authority: GitHubPullRequestReviewAuthority;
  readonly #adapter: GitHubPullRequestReviewAdapter;
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(dependencies: GitHubPullRequestReviewProviderDependencies) {
    this.#projects = dependencies.projects;
    this.#bindings = dependencies.bindings;
    this.#authority = dependencies.authority;
    this.#adapter = dependencies.adapter;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#idFactory = dependencies.idFactory ?? (() => `ghreview_${randomUUID()}`);
  }

  async getTarget(input: GitHubProviderRequestContext & {
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestReviewTarget> {
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    await this.#resolveBinding(input, repositoryFullName);
    return await this.#adapter.getPullRequest({
      repositoryFullName,
      pullRequestNumber: positiveInteger(
        input.pullRequestNumber,
        "GitHub pull request number",
      ),
    });
  }

  async submitReview(input: GitHubProviderRequestContext & {
    effectId: string;
    pullRequestNumber: number;
    expectedTargetSourceRevision: string;
    expectedHeadRevision: string;
    action: GitHubPullRequestReviewAction;
    body: string;
    previousReceipt?: GitHubPullRequestReviewDispatchReceipt;
  }): Promise<GitHubPullRequestReviewDispatchReceipt> {
    const effectId = reviewEffectId(input.effectId);
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    const expectedTargetSourceRevision = hash(
      input.expectedTargetSourceRevision,
      "GitHub pull request target source revision",
    );
    const expectedHeadRevision = fullRevision(
      input.expectedHeadRevision,
      "Expected GitHub pull request head revision",
    );
    const action = reviewAction(input.action);
    const prepared = prepareGitHubPullRequestReviewProviderBody(effectId, input.body);
    requireReviewVisibleBody(action, prepared.visibleBody);

    const binding = await this.#resolveBinding(input, repositoryFullName);
    const current = await this.#adapter.getPullRequest({
      repositoryFullName,
      pullRequestNumber,
    });
    assertTargetIdentity(current, repositoryFullName, pullRequestNumber);
    if (
      current.state !== "open"
      || current.sourceRevision !== expectedTargetSourceRevision
      || current.headSha !== expectedHeadRevision
    ) {
      throw new GitHubPullRequestReviewStaleTargetError(current);
    }

    const authority = await this.#authority.authorizeGitHubPullRequestReview({
      project: binding.project,
      repositoryFullName,
      pullRequestNumber,
      action,
      actorId: boundedText(input.actorId, "GitHub provider actor ID", 120),
      clientId: boundedText(input.clientId, "GitHub provider client ID", 240),
      ...(input.capabilityGrantId
        ? { capabilityGrantId: boundedText(input.capabilityGrantId, "Capability grant ID", 240) }
        : {}),
      ...(input.approvalId
        ? { approvalId: boundedText(input.approvalId, "Approval ID", 240) }
        : {}),
    });
    if (!authority.allowed) {
      throw new GitHubPullRequestReviewAuthorityError(
        authority.reason?.trim() || "GitHub pull request review is outside current authority",
      );
    }
    const scope: ResolvedScope = { ...binding, authority };
    const createdAt = input.previousReceipt?.createdAt ?? this.#now();
    const pendingBase = receiptBase({
      id: input.previousReceipt?.id
        ?? boundedText(this.#idFactory(), "GitHub review receipt ID", 240),
      effectId,
      scope,
      pullRequestNumber,
      action,
      expectedTargetSourceRevision,
      expectedHeadRevision,
      prepared,
      createdAt,
      updatedAt: this.#now(),
    });

    if (input.previousReceipt) {
      assertPreviousReceipt(input.previousReceipt, pendingBase);
      if (input.previousReceipt.state === "pending_reconciliation") {
        return await this.#reconcileOnly(
          input.previousReceipt,
          scope,
          prepared.providerBody,
        );
      }
      return await this.#replayVerified(
        input.previousReceipt,
        scope,
        prepared.providerBody,
      );
    }

    let existing: GitHubPullRequestReviewProviderReview[];
    try {
      existing = exactEffectReviews(
        await this.#adapter.listReviews({ repositoryFullName, pullRequestNumber }),
        effectId,
      );
    } catch {
      throw new GitHubPullRequestReviewPendingReconciliationError(
        pendingReceipt(pendingBase, null, null),
      );
    }
    const exactExisting = exactReviews(
      existing,
      action,
      expectedHeadRevision,
      prepared.providerBody,
    );
    if (exactExisting.length === 1 && existing.length === 1) {
      return succeededReceipt(
        pendingBase,
        exactExisting[0]!,
        null,
        "replayed",
        this.#now(),
      );
    }
    if (existing.length !== 0) {
      throw new GitHubPullRequestReviewPendingReconciliationError(
        pendingReceipt(
          pendingBase,
          existing.length === 1 ? existing[0]!.id : null,
          existing.length === 1 ? existing[0]!.state : null,
        ),
      );
    }

    let created: {
      review: GitHubPullRequestReviewProviderReview;
      providerRequestId?: string;
    };
    try {
      created = await this.#adapter.createReview({
        repositoryFullName,
        pullRequestNumber,
        commitSha: expectedHeadRevision,
        action,
        body: prepared.providerBody,
      });
    } catch (error) {
      if (isProviderRejected(error)) throw error;
      return await this.#reconcileAfterAmbiguous(
        pendingBase,
        scope,
        prepared.providerBody,
      );
    }

    try {
      const readback = await this.#adapter.getReview({
        repositoryFullName,
        pullRequestNumber,
        reviewId: created.review.id,
      });
      assertExactReview(
        readback,
        repositoryFullName,
        pullRequestNumber,
        action,
        expectedHeadRevision,
        prepared.providerBody,
      );
      return succeededReceipt(
        pendingBase,
        readback,
        created.providerRequestId ?? null,
        "succeeded",
        this.#now(),
      );
    } catch {
      throw new GitHubPullRequestReviewPendingReconciliationError(
        pendingReceipt(
          {
            ...pendingBase,
            providerRequestId: created.providerRequestId ?? null,
          },
          created.review.id,
          created.review.state,
        ),
      );
    }
  }

  async #reconcileAfterAmbiguous(
    base: ReceiptBase,
    scope: ResolvedScope,
    providerBody: string,
  ): Promise<GitHubPullRequestReviewDispatchReceipt> {
    try {
      const matches = exactReviews(
        exactEffectReviews(
          await this.#adapter.listReviews({
            repositoryFullName: scope.repositoryFullName,
            pullRequestNumber: base.pullRequestNumber,
          }),
          base.effectId,
        ),
        base.action,
        base.expectedHeadRevision,
        providerBody,
      );
      if (matches.length === 1) {
        return succeededReceipt(
          base,
          matches[0]!,
          null,
          "reconciled",
          this.#now(),
        );
      }
    } catch {
      // Keep the operation fenced below.
    }
    throw new GitHubPullRequestReviewPendingReconciliationError(
      pendingReceipt(base, null, null),
    );
  }

  async #reconcileOnly(
    previous: GitHubPullRequestReviewDispatchReceipt,
    scope: ResolvedScope,
    providerBody: string,
  ): Promise<GitHubPullRequestReviewDispatchReceipt> {
    try {
      if (previous.providerReviewId) {
        const readback = await this.#adapter.getReview({
          repositoryFullName: scope.repositoryFullName,
          pullRequestNumber: previous.pullRequestNumber,
          reviewId: previous.providerReviewId,
        });
        assertExactReview(
          readback,
          scope.repositoryFullName,
          previous.pullRequestNumber,
          previous.action,
          previous.expectedHeadRevision,
          providerBody,
        );
        return succeededReceipt(
          stripReceiptFingerprint(previous),
          readback,
          previous.providerRequestId,
          "reconciled",
          this.#now(),
        );
      }
      const matches = exactReviews(
        exactEffectReviews(
          await this.#adapter.listReviews({
            repositoryFullName: scope.repositoryFullName,
            pullRequestNumber: previous.pullRequestNumber,
          }),
          previous.effectId,
        ),
        previous.action,
        previous.expectedHeadRevision,
        providerBody,
      );
      if (matches.length === 1) {
        return succeededReceipt(
          stripReceiptFingerprint(previous),
          matches[0]!,
          previous.providerRequestId,
          "reconciled",
          this.#now(),
        );
      }
    } catch {
      // Remain fenced.
    }
    throw new GitHubPullRequestReviewPendingReconciliationError(previous);
  }

  async #replayVerified(
    previous: GitHubPullRequestReviewDispatchReceipt,
    scope: ResolvedScope,
    providerBody: string,
  ): Promise<GitHubPullRequestReviewDispatchReceipt> {
    try {
      const matches = previous.providerReviewId
        ? [await this.#adapter.getReview({
          repositoryFullName: scope.repositoryFullName,
          pullRequestNumber: previous.pullRequestNumber,
          reviewId: previous.providerReviewId,
        })]
        : exactReviews(
          exactEffectReviews(
            await this.#adapter.listReviews({
              repositoryFullName: scope.repositoryFullName,
              pullRequestNumber: previous.pullRequestNumber,
            }),
            previous.effectId,
          ),
          previous.action,
          previous.expectedHeadRevision,
          providerBody,
        );
      if (matches.length === 1) {
        assertExactReview(
          matches[0]!,
          scope.repositoryFullName,
          previous.pullRequestNumber,
          previous.action,
          previous.expectedHeadRevision,
          providerBody,
        );
        return succeededReceipt(
          stripReceiptFingerprint(previous),
          matches[0]!,
          previous.providerRequestId,
          "replayed",
          this.#now(),
        );
      }
    } catch {
      // Treat lost exact readback as reconciliation, never as permission to resend.
    }
    throw new GitHubPullRequestReviewPendingReconciliationError(
      pendingReceipt(stripReceiptFingerprint(previous), previous.providerReviewId, previous.providerReviewState),
    );
  }

  async #resolveBinding(
    context: GitHubProviderRequestContext,
    repositoryFullName: string,
  ): Promise<Omit<ResolvedScope, "authority">> {
    const project = boundedText(context.project, "Project", 80).toLowerCase();
    const attachment = await this.#projects.getProjectAttachment(project);
    if (!attachment) {
      throw new GitHubPullRequestReviewBindingError(
        `Project ${project} has no accepted repository attachment`,
      );
    }
    const declared = attachment.snapshot.contract.repositories
      .map((repository) => normalizeRepositoryRemote(repository))
      .filter((repository): repository is string => repository !== null)
      .map((repository) => repository.toLowerCase());
    if (!declared.includes(repositoryFullName)) {
      throw new GitHubPullRequestReviewBindingError(
        `Repository ${repositoryFullName} is outside the accepted project attachment`,
      );
    }
    const binding = await this.#bindings.getGitHubProjectRepositoryBinding(
      project,
      repositoryFullName,
    );
    if (!binding || binding.status !== "active") {
      throw new GitHubPullRequestReviewBindingError(
        `Repository ${repositoryFullName} has no active GitHub provider binding`,
      );
    }
    if (
      binding.project !== project
      || normalizeGitHubRepository(binding.repositoryFullName) !== repositoryFullName
      || binding.attachmentId !== attachment.id
      || binding.attachmentSnapshotSha256 !== attachment.snapshot.snapshotSha256
    ) {
      throw new GitHubPullRequestReviewBindingError(
        "GitHub pull request review binding is stale against the accepted project attachment",
      );
    }
    const connection = await this.#bindings.getGitHubProviderConnection(
      binding.connectionId,
    );
    if (!connection || connection.status !== "active") {
      throw new GitHubPullRequestReviewBindingError(
        "GitHub pull request review connection is unavailable or inactive",
      );
    }
    if (
      !connection.repositoryFullNames.map(normalizeGitHubRepository)
        .includes(repositoryFullName)
    ) {
      throw new GitHubPullRequestReviewBindingError(
        "GitHub pull request review repository is outside the current installation",
      );
    }
    return { project, repositoryFullName, attachment, binding, connection };
  }
}

type ReceiptBase = Omit<
  GitHubPullRequestReviewDispatchReceipt,
  | "providerReviewId"
  | "providerReviewState"
  | "state"
  | "verification"
  | "recovery"
  | "receiptFingerprint"
> & { providerRequestId: string | null };

function receiptBase(input: {
  id: string;
  effectId: string;
  scope: ResolvedScope;
  pullRequestNumber: number;
  action: GitHubPullRequestReviewAction;
  expectedTargetSourceRevision: string;
  expectedHeadRevision: string;
  prepared: PreparedReview;
  createdAt: string;
  updatedAt: string;
}): ReceiptBase {
  return Object.freeze({
    version: 1 as const,
    id: input.id,
    effectId: input.effectId,
    project: input.scope.project,
    repositoryFullName: input.scope.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    action: input.action,
    expectedTargetSourceRevision: input.expectedTargetSourceRevision,
    expectedHeadRevision: input.expectedHeadRevision,
    visibleBodySha256: input.prepared.visibleBodySha256,
    visibleBodyByteLength: input.prepared.visibleBodyByteLength,
    providerBodySha256: input.prepared.providerBodySha256,
    providerBodyByteLength: input.prepared.providerBodyByteLength,
    webhookBodyRevisionSha256: input.prepared.webhookBodyRevisionSha256,
    connectionId: input.scope.connection.id,
    installationId: input.scope.connection.installationId,
    bindingId: input.scope.binding.id,
    attachmentId: input.scope.attachment.id,
    attachmentSnapshotSha256: input.scope.attachment.snapshot.snapshotSha256,
    capabilityGrantId: input.scope.authority.capabilityGrantId ?? null,
    approvalId: input.scope.authority.approvalId ?? null,
    providerRequestId: null,
    createdAt: canonicalTimestamp(input.createdAt, "GitHub review receipt creation time"),
    updatedAt: canonicalTimestamp(input.updatedAt, "GitHub review receipt update time"),
  });
}

function pendingReceipt(
  base: ReceiptBase,
  providerReviewId: string | null,
  providerReviewState: GitHubPullRequestReviewState | null,
): GitHubPullRequestReviewDispatchReceipt {
  return finalizeReceipt({
    ...base,
    providerReviewId,
    providerReviewState,
    state: "pending_reconciliation",
    verification: {
      state: "pending",
      checkedAt: base.updatedAt,
      commitSha: null,
    },
    recovery: { nextAction: "reconcile_exact_review" },
  });
}

function succeededReceipt(
  base: ReceiptBase,
  review: GitHubPullRequestReviewProviderReview,
  providerRequestId: string | null,
  state: "succeeded" | "replayed" | "reconciled",
  checkedAt: string,
): GitHubPullRequestReviewDispatchReceipt {
  return finalizeReceipt({
    ...base,
    providerRequestId,
    providerReviewId: review.id,
    providerReviewState: review.state,
    state,
    updatedAt: canonicalTimestamp(checkedAt, "GitHub review verification time"),
    verification: {
      state: "passed",
      checkedAt: canonicalTimestamp(checkedAt, "GitHub review verification time"),
      commitSha: review.commitSha,
    },
    recovery: { nextAction: "none" },
  });
}

function finalizeReceipt(
  input: Omit<GitHubPullRequestReviewDispatchReceipt, "receiptFingerprint">,
): GitHubPullRequestReviewDispatchReceipt {
  return deepFreeze({
    ...input,
    receiptFingerprint: fingerprintCanonicalRequest(input),
  });
}

function stripReceiptFingerprint(
  value: GitHubPullRequestReviewDispatchReceipt,
): ReceiptBase {
  const {
    providerReviewId: _providerReviewId,
    providerReviewState: _providerReviewState,
    state: _state,
    verification: _verification,
    recovery: _recovery,
    receiptFingerprint: _receiptFingerprint,
    ...base
  } = value;
  return base;
}

function assertPreviousReceipt(
  previous: GitHubPullRequestReviewDispatchReceipt,
  current: ReceiptBase,
): void {
  if (
    previous.version !== 1
    || previous.receiptFingerprint !== fingerprintCanonicalRequest(
      (({ receiptFingerprint: _ignored, ...rest }) => rest)(previous),
    )
    || previous.id !== current.id
    || previous.effectId !== current.effectId
    || previous.project !== current.project
    || previous.repositoryFullName !== current.repositoryFullName
    || previous.pullRequestNumber !== current.pullRequestNumber
    || previous.action !== current.action
    || previous.expectedTargetSourceRevision !== current.expectedTargetSourceRevision
    || previous.expectedHeadRevision !== current.expectedHeadRevision
    || previous.visibleBodySha256 !== current.visibleBodySha256
    || previous.visibleBodyByteLength !== current.visibleBodyByteLength
    || previous.providerBodySha256 !== current.providerBodySha256
    || previous.providerBodyByteLength !== current.providerBodyByteLength
    || previous.webhookBodyRevisionSha256 !== current.webhookBodyRevisionSha256
    || previous.connectionId !== current.connectionId
    || previous.installationId !== current.installationId
    || previous.bindingId !== current.bindingId
    || previous.attachmentId !== current.attachmentId
    || previous.attachmentSnapshotSha256 !== current.attachmentSnapshotSha256
  ) {
    throw new RangeError("GitHub pull request review receipt does not match the current exact effect");
  }
}

function assertTargetIdentity(
  target: GitHubPullRequestReviewTarget,
  repositoryFullName: string,
  pullRequestNumber: number,
): void {
  if (
    normalizeGitHubRepository(target.repositoryFullName) !== repositoryFullName
    || target.pullRequestNumber !== pullRequestNumber
    || target.sourceRevision !== githubPullRequestReviewTargetSourceRevision(target)
  ) {
    throw new RangeError("GitHub pull request review target identity is invalid");
  }
}

function exactEffectReviews(
  reviews: readonly GitHubPullRequestReviewProviderReview[],
  effectId: string,
): GitHubPullRequestReviewProviderReview[] {
  const marker = `<!-- stensibly-review-effect:${reviewEffectId(effectId)} -->`;
  return reviews.filter((review) => review.body.includes(marker));
}

function exactReviews(
  reviews: readonly GitHubPullRequestReviewProviderReview[],
  action: GitHubPullRequestReviewAction,
  commitSha: string,
  providerBody: string,
): GitHubPullRequestReviewProviderReview[] {
  const expectedState = reviewState(action);
  return reviews.filter((review) =>
    review.commitSha === commitSha
    && review.state === expectedState
    && canonicalBody(review.body) === providerBody
  );
}

function assertExactReview(
  review: GitHubPullRequestReviewProviderReview,
  repositoryFullName: string,
  pullRequestNumber: number,
  action: GitHubPullRequestReviewAction,
  commitSha: string,
  providerBody: string,
): void {
  if (
    normalizeGitHubRepository(review.repositoryFullName) !== repositoryFullName
    || review.pullRequestNumber !== pullRequestNumber
    || review.commitSha !== commitSha
    || review.state !== reviewState(action)
    || canonicalBody(review.body) !== providerBody
  ) {
    throw new RangeError("GitHub pull request review readback disagrees with the exact effect");
  }
}

function reviewState(action: GitHubPullRequestReviewAction): GitHubPullRequestReviewState {
  return action === "APPROVE"
    ? "approved"
    : action === "REQUEST_CHANGES"
    ? "changes_requested"
    : "commented";
}

function requireReviewVisibleBody(
  action: GitHubPullRequestReviewAction,
  body: string,
): void {
  if ((action === "REQUEST_CHANGES" || action === "COMMENT") && !body) {
    throw new RangeError(`${action} GitHub reviews require a visible review body`);
  }
}

function reviewAction(value: unknown): GitHubPullRequestReviewAction {
  if (
    typeof value !== "string"
    || !(githubPullRequestReviewActions as readonly string[]).includes(value)
  ) {
    throw new RangeError("GitHub pull request review action is invalid");
  }
  return value as GitHubPullRequestReviewAction;
}

function reviewEffectId(value: string): string {
  return boundedText(
    value,
    "GitHub formal review effect ID",
    96,
  ).match(/^stn-gh-review:[a-f0-9]{64}$/u)?.[0]
    ?? (() => { throw new RangeError("GitHub formal review effect ID is invalid"); })();
}

function exactReviewBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("GitHub pull request review body must be text");
  }
  if (byteLength(value) > MAXIMUM_GITHUB_PULL_REQUEST_REVIEW_BODY_BYTES - 128) {
    throw new RangeError("GitHub pull request review body is too large");
  }
  return value;
}

function fullRevision(value: string, label: string): string {
  const normalized = boundedText(value, label, 40).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new RangeError(`${label} must be a full Git revision`);
  }
  return normalized;
}

function hash(value: string, label: string): string {
  const normalized = boundedText(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new RangeError(`${label} must be a SHA-256 fingerprint`);
  }
  return normalized;
}

function canonicalTimestamp(value: string, label: string): string {
  const text = boundedText(value, label, 64);
  const milliseconds = Date.parse(text);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError(`${label} is invalid`);
  }
  return new Date(milliseconds).toISOString();
}

function isProviderRejected(error: unknown): error is GitHubProviderRejectedError {
  return Boolean(error)
    && typeof error === "object"
    && (error as { name?: unknown }).name === "GitHubProviderRejectedError";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
