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
    if (
      result.receipt.project !== admitted.project
      || result.receipt.idempotencyKey !== admitted.idempotencyKey
      || (
        result.outcome !== "conflict"
        && !sameReplayIdentity(result.receipt, admitted)
      )
      || (
        result.outcome === "reserved"
        && !sameReservationIdentity(result.receipt, admitted)
      )
    ) {
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
      canonicalGitHubProviderReceiptJson(stored)
      !== canonicalGitHubProviderReceiptJson(admitted)
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
  const record = exactDataRecord(value, reservationKeys);
  const outcome = record.outcome;
  if (
    typeof outcome !== "string"
    || !reservationOutcomes.includes(
      outcome as typeof reservationOutcomes[number],
    )
  ) {
    throw new GitHubProviderReceiptStorageError();
  }
  return {
    outcome: outcome as GitHubProviderReceiptReservation["outcome"],
    receipt: parseStoredReceipt(record.receiptJson),
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
    && current.attachmentSnapshotSha256
      === candidate.attachmentSnapshotSha256
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

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new GitHubProviderReceiptStorageError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) {
    throw new GitHubProviderReceiptStorageError();
  }
  const actualKeys = Object.keys(descriptors).sort();
  const canonicalKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalKeys.length
    || actualKeys.some((key, index) => key !== canonicalKeys[index])
  ) {
    throw new GitHubProviderReceiptStorageError();
  }
  const result: Record<string, unknown> = {};
  for (const key of canonicalKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new GitHubProviderReceiptStorageError();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactSlug(value: string, label: string): string {
  const result = exactText(value, label, 80);
  if (
    result !== result.toLowerCase()
    || !/^[a-z0-9][a-z0-9-_]*$/.test(result)
  ) {
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
