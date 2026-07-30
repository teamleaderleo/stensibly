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
    const sameRequest = current.operation === receipt.operation
      && current.parametersSha256 === receipt.parametersSha256
      && current.repositoryFullName === receipt.repositoryFullName
      && current.actorId === receipt.actorId
      && current.clientId === receipt.clientId;
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

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}
