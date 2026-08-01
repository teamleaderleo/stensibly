import type {
  GitHubProviderReceipt,
  GitHubProviderReceiptReservation,
  GitHubProviderReceiptStore,
} from "./github-provider-contracts.js";

export class InMemoryGitHubProviderReceiptStore
  implements GitHubProviderReceiptStore {
  readonly #receipts = new Map<string, GitHubProviderReceipt>();

  async reserveGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceiptReservation> {
    const key = receiptKey(receipt.project, receipt.idempotencyKey);
    const current = this.#receipts.get(key);
    if (!current) {
      this.#receipts.set(key, clone(receipt));
      return { outcome: "reserved", receipt: clone(receipt) };
    }
    const sameRequest = sameReplayIdentity(current, receipt);
    if (sameRequest && current.state === "reserved") {
      const pending: GitHubProviderReceipt = {
        ...current,
        state: "pending_reconciliation",
        error: {
          code: "provider_dispatch_in_progress_or_interrupted",
          message: "GitHub provider dispatch may still be in progress or may have been interrupted",
          retry: "reconcile_before_retry",
        },
        recovery: { nextAction: "reconcile_exact_operation" },
      };
      this.#receipts.set(key, clone(pending));
      return { outcome: "replay", receipt: clone(pending) };
    }
    return {
      outcome: sameRequest ? "replay" : "conflict",
      receipt: clone(current),
    };
  }

  async updateGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceipt> {
    const key = receiptKey(receipt.project, receipt.idempotencyKey);
    const current = this.#receipts.get(key);
    if (!current) {
      throw new Error("GitHub provider receipt must be reserved before update");
    }
    if (!sameReservationIdentity(current, receipt)) {
      throw new Error("GitHub provider receipt update does not match the reservation");
    }
    this.#receipts.set(key, clone(receipt));
    return clone(receipt);
  }

  async getGitHubProviderReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null> {
    return clone(this.#receipts.get(receiptKey(project, idempotencyKey)) ?? null);
  }
}

function sameReplayIdentity(
  current: GitHubProviderReceipt,
  candidate: GitHubProviderReceipt,
): boolean {
  return current.version === candidate.version
    && current.project === candidate.project
    && current.provider === candidate.provider
    && current.repositoryFullName === candidate.repositoryFullName
    && current.operation === candidate.operation
    && current.target === candidate.target
    && current.actorId === candidate.actorId
    && current.clientId === candidate.clientId
    && current.connectionId === candidate.connectionId
    && current.installationId === candidate.installationId
    && current.bindingId === candidate.bindingId
    && current.attachmentId === candidate.attachmentId
    && current.attachmentSnapshotSha256 === candidate.attachmentSnapshotSha256
    && current.capabilityGrantId === candidate.capabilityGrantId
    && current.approvalId === candidate.approvalId
    && current.idempotencyKey === candidate.idempotencyKey
    && current.parametersSha256 === candidate.parametersSha256;
}

function sameReservationIdentity(
  current: GitHubProviderReceipt,
  candidate: GitHubProviderReceipt,
): boolean {
  return current.id === candidate.id
    && current.createdAt === candidate.createdAt
    && sameReplayIdentity(current, candidate);
}

function receiptKey(project: string, idempotencyKey: string): string {
  return `${project}\u0000${idempotencyKey}`;
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}
