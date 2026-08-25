import { randomUUID } from "node:crypto";
import {
  compileCurrentGitHubMailAttention,
} from "./github-mail-attention-projection.js";
import {
  GitHubMailAutomaticPublisher,
  type GitHubMailAutomaticOutboundPublisher,
  type GitHubMailAutomaticPublishResult,
} from "./github-mail-automatic-publisher.js";
import type {
  GitHubMailThreadBinding,
} from "./github-mail-bridge-core.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import type { PublicGitHubRepositoryObservation } from "./github-public-repository-observation.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";
import {
  exactMailThreadIdentifier,
  generateMailThreadHandle,
  type MailThreadRecord,
} from "./mail-thread-contract.js";
import type { MailThreadStore } from "./mail-thread-store.js";

export interface GitHubMailPublicObservationConsumerOptions<Result> {
  readonly store: MailThreadStore;
  readonly publisher: GitHubMailAutomaticOutboundPublisher<Result>;
  readonly workspace: string;
  readonly project: string;
  readonly repository: string;
  readonly publicProjectCode: string;
  readonly now?: () => string;
  readonly threadIdFactory?: () => string;
  readonly handleFactory?: () => string;
}

export interface GitHubMailPublicObservationInput {
  readonly observation: PublicGitHubRepositoryObservation;
  readonly currentHeadRevision: string;
}

export type GitHubMailPublicObservationConsumeResult<Result> =
  | Readonly<{
      status: "ignored";
      reason:
        | "repository_mismatch"
        | "pull_request_unbound"
        | "current_head_unavailable"
        | "stale_current_head";
    }>
  | GitHubMailAutomaticPublishResult<Result>;

/**
 * Projection-only consumer for already-admitted public GitHub observations.
 * It shares the same canonical thread store and outbound publisher as webhook
 * mail, so public fallback can never create a second mail system.
 */
export class GitHubMailPublicObservationConsumer<Result> {
  readonly #store: MailThreadStore;
  readonly #automatic: GitHubMailAutomaticPublisher<Result>;
  readonly #workspace: string;
  readonly #project: string;
  readonly #repository: string;
  readonly #threadIdFactory: () => string;
  readonly #handleFactory: () => string;

  constructor(options: GitHubMailPublicObservationConsumerOptions<Result>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("GitHub public observation mail consumer options are required");
    }
    this.#store = options.store;
    this.#workspace = exactMailThreadIdentifier(
      options.workspace,
      "GitHub public observation mail workspace",
      120,
    );
    this.#project = exactMailThreadIdentifier(
      options.project,
      "GitHub public observation mail project",
      120,
    );
    this.#repository = normalizeGitHubRepository(options.repository);
    this.#threadIdFactory = options.threadIdFactory
      ?? (() => `mail_thread_${randomUUID()}`);
    this.#handleFactory = options.handleFactory
      ?? (() => generateMailThreadHandle("review"));
    this.#automatic = new GitHubMailAutomaticPublisher({
      store: options.store,
      publisher: options.publisher,
      workspace: this.#workspace,
      project: this.#project,
      publicProjectCode: options.publicProjectCode,
      now: options.now,
    });
  }

  async consume(
    input: GitHubMailPublicObservationInput,
  ): Promise<GitHubMailPublicObservationConsumeResult<Result>> {
    requirePublicProvenance(input.observation);
    const repository = normalizeGitHubRepository(input.observation.repository);
    if (repository !== this.#repository) {
      return Object.freeze({ status: "ignored", reason: "repository_mismatch" });
    }
    const pullRequestNumber = input.observation.relationships.pullRequestNumber;
    if (pullRequestNumber === null) {
      return Object.freeze({ status: "ignored", reason: "pull_request_unbound" });
    }
    const currentHeadRevision = exactRevisionOrNull(input.currentHeadRevision);
    if (currentHeadRevision === null) {
      return Object.freeze({ status: "ignored", reason: "current_head_unavailable" });
    }

    const sourceIdentity = `github:${repository}#${pullRequestNumber}`;
    const existing = await this.#store.getThreadBySource(
      this.#workspace,
      this.#project,
      sourceIdentity,
    );
    const thread = existing === null
      ? freshBinding({
          project: this.#project,
          repository,
          pullRequestNumber,
          currentHeadRevision,
          threadId: this.#threadIdFactory(),
          handle: this.#handleFactory(),
        })
      : bindingFromThread(
          existing,
          repository,
          pullRequestNumber,
          currentHeadRevision,
        );

    let decision;
    try {
      decision = compileCurrentGitHubMailAttention({
        thread,
        signal: Object.freeze({
          kind: "repository_observation" as const,
          // The attention compiler consumes the admitted semantic fields only.
          // Public provenance was already validated and stays durable upstream.
          observation: input.observation as unknown as GitHubRepositoryObservation,
        }),
      });
    } catch (error) {
      if (isStaleCurrentHeadError(error)) {
        return Object.freeze({ status: "ignored", reason: "stale_current_head" });
      }
      throw error;
    }
    return await this.#automatic.publish(decision);
  }
}

function requirePublicProvenance(
  observation: PublicGitHubRepositoryObservation,
): void {
  if (observation.sourceSchema !== "github-public-events") {
    throw new RangeError("GitHub public observation mail requires public-event provenance");
  }
}

function freshBinding(input: {
  readonly project: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly currentHeadRevision: string;
  readonly threadId: string;
  readonly handle: string;
}): GitHubMailThreadBinding {
  return Object.freeze({
    version: 1,
    threadId: exactMailThreadIdentifier(input.threadId, "GitHub mail thread ID", 240),
    handle: input.handle,
    project: input.project,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    currentHeadRevision: input.currentHeadRevision,
    continuesFromThreadId: null,
  });
}

function bindingFromThread(
  thread: MailThreadRecord,
  repository: string,
  pullRequestNumber: number,
  currentHeadRevision: string,
): GitHubMailThreadBinding {
  const expectedSourceIdentity = `github:${repository}#${pullRequestNumber}`;
  if (thread.sourceIdentity !== expectedSourceIdentity) {
    throw new Error("GitHub public observation mail source identity changed");
  }
  return Object.freeze({
    version: 1,
    threadId: thread.threadId,
    handle: thread.handle,
    project: thread.project,
    repository,
    pullRequestNumber,
    currentHeadRevision,
    continuesFromThreadId: thread.continuesFromThreadId,
  });
}

function exactRevisionOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const revision = value.toLowerCase();
  return /^[a-f0-9]{40}$/u.test(revision) ? revision : null;
}

function isStaleCurrentHeadError(error: unknown): boolean {
  return error instanceof RangeError
    && error.message === "GitHub formal review belongs to a stale pull request revision";
}
