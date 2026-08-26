import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  parseAccountUsageReservationReceipt,
  type AccountUsageReservationReceipt,
  type AccountUsageSubject,
  type ReconcileAccountUsageInput,
  type ReserveAccountUsageInput,
  type SettleAccountUsageInput,
} from "./account-usage-reservation.js";

const reserveRef = makeFunctionReference<"mutation">(
  "accountUsageReservations:reserve",
);
const getRef = makeFunctionReference<"query">(
  "accountUsageReservations:get",
);
const settleRef = makeFunctionReference<"mutation">(
  "accountUsageReservations:settle",
);
const reconcileRef = makeFunctionReference<"mutation">(
  "accountUsageReservations:reconcile",
);

const reservationKeys = ["outcome", "receiptJson"] as const;
const reservationOutcomes = ["reserved", "replay", "conflict"] as const;

export interface AccountUsageReservationPersistenceResult {
  outcome: typeof reservationOutcomes[number];
  receipt: AccountUsageReservationReceipt;
}

export interface ConvexAccountUsageReservationStoreOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class ConvexAccountUsageReservationStore {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexAccountUsageReservationStoreOptions) {
    this.client = options.client;
    this.serviceSecret = exactText(
      options.serviceSecret,
      "Convex service secret",
      1_000,
    );
    this.workspace = exactSlug(options.workspace ?? "default", "Workspace");
  }

  async reserve(
    input: ReserveAccountUsageInput,
  ): Promise<AccountUsageReservationPersistenceResult> {
    const subject = this.subject(input.subject);
    const raw = await this.client.mutation(reserveRef, this.args({
      subjectKind: subject.kind,
      subjectId: subject.id,
      serviceClass: input.serviceClass,
      windowId: input.windowId,
      requestIdentity: input.requestIdentity,
      units: input.units,
      admissionDecisionFingerprint: input.admissionDecisionFingerprint,
      currentTime: input.currentTime,
    }));
    const result = admitReservation(raw);
    this.assertRoute(result.receipt, subject, input.requestIdentity);
    return Object.freeze(result);
  }

  async get(
    subjectInput: AccountUsageSubject,
    requestIdentity: string,
  ): Promise<AccountUsageReservationReceipt | null> {
    const subject = this.subject(subjectInput);
    const exactRequestIdentity = exactText(
      requestIdentity,
      "Request identity",
      240,
    );
    const raw = await this.client.query(getRef, this.args({
      subjectKind: subject.kind,
      subjectId: subject.id,
      requestIdentity: exactRequestIdentity,
    }));
    if (raw === null) return null;
    const receipt = parseStoredReceipt(raw);
    this.assertRoute(receipt, subject, exactRequestIdentity);
    return receipt;
  }

  async settle(
    subjectInput: AccountUsageSubject,
    requestIdentity: string,
    input: SettleAccountUsageInput,
  ): Promise<AccountUsageReservationReceipt> {
    const subject = this.subject(subjectInput);
    const exactRequestIdentity = exactText(
      requestIdentity,
      "Request identity",
      240,
    );
    const raw = await this.client.mutation(settleRef, this.args({
      subjectKind: subject.kind,
      subjectId: subject.id,
      requestIdentity: exactRequestIdentity,
      outcome: input.outcome,
      settlementReference: input.settlementReference,
      currentTime: input.currentTime,
    }));
    const receipt = parseStoredReceipt(raw);
    this.assertRoute(receipt, subject, exactRequestIdentity);
    return receipt;
  }

  async reconcile(
    subjectInput: AccountUsageSubject,
    requestIdentity: string,
    input: ReconcileAccountUsageInput,
  ): Promise<AccountUsageReservationReceipt> {
    const subject = this.subject(subjectInput);
    const exactRequestIdentity = exactText(
      requestIdentity,
      "Request identity",
      240,
    );
    const raw = await this.client.mutation(reconcileRef, this.args({
      subjectKind: subject.kind,
      subjectId: subject.id,
      requestIdentity: exactRequestIdentity,
      outcome: input.outcome,
      reconciliationReference: input.reconciliationReference,
      currentTime: input.currentTime,
    }));
    const receipt = parseStoredReceipt(raw);
    this.assertRoute(receipt, subject, exactRequestIdentity);
    return receipt;
  }

  private subject(input: AccountUsageSubject): AccountUsageSubject {
    if (input.workspace !== this.workspace) {
      throw new AccountUsageReservationStorageError();
    }
    if (input.kind !== "account" && input.kind !== "authorization") {
      throw new AccountUsageReservationStorageError();
    }
    return {
      kind: input.kind,
      id: exactText(input.id, "Usage subject id", 240),
      workspace: this.workspace,
    };
  }

  private assertRoute(
    receipt: AccountUsageReservationReceipt,
    subject: AccountUsageSubject,
    requestIdentity: string,
  ): void {
    if (
      receipt.subject.kind !== subject.kind
      || receipt.subject.id !== subject.id
      || receipt.subject.workspace !== subject.workspace
      || receipt.requestIdentity !== requestIdentity
    ) {
      throw new AccountUsageReservationStorageError();
    }
  }

  private args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
    };
  }
}

export class AccountUsageReservationStorageError extends Error {
  readonly code = "account_usage_reservation_storage_failed";

  constructor() {
    super("Account usage reservation storage failed");
    this.name = "AccountUsageReservationStorageError";
  }
}

function admitReservation(value: unknown): AccountUsageReservationPersistenceResult {
  const record = exactDataRecord(value, reservationKeys);
  const outcome = record.outcome;
  if (
    typeof outcome !== "string"
    || !reservationOutcomes.includes(
      outcome as typeof reservationOutcomes[number],
    )
  ) {
    throw new AccountUsageReservationStorageError();
  }
  return {
    outcome: outcome as AccountUsageReservationPersistenceResult["outcome"],
    receipt: parseStoredReceipt(record.receiptJson),
  };
}

function parseStoredReceipt(value: unknown): AccountUsageReservationReceipt {
  if (typeof value !== "string" || value.length > 8_192) {
    throw new AccountUsageReservationStorageError();
  }
  try {
    return parseAccountUsageReservationReceipt(JSON.parse(value));
  } catch {
    throw new AccountUsageReservationStorageError();
  }
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
    throw new AccountUsageReservationStorageError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) {
    throw new AccountUsageReservationStorageError();
  }
  const actualKeys = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length
    || actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw new AccountUsageReservationStorageError();
  }
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new AccountUsageReservationStorageError();
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
