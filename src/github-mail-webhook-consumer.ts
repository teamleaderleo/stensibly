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
  GitHubMailBridgeSignal,
  GitHubMailThreadBinding,
} from "./github-mail-bridge-core.js";
import {
  mapGitHubMailTerminalWebhook,
} from "./github-mail-terminal-webhook.js";
import {
  normalizeGitHubRepository,
} from "./github-provider-validation.js";
import type { PreparedGitHubWebhookDelivery } from "./github-webhook-ingress.js";
import {
  generateMailThreadHandle,
  exactMailThreadIdentifier,
  type MailThreadRecord,
} from "./mail-thread-contract.js";
import type { MailThreadStore } from "./mail-thread-store.js";

export interface GitHubMailWebhookConsumerOptions<Result> {
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

export type GitHubMailWebhookConsumeResult<Result> =
  | Readonly<{
      status: "ignored";
      reason:
        | "repository_mismatch"
        | "unsupported_event"
        | "pull_request_unbound"
        | "current_head_unavailable"
        | "stale_current_head";
    }>
  | GitHubMailAutomaticPublishResult<Result>;

/**
 * Hosted bridge from one already verified GitHub webhook delivery into the
 * existing automatic outbound mail path. It owns no provider authority and
 * creates no durable thread for quiet activity.
 */
export class GitHubMailWebhookConsumer<Result> {
  readonly #store: MailThreadStore;
  readonly #automatic: GitHubMailAutomaticPublisher<Result>;
  readonly #workspace: string;
  readonly #project: string;
  readonly #repository: string;
  readonly #threadIdFactory: () => string;
  readonly #handleFactory: () => string;

  constructor(options: GitHubMailWebhookConsumerOptions<Result>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("GitHub mail webhook consumer options are required");
    }
    this.#store = options.store;
    this.#workspace = exactMailThreadIdentifier(
      options.workspace,
      "GitHub mail webhook workspace",
      120,
    );
    this.#project = exactMailThreadIdentifier(
      options.project,
      "GitHub mail webhook project",
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
    delivery: PreparedGitHubWebhookDelivery,
  ): Promise<GitHubMailWebhookConsumeResult<Result>> {
    const prepared = signalFromDelivery(delivery);
    if (prepared === null) {
      return Object.freeze({ status: "ignored", reason: "unsupported_event" });
    }
    if (prepared.repository !== this.#repository) {
      return Object.freeze({ status: "ignored", reason: "repository_mismatch" });
    }
    if (prepared.pullRequestNumber === null) {
      return Object.freeze({ status: "ignored", reason: "pull_request_unbound" });
    }
    if (prepared.currentHeadRevision === null) {
      return Object.freeze({ status: "ignored", reason: "current_head_unavailable" });
    }

    const sourceIdentity = `github:${this.#repository}#${prepared.pullRequestNumber}`;
    const existing = await this.#store.getThreadBySource(
      this.#workspace,
      this.#project,
      sourceIdentity,
    );
    const thread = existing === null
      ? freshBinding({
          project: this.#project,
          repository: this.#repository,
          pullRequestNumber: prepared.pullRequestNumber,
          currentHeadRevision: prepared.currentHeadRevision,
          threadId: this.#threadIdFactory(),
          handle: this.#handleFactory(),
        })
      : bindingFromThread(
          existing,
          this.#repository,
          prepared.pullRequestNumber,
          prepared.currentHeadRevision,
        );
    let decision;
    try {
      decision = compileCurrentGitHubMailAttention({
        thread,
        signal: prepared.signal,
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

interface PreparedSignal {
  readonly signal: GitHubMailBridgeSignal;
  readonly repository: string;
  readonly pullRequestNumber: number | null;
  readonly currentHeadRevision: string | null;
}

function signalFromDelivery(
  delivery: PreparedGitHubWebhookDelivery,
): PreparedSignal | null {
  if (
    delivery.signatureAlgorithm !== "hmac-sha256"
    || delivery.payloadAvailability !== "memory_only"
    || delivery.containsRawBody !== false
  ) {
    throw new RangeError("GitHub mail webhook consumer requires verified ingress");
  }

  const observation = delivery.observation;
  if (observation !== null) {
    const pullRequestNumber = observation.relationships.pullRequestNumber;
    if (pullRequestNumber === null) return null;
    if (
      observation.eventType !== "pull_request"
      && observation.eventType !== "pull_request_review"
      && observation.eventType !== "pull_request_review_comment"
      && observation.eventType !== "issue_comment"
    ) {
      return null;
    }
    if (
      observation.eventType === "pull_request_review_comment"
      || observation.eventType === "issue_comment"
    ) {
      return null;
    }
    return Object.freeze({
      signal: Object.freeze({
        kind: "repository_observation" as const,
        observation,
      }),
      repository: observation.repository,
      pullRequestNumber,
      currentHeadRevision: currentPullRequestHead(
        delivery.payload,
        pullRequestNumber,
      ),
    });
  }

  const terminal = mapGitHubMailTerminalWebhook(delivery);
  if (terminal === null) return null;
  return Object.freeze({
    signal: Object.freeze({
      kind: "terminal_status" as const,
      observation: terminal,
    }),
    repository: terminal.repository,
    pullRequestNumber: terminal.pullRequestNumber,
    currentHeadRevision: terminal.pullRequestNumber === null
      ? null
      : currentPullRequestHead(delivery.payload, terminal.pullRequestNumber),
  });
}

function currentPullRequestHead(
  payloadValue: unknown,
  pullRequestNumber: number,
): string | null {
  const payload = plainRecord(payloadValue);
  if (payload === null) return null;

  const direct = plainRecord(payload.pull_request);
  if (direct !== null) {
    const number = positiveIntegerOrNull(direct.number ?? payload.number);
    if (number === pullRequestNumber) {
      return headRevision(direct.head);
    }
  }

  for (const ownerKey of ["check_run", "check_suite", "workflow_run"] as const) {
    const owner = plainRecord(payload[ownerKey]);
    if (owner === null || !Array.isArray(owner.pull_requests)) continue;
    let matched: string | null = null;
    for (const value of owner.pull_requests) {
      const reference = plainRecord(value);
      if (reference === null) continue;
      if (positiveIntegerOrNull(reference.number) !== pullRequestNumber) continue;
      const revision = headRevision(reference.head);
      if (revision === null) return null;
      if (matched !== null && matched !== revision) return null;
      matched = revision;
    }
    if (matched !== null) return matched;
  }
  return null;
}

function headRevision(value: unknown): string | null {
  const head = plainRecord(value);
  if (head === null || typeof head.sha !== "string") return null;
  const revision = head.sha.toLowerCase();
  return /^[a-f0-9]{40}$/u.test(revision) ? revision : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
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
    throw new Error("GitHub mail source thread identity changed");
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

function isStaleCurrentHeadError(error: unknown): boolean {
  return error instanceof RangeError
    && (
      error.message === "GitHub terminal status belongs to a stale pull request revision"
      || error.message === "GitHub formal review belongs to a stale pull request revision"
    );
}
