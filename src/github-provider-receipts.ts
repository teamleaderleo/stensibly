import type {
  GitHubProviderReceipt,
  GitHubRepositoryWriteLane,
  GitHubRepositoryWriteLaneReservation,
  GitHubProviderReceiptReservation,
  GitHubProviderReceiptStore,
} from "./github-provider-contracts.js";

export class InMemoryGitHubProviderReceiptStore
  implements GitHubProviderReceiptStore {
  readonly #receipts = new Map<string, GitHubProviderReceipt>();
  readonly #repositoryWriteLanes = new Map<string, GitHubRepositoryWriteLane>();

  async reserveGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceiptReservation> {
    const key = receiptKey(receipt.project, receipt.idempotencyKey);
    const current = this.#receipts.get(key);
    if (!current) {
      this.#receipts.set(key, clone(receipt));
      return { outcome: "reserved", receipt: clone(receipt) };
    }
    const sameRequest = current.operation === receipt.operation
      && current.parametersSha256 === receipt.parametersSha256
      && current.repositoryFullName === receipt.repositoryFullName
      && current.actorId === receipt.actorId
      && current.clientId === receipt.clientId;
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

  async reserveGitHubRepositoryWriteLane(
    lane: GitHubRepositoryWriteLane,
  ): Promise<GitHubRepositoryWriteLaneReservation> {
    const key = repositoryWriteLaneKey(
      lane.project,
      lane.repositoryFullName,
      lane.targetRef,
    );
    const current = this.#repositoryWriteLanes.get(key);
    if (current) {
      return { outcome: "blocked", lane: clone(current) };
    }
    this.#repositoryWriteLanes.set(key, clone(lane));
    return { outcome: "reserved", lane: clone(lane) };
  }

  async releaseGitHubRepositoryWriteLane(input: {
    project: string;
    repositoryFullName: string;
    targetRef: string;
    receiptId: string;
  }): Promise<void> {
    const key = repositoryWriteLaneKey(
      input.project,
      input.repositoryFullName,
      input.targetRef,
    );
    const current = this.#repositoryWriteLanes.get(key);
    if (!current) return;
    if (current.receiptId !== input.receiptId) {
      throw new Error("GitHub repository write lane release does not match its reservation");
    }
    this.#repositoryWriteLanes.delete(key);
  }

  async updateGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceipt> {
    const key = receiptKey(receipt.project, receipt.idempotencyKey);
    const current = this.#receipts.get(key);
    if (!current) {
      throw new Error("GitHub provider receipt must be reserved before update");
    }
    if (current.id !== receipt.id) {
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

function receiptKey(project: string, idempotencyKey: string): string {
  return `${project}\u0000${idempotencyKey}`;
}

function repositoryWriteLaneKey(
  project: string,
  repositoryFullName: string,
  targetRef: string,
): string {
  return `${project}\u0000${repositoryFullName}\u0000${targetRef}`;
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}
