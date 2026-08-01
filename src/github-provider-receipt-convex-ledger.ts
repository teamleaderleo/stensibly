import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import type {
  GitHubProviderReceipt,
  GitHubProviderReceiptReservation,
  GitHubProviderReceiptStore,
} from "./github-provider-contracts.js";
import {
  canonicalGitHubProviderReceiptJson,
  parseGitHubProviderReceiptJson,
} from "./github-provider-receipt-admission.js";

const reserveRef = makeFunctionReference<"mutation">(
  "githubProviderReceipts:reserve",
);
const updateRef = makeFunctionReference<"mutation">(
  "githubProviderReceipts:update",
);
const getRef = makeFunctionReference<"query">("githubProviderReceipts:get");
const reservationKeys = ["outcome", "receiptJson"] as const;
const reservationOutcomes = ["reserved", "replay", "conflict"] as const;

export interface ConvexGitHubProviderReceiptStoreOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class ConvexGitHubProviderReceiptStore
  implements GitHubProviderReceiptStore {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexGitHubProviderReceiptStoreOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = exactSlug(options.workspace ?? "default", "Workspace");
  }

  async reserveGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceiptReservation> {
    const admitted = parseGitHubProviderReceiptJson(
      canonicalGitHubProviderReceiptJson(receipt),
    );
    const raw = await this.client.mutation(reserveRef, this.args({
      project: admitted.project,
      receiptJson: canonicalGitHubProviderReceiptJson(admitted),
    }));
    const result = admitReservation(raw);
    if (result.receipt.project !== admitted.project) {
      throw new GitHubProviderReceiptStorageError();
    }
    return Object.freeze(result);
  }

  async updateGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceipt> {
    const admitted = parseGitHubProviderReceiptJson(
      canonicalGitHubProviderReceiptJson(receipt),
    );
    const raw = await this.client.mutation(updateRef, this.args({
      project: admitted.project,
      receiptJson: canonicalGitHubProviderReceiptJson(admitted),
    }));
    const stored = parseStoredReceipt(raw);
    if (
      stored.project !== admitted.project
      || stored.id !== admitted.id
      || stored.idempotencyKey !== admitted.idempotencyKey
    ) {
      throw new GitHubProviderReceiptStorageError();
    }
    return stored;
  }

  async getGitHubProviderReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null> {
    const exactProject = exactSlug(project, "Project");
    const exactKey = exactText(idempotencyKey, "Idempotency key", 240);
    const raw = await this.client.query(getRef, this.args({
      project: exactProject,
      idempotencyKey: exactKey,
    }));
    if (raw === null) return null;
    const receipt = parseStoredReceipt(raw);
    if (
      receipt.project !== exactProject
      || receipt.idempotencyKey !== exactKey
    ) {
      throw new GitHubProviderReceiptStorageError();
    }
    return receipt;
  }

  private args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
    };
  }
}

export function withConvexGitHubProviderReceiptStore<T extends object>(
  target: T,
  options: ConvexGitHubProviderReceiptStoreOptions,
): T & GitHubProviderReceiptStore {
  const service = new ConvexGitHubProviderReceiptStore(options);
  return Object.assign(target, {
    reserveGitHubProviderReceipt:
      service.reserveGitHubProviderReceipt.bind(service),
    updateGitHubProviderReceipt:
      service.updateGitHubProviderReceipt.bind(service),
    getGitHubProviderReceipt: service.getGitHubProviderReceipt.bind(service),
  });
}

export class GitHubProviderReceiptStorageError extends Error {
  readonly code = "github_provider_receipt_storage_failed";

  constructor() {
    super("GitHub provider receipt storage failed");
    this.name = "GitHubProviderReceiptStorageError";
  }
}

function admitReservation(value: unknown): GitHubProviderReceiptReservation {
  if (!isRecord(value) || !hasExactKeys(value, reservationKeys)) {
    throw new GitHubProviderReceiptStorageError();
  }
  if (
    typeof value.outcome !== "string"
    || !reservationOutcomes.includes(
      value.outcome as typeof reservationOutcomes[number],
    )
  ) {
    throw new GitHubProviderReceiptStorageError();
  }
  return {
    outcome: value.outcome as GitHubProviderReceiptReservation["outcome"],
    receipt: parseStoredReceipt(value.receiptJson),
  };
}

function parseStoredReceipt(value: unknown): GitHubProviderReceipt {
  if (typeof value !== "string") {
    throw new GitHubProviderReceiptStorageError();
  }
  try {
    return parseGitHubProviderReceiptJson(value);
  } catch {
    throw new GitHubProviderReceiptStorageError();
  }
}

function exactSlug(value: string, label: string): string {
  const result = exactText(value, label, 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(result)) {
    throw new RangeError(`${label} must be a lowercase slug`);
  }
  return result;
}

function exactText(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function required(value: string, label: string): string {
  return exactText(value, label, 1_000);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
