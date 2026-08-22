import type { GitHubMailAttentionDecision } from "./github-mail-bridge-core.js";
import {
  compileGitHubMailMaterial,
  type CompiledGitHubMailMaterial,
} from "./github-mail-material-compiler.js";
import type {
  HostedGmailOutboundMaterial,
} from "./hosted-gmail-outbound-service.js";
import { parseMailProjectCode } from "./mail-public-handle.js";
import {
  createMailThreadRecord,
  exactMailThreadIdentifier,
  type MailThreadRecord,
  type MailThreadState,
} from "./mail-thread-contract.js";
import type { MailThreadStore } from "./mail-thread-store.js";

export interface GitHubMailAutomaticOutboundPublisher<Result> {
  publish(material: HostedGmailOutboundMaterial): Promise<Result>;
}

export interface GitHubMailAutomaticPublisherOptions<Result> {
  store: MailThreadStore;
  publisher: GitHubMailAutomaticOutboundPublisher<Result>;
  workspace: string;
  project: string;
  publicProjectCode?: string | null;
  now?: () => string;
}

export type GitHubMailAutomaticPublishResult<Result> =
  | Readonly<{
      status: "quiet";
      sourceObservationId: string;
      materialFingerprint: string;
    }>
  | Readonly<{
      status: "published";
      sourceObservationId: string;
      materialFingerprint: string;
      threadId: string;
      handle: string;
      result: Result;
    }>;

export class GitHubMailAutomaticPublisher<Result> {
  readonly #store: MailThreadStore;
  readonly #publisher: GitHubMailAutomaticOutboundPublisher<Result>;
  readonly #workspace: string;
  readonly #project: string;
  readonly #publicProjectCode: string | null;
  readonly #now: () => string;

  constructor(options: GitHubMailAutomaticPublisherOptions<Result>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("GitHub mail automatic publisher options are required");
    }
    this.#store = options.store;
    this.#publisher = options.publisher;
    this.#workspace = exactMailThreadIdentifier(
      options.workspace,
      "GitHub mail automatic workspace",
      120,
    );
    this.#project = exactMailThreadIdentifier(
      options.project,
      "GitHub mail automatic project",
      120,
    );
    this.#publicProjectCode = options.publicProjectCode === undefined
      || options.publicProjectCode === null
      ? null
      : parseMailProjectCode(options.publicProjectCode);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async publish(
    decision: GitHubMailAttentionDecision,
  ): Promise<GitHubMailAutomaticPublishResult<Result>> {
    const material = compileGitHubMailMaterial(decision);
    if (material === null) {
      return Object.freeze({
        status: "quiet",
        sourceObservationId: decision.sourceObservationId,
        materialFingerprint: decision.materialFingerprint,
      });
    }

    const thread = await this.#ensureExactThread(decision, material);
    const result = await this.#publisher.publish({
      ...material,
      publicProjectCode: this.#publicProjectCode,
      currentMailboxState: {
        revision: decision.materialFingerprint,
        state: mailboxState(material.threadState),
        operatorAttentionRequired: false,
      },
    });
    return Object.freeze({
      status: "published",
      sourceObservationId: decision.sourceObservationId,
      materialFingerprint: decision.materialFingerprint,
      threadId: thread.threadId,
      handle: thread.handle,
      result,
    });
  }

  async #ensureExactThread(
    decision: GitHubMailAttentionDecision,
    material: CompiledGitHubMailMaterial,
  ): Promise<MailThreadRecord> {
    const candidate = createMailThreadRecord({
      threadId: decision.threadId,
      handle: decision.handle,
      workspace: this.#workspace,
      project: this.#project,
      threadClass: material.threadClass,
      canonicalSubject: material.canonicalSubject,
      sourceIdentity: material.sourceIdentity,
      resolutionCondition: material.resolutionCondition,
      continuesFromThreadId: null,
      createdAt: this.#now(),
    });
    const reservation = await this.#store.reserveThread(candidate);
    if (reservation.outcome !== "created" && reservation.outcome !== "existing") {
      throw new Error(
        "GitHub mail automatic publication conflicts with the canonical mail thread binding",
      );
    }
    assertExactThreadBinding(reservation.thread, candidate);
    return reservation.thread;
  }
}

function mailboxState(
  state: MailThreadState,
): HostedGmailOutboundMaterial["currentMailboxState"]["state"] {
  if (state === "open") return "active";
  if (state === "quiet") return "waiting";
  return "resolved";
}

function assertExactThreadBinding(
  actual: MailThreadRecord,
  expected: MailThreadRecord,
): void {
  if (
    actual.threadId !== expected.threadId
    || actual.handle !== expected.handle
    || actual.workspace !== expected.workspace
    || actual.project !== expected.project
    || actual.threadClass !== expected.threadClass
    || actual.canonicalSubject !== expected.canonicalSubject
    || actual.sourceIdentity !== expected.sourceIdentity
    || actual.continuesFromThreadId !== expected.continuesFromThreadId
  ) {
    throw new Error(
      "GitHub mail automatic publication resolved a different canonical mail thread binding",
    );
  }
}
