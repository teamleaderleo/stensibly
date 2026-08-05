import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  admitGitHubRepositoryWriteIdentifier,
} from "./github-repository-write-identifier-admission.js";
import {
  admitGitHubRepositoryWriteReceipt,
  canonicalGitHubRepositoryWriteReceiptJson,
  parseGitHubRepositoryWriteReceiptJson,
} from "./github-repository-write-receipt-admission.js";
import type {
  GitHubRepositoryWriteReceipt,
  GitHubRepositoryWriteReservation,
  GitHubRepositoryWriteStore,
} from "./github-repository-write-provider-service.js";

export {
  canonicalGitHubRepositoryWriteReceiptJson,
  fingerprintGitHubRepositoryWriteReceipt,
  parseGitHubRepositoryWriteReceiptJson,
} from "./github-repository-write-receipt-admission.js";

const reserveRef = makeFunctionReference<"mutation">(
  "githubRepositoryWrites:reserve",
);
const transitionRef = makeFunctionReference<"mutation">(
  "githubRepositoryWrites:transition",
);
const getRef = makeFunctionReference<"query">("githubRepositoryWrites:get");

const reservationOutcomes = [
  "reserved",
  "replay",
  "conflict",
  "blocked",
] as const;
const transitionActions = [
  "reject_and_release",
  "hold_for_reconciliation",
  "record_verified",
  "hold_verified_for_reconciliation",
  "release_verified",
] as const;

type RepositoryWriteTransitionAction = typeof transitionActions[number];

export interface ConvexGitHubRepositoryWriteStoreOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

/**
 * Hosted client for the atomic repository-write receipt and ref-lane store.
 *
 * The client computes the only admissible next receipt for each lifecycle
 * transition and requires Convex to return that exact canonical receipt.
 * Provider authority and dispatch remain outside this storage adapter.
 */
export class ConvexGitHubRepositoryWriteStore
  implements GitHubRepositoryWriteStore
{
  readonly #client: ConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: ConvexGitHubRepositoryWriteStoreOptions) {
    this.#client = options.client;
    this.#serviceSecret = required(
      options.serviceSecret,
      "Convex service secret",
    );
    this.#workspace = exactSlug(options.workspace ?? "default", "Workspace");
  }

  async reserveRepositoryWrite(
    receiptInput: GitHubRepositoryWriteReceipt,
  ): Promise<GitHubRepositoryWriteReservation> {
    const requested = storedReceipt(receiptInput);
    const raw = await this.#client.mutation(reserveRef, this.#args({
      project: requested.project,
      receiptJson: canonicalReceiptJson(requested),
    }));
    const result = admitReservation(raw);
    if (!validReservation(result, requested)) {
      throw new GitHubRepositoryWriteStorageError();
    }
    return Object.freeze(result);
  }

  async rejectAndReleaseRepositoryWrite(input: {
    receipt: GitHubRepositoryWriteReceipt;
    code: string;
    rejectedAt: string;
  }): Promise<GitHubRepositoryWriteReceipt> {
    const current = storedReceipt(input.receipt);
    return this.#transition("reject_and_release", current, {
      ...current,
      state: "rejected",
      updatedAt: input.rejectedAt,
      error: {
        code: input.code,
        retry: "do_not_retry",
      },
    });
  }

  async holdRepositoryWriteForReconciliation(input: {
    receipt: GitHubRepositoryWriteReceipt;
    code: string;
    heldAt: string;
  }): Promise<GitHubRepositoryWriteReceipt> {
    const current = storedReceipt(input.receipt);
    return this.#transition("hold_for_reconciliation", current, {
      ...current,
      state: "pending_reconciliation",
      updatedAt: input.heldAt,
      error: {
        code: input.code,
        retry: "reconcile_before_retry",
      },
    });
  }

  async recordVerifiedRepositoryWrite(input: {
    receipt: GitHubRepositoryWriteReceipt;
    verified: NonNullable<GitHubRepositoryWriteReceipt["verified"]>;
  }): Promise<GitHubRepositoryWriteReceipt> {
    const current = storedReceipt(input.receipt);
    return this.#transition("record_verified", current, {
      ...current,
      state: "verified_pending_release",
      dispatchCount: 1,
      updatedAt: input.verified.verifiedAt,
      verified: input.verified,
      error: {
        code: "repository_write_settlement_incomplete",
        retry: "reconcile_before_retry",
      },
    });
  }

  async holdVerifiedRepositoryWriteForReconciliation(input: {
    receipt: GitHubRepositoryWriteReceipt;
    verified: NonNullable<GitHubRepositoryWriteReceipt["verified"]>;
    code: string;
    heldAt: string;
  }): Promise<GitHubRepositoryWriteReceipt> {
    const current = storedReceipt(input.receipt);
    return this.#transition("hold_verified_for_reconciliation", current, {
      ...current,
      state: "verified_pending_release",
      dispatchCount: 1,
      updatedAt: input.heldAt,
      verified: input.verified,
      error: {
        code: input.code,
        retry: "reconcile_before_retry",
      },
    });
  }

  async releaseVerifiedRepositoryWrite(input: {
    receipt: GitHubRepositoryWriteReceipt;
    releasedAt: string;
  }): Promise<GitHubRepositoryWriteReceipt> {
    const current = storedReceipt(input.receipt);
    return this.#transition("release_verified", current, {
      ...current,
      state: "succeeded",
      updatedAt: input.releasedAt,
      error: null,
    });
  }

  async getRepositoryWriteReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubRepositoryWriteReceipt | null> {
    const exactProject = exactSlug(project, "Project");
    const exactKey = storedIdentifier(idempotencyKey);
    const raw = await this.#client.query(getRef, this.#args({
      project: exactProject,
      idempotencyKey: exactKey,
    }));
    if (raw === null) return null;
    const receipt = parseStoredReceipt(raw);
    if (
      receipt.project !== exactProject
      || receipt.idempotencyKey !== exactKey
    ) {
      throw new GitHubRepositoryWriteStorageError();
    }
    return receipt;
  }

  async #transition(
    action: RepositoryWriteTransitionAction,
    currentInput: GitHubRepositoryWriteReceipt,
    nextInput: GitHubRepositoryWriteReceipt,
  ): Promise<GitHubRepositoryWriteReceipt> {
    const current = storedReceipt(currentInput);
    const next = storedReceipt(nextInput);
    if (!sameReservationIdentity(current, next)) {
      throw new GitHubRepositoryWriteStorageError();
    }
    const raw = await this.#client.mutation(transitionRef, this.#args({
      project: current.project,
      action,
      currentReceiptJson: canonicalReceiptJson(current),
      nextReceiptJson: canonicalReceiptJson(next),
    }));
    const stored = parseStoredReceipt(raw);
    if (canonicalReceiptJson(stored) !== canonicalReceiptJson(next)) {
      throw new GitHubRepositoryWriteStorageError();
    }
    return stored;
  }

  #args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      serviceSecret: this.#serviceSecret,
      workspace: this.#workspace,
    };
  }
}

export function withConvexGitHubRepositoryWriteStore<T extends object>(
  target: T,
  options: ConvexGitHubRepositoryWriteStoreOptions,
): T & GitHubRepositoryWriteStore {
  const service = new ConvexGitHubRepositoryWriteStore(options);
  return Object.assign(target, {
    reserveRepositoryWrite: service.reserveRepositoryWrite.bind(service),
    rejectAndReleaseRepositoryWrite:
      service.rejectAndReleaseRepositoryWrite.bind(service),
    holdRepositoryWriteForReconciliation:
      service.holdRepositoryWriteForReconciliation.bind(service),
    recordVerifiedRepositoryWrite:
      service.recordVerifiedRepositoryWrite.bind(service),
    holdVerifiedRepositoryWriteForReconciliation:
      service.holdVerifiedRepositoryWriteForReconciliation.bind(service),
    releaseVerifiedRepositoryWrite:
      service.releaseVerifiedRepositoryWrite.bind(service),
    getRepositoryWriteReceipt:
      service.getRepositoryWriteReceipt.bind(service),
  });
}

export class GitHubRepositoryWriteStorageError extends Error {
  readonly code = "github_repository_write_storage_failed";

  constructor() {
    super("GitHub repository write storage failed");
    this.name = "GitHubRepositoryWriteStorageError";
  }
}

function storedIdentifier(value: unknown): string {
  try {
    return admitGitHubRepositoryWriteIdentifier(value);
  } catch {
    throw new GitHubRepositoryWriteStorageError();
  }
}

function storedReceipt(value: unknown): GitHubRepositoryWriteReceipt {
  try {
    return admitGitHubRepositoryWriteReceipt(value);
  } catch {
    throw new GitHubRepositoryWriteStorageError();
  }
}

function parseStoredReceipt(value: unknown): GitHubRepositoryWriteReceipt {
  try {
    return parseGitHubRepositoryWriteReceiptJson(value);
  } catch {
    throw new GitHubRepositoryWriteStorageError();
  }
}

function canonicalReceiptJson(receipt: GitHubRepositoryWriteReceipt): string {
  try {
    return canonicalGitHubRepositoryWriteReceiptJson(receipt);
  } catch {
    throw new GitHubRepositoryWriteStorageError();
  }
}

function admitReservation(value: unknown): GitHubRepositoryWriteReservation {
  const record = exactDataRecord(value, ["outcome", "receiptJson"]);
  const outcome = record.outcome;
  if (
    typeof outcome !== "string"
    || !reservationOutcomes.includes(
      outcome as typeof reservationOutcomes[number],
    )
  ) {
    throw new GitHubRepositoryWriteStorageError();
  }
  return {
    outcome: outcome as GitHubRepositoryWriteReservation["outcome"],
    receipt: parseStoredReceipt(record.receiptJson),
  };
}

function validReservation(
  result: GitHubRepositoryWriteReservation,
  requested: GitHubRepositoryWriteReceipt,
): boolean {
  const current = result.receipt;
  if (current.project !== requested.project) return false;
  if (result.outcome === "reserved") {
    return canonicalReceiptJson(current) === canonicalReceiptJson(requested);
  }
  if (result.outcome === "replay") {
    return current.idempotencyKey === requested.idempotencyKey
      && sameRequest(current, requested);
  }
  if (result.outcome === "conflict") {
    return current.idempotencyKey === requested.idempotencyKey
      && !sameRequest(current, requested);
  }
  return current.idempotencyKey !== requested.idempotencyKey
    && current.repositoryFullName === requested.repositoryFullName
    && current.targetRef === requested.targetRef
    && (
      current.state === "reserved"
      || current.state === "pending_reconciliation"
      || current.state === "verified_pending_release"
    );
}

function sameRequest(
  left: GitHubRepositoryWriteReceipt,
  right: GitHubRepositoryWriteReceipt,
): boolean {
  return left.requestSha256 === right.requestSha256
    && left.payloadSha256 === right.payloadSha256
    && left.repositoryFullName === right.repositoryFullName
    && left.targetRef === right.targetRef
    && left.path === right.path
    && left.operation === right.operation
    && left.expectedParentSha === right.expectedParentSha
    && left.actorId === right.actorId
    && left.clientId === right.clientId;
}

function sameReservationIdentity(
  left: GitHubRepositoryWriteReceipt,
  right: GitHubRepositoryWriteReceipt,
): boolean {
  return left.version === right.version
    && left.id === right.id
    && left.project === right.project
    && left.repositoryFullName === right.repositoryFullName
    && left.targetRef === right.targetRef
    && left.path === right.path
    && left.operation === right.operation
    && left.expectedParentSha === right.expectedParentSha
    && left.requestSha256 === right.requestSha256
    && left.payloadSha256 === right.payloadSha256
    && left.actorId === right.actorId
    && left.clientId === right.clientId
    && left.idempotencyKey === right.idempotencyKey
    && left.createdAt === right.createdAt;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new GitHubRepositoryWriteStorageError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new GitHubRepositoryWriteStorageError();
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new GitHubRepositoryWriteStorageError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort();
  const canonicalKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalKeys.length
    || actualKeys.some((key, index) => key !== canonicalKeys[index])
  ) {
    throw new GitHubRepositoryWriteStorageError();
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of canonicalKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new GitHubRepositoryWriteStorageError();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactSlug(value: string, label: string): string {
  const result = exactText(value, label, 80);
  if (
    result !== result.toLowerCase()
    || !/^[a-z0-9][a-z0-9-_]*$/u.test(result)
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
