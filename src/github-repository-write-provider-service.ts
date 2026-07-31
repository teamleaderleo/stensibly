import { randomUUID } from "node:crypto";
import { sha256, stableJson } from "./canonical-json.js";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteResult,
  type PreparedRepositoryWrite,
  type RepositoryWriteOperation,
  type VerifiedRepositoryWrite,
} from "./repository-write-fence.js";

export type GitHubRepositoryWritePayload =
  | {
      operation: "create_file";
      content: string;
      message: string;
    }
  | {
      operation: "update_file";
      content: string;
      contentSha: string;
      message: string;
    }
  | {
      operation: "delete_file";
      contentSha: string;
      message: string;
    };

export type GitHubRepositoryWriteReceiptState =
  | "reserved"
  | "rejected"
  | "pending_reconciliation"
  | "verified_pending_release"
  | "succeeded";

export interface GitHubRepositoryWriteReceipt {
  version: 1;
  id: string;
  project: string;
  repositoryFullName: string;
  targetRef: string;
  path: string;
  operation: RepositoryWriteOperation;
  expectedParentSha: string;
  requestSha256: string;
  payloadSha256: string;
  actorId: string;
  clientId: string;
  idempotencyKey: string;
  state: GitHubRepositoryWriteReceiptState;
  dispatchCount: 0 | 1;
  createdAt: string;
  updatedAt: string;
  verified: VerifiedRepositoryWrite | null;
  error: {
    code: string;
    retry: "do_not_retry" | "reconcile_before_retry";
  } | null;
}

export interface GitHubRepositoryWriteReservation {
  outcome: "reserved" | "replay" | "conflict" | "blocked";
  receipt: GitHubRepositoryWriteReceipt;
}

export interface GitHubRepositoryWriteStore {
  reserveRepositoryWrite(
    receipt: GitHubRepositoryWriteReceipt,
  ): Promise<GitHubRepositoryWriteReservation>;
  rejectAndReleaseRepositoryWrite(input: {
    receipt: GitHubRepositoryWriteReceipt;
    code: string;
    rejectedAt: string;
  }): Promise<GitHubRepositoryWriteReceipt>;
  holdRepositoryWriteForReconciliation(input: {
    receipt: GitHubRepositoryWriteReceipt;
    code: string;
    heldAt: string;
  }): Promise<GitHubRepositoryWriteReceipt>;
  recordVerifiedRepositoryWrite(input: {
    receipt: GitHubRepositoryWriteReceipt;
    verified: VerifiedRepositoryWrite;
  }): Promise<GitHubRepositoryWriteReceipt>;
  holdVerifiedRepositoryWriteForReconciliation(input: {
    receipt: GitHubRepositoryWriteReceipt;
    verified: VerifiedRepositoryWrite;
    code: string;
    heldAt: string;
  }): Promise<GitHubRepositoryWriteReceipt>;
  releaseVerifiedRepositoryWrite(input: {
    receipt: GitHubRepositoryWriteReceipt;
    releasedAt: string;
  }): Promise<GitHubRepositoryWriteReceipt>;
  getRepositoryWriteReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubRepositoryWriteReceipt | null>;
}

export interface GitHubRepositoryWriteAuthorityProvider {
  getRepositoryWriteAuthority(input: {
    project: string;
    repositoryFullName: string;
    targetRef: string;
    operation: RepositoryWriteOperation;
    actorId: string;
    clientId: string;
  }): Promise<unknown>;
}

export interface GitHubRepositoryWriteProviderAdapter {
  getRefHead(input: {
    repositoryFullName: string;
    targetRef: string;
  }): Promise<string | null>;
  getCommitParents(input: {
    repositoryFullName: string;
    commitSha: string;
  }): Promise<readonly string[]>;
  dispatchRepositoryWrite(input: {
    repositoryFullName: string;
    path: string;
    operation: RepositoryWriteOperation;
    targetRef: string;
    expectedParentSha: string;
    payload: GitHubRepositoryWritePayload;
    idempotencyKey: string;
  }): Promise<unknown>;
}

export interface GitHubRepositoryWriteProviderServiceDependencies {
  authority: GitHubRepositoryWriteAuthorityProvider;
  adapter: GitHubRepositoryWriteProviderAdapter;
  store: GitHubRepositoryWriteStore;
  now?: () => string;
  idFactory?: () => string;
}

export interface GitHubRepositoryWriteCommand {
  project: string;
  actorId: string;
  clientId: string;
  idempotencyKey: string;
  intent: unknown;
  payload: unknown;
}

export class GitHubRepositoryWriteRejectedError extends Error {
  readonly code: string;
  readonly receipt: GitHubRepositoryWriteReceipt;

  constructor(code: string, receipt: GitHubRepositoryWriteReceipt) {
    super("GitHub repository write was rejected before provider dispatch");
    this.name = "GitHubRepositoryWriteRejectedError";
    this.code = code;
    this.receipt = receipt;
  }
}

export class GitHubRepositoryWritePendingReconciliationError extends Error {
  readonly receipt: GitHubRepositoryWriteReceipt;

  constructor(receipt: GitHubRepositoryWriteReceipt) {
    super("GitHub repository write requires reconciliation before retry");
    this.name = "GitHubRepositoryWritePendingReconciliationError";
    this.receipt = receipt;
  }
}

export class GitHubRepositoryWriteConflictError extends Error {
  readonly receipt: GitHubRepositoryWriteReceipt;

  constructor(receipt: GitHubRepositoryWriteReceipt) {
    super("GitHub repository write idempotency key was reused by another request");
    this.name = "GitHubRepositoryWriteConflictError";
    this.receipt = receipt;
  }
}

export class GitHubRepositoryWriteSettlementError extends Error {
  readonly code: string;
  readonly receipt: GitHubRepositoryWriteReceipt;
  readonly verified: VerifiedRepositoryWrite;

  constructor(input: {
    code: string;
    receipt: GitHubRepositoryWriteReceipt;
    verified: VerifiedRepositoryWrite;
  }) {
    super("Verified GitHub repository write requires settlement reconciliation");
    this.name = "GitHubRepositoryWriteSettlementError";
    this.code = input.code;
    this.receipt = input.receipt;
    this.verified = input.verified;
  }
}

export class GitHubRepositoryWriteProviderService {
  readonly #authority: GitHubRepositoryWriteAuthorityProvider;
  readonly #adapter: GitHubRepositoryWriteProviderAdapter;
  readonly #store: GitHubRepositoryWriteStore;
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(dependencies: GitHubRepositoryWriteProviderServiceDependencies) {
    this.#authority = dependencies.authority;
    this.#adapter = dependencies.adapter;
    this.#store = dependencies.store;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#idFactory = dependencies.idFactory ?? (() => `ghrw_${randomUUID()}`);
  }

  async execute(commandInput: unknown): Promise<GitHubRepositoryWriteReceipt> {
    const command = admitCommand(commandInput);
    const payload = admitPayload(command.payload);
    const firstPrepared = await this.#prepare(command, payload.operation);
    const createdAt = exactTimestamp(this.#now(), "Repository write creation time");
    const receipt = freezeReceipt({
      version: 1,
      id: exactIdentifier(this.#idFactory(), "Repository write receipt ID", 240),
      project: command.project,
      repositoryFullName: firstPrepared.repositoryFullName,
      targetRef: firstPrepared.targetRef,
      path: firstPrepared.path,
      operation: firstPrepared.operation,
      expectedParentSha: firstPrepared.expectedParentSha,
      requestSha256: firstPrepared.requestSha256,
      payloadSha256: payloadFingerprint(payload),
      actorId: command.actorId,
      clientId: command.clientId,
      idempotencyKey: command.idempotencyKey,
      state: "reserved",
      dispatchCount: 0,
      createdAt,
      updatedAt: createdAt,
      verified: null,
      error: null,
    });

    const reservation = await this.#store.reserveRepositoryWrite(receipt);
    if (reservation.outcome === "conflict") {
      throw new GitHubRepositoryWriteConflictError(reservation.receipt);
    }
    if (reservation.outcome === "blocked") {
      throw new GitHubRepositoryWritePendingReconciliationError(reservation.receipt);
    }
    if (reservation.outcome === "replay") {
      if (reservation.receipt.state === "succeeded") return reservation.receipt;
      if (reservation.receipt.state === "rejected") {
        throw new GitHubRepositoryWriteRejectedError(
          reservation.receipt.error?.code ?? "repository_write_rejected",
          reservation.receipt,
        );
      }
      throw new GitHubRepositoryWritePendingReconciliationError(reservation.receipt);
    }

    let rawHead: string | null;
    try {
      rawHead = await this.#adapter.getRefHead({
        repositoryFullName: firstPrepared.repositoryFullName,
        targetRef: firstPrepared.targetRef,
      });
    } catch {
      return await this.#reject(
        receipt,
        "repository_write_pre_dispatch_head_unavailable",
      );
    }

    let admittedHead: string | null;
    try {
      admittedHead = rawHead === null
        ? null
        : exactCommitSha(rawHead, "Target ref head");
    } catch {
      return await this.#reject(
        receipt,
        "repository_write_pre_dispatch_head_invalid",
      );
    }
    if (admittedHead !== firstPrepared.expectedParentSha) {
      await this.#reject(receipt, "repository_write_expected_parent_moved");
    }

    let secondPrepared: PreparedRepositoryWrite;
    try {
      secondPrepared = await this.#prepare(command, payload.operation);
    } catch {
      return await this.#reject(receipt, "repository_write_authority_changed");
    }
    if (secondPrepared.requestSha256 !== firstPrepared.requestSha256) {
      await this.#reject(receipt, "repository_write_authority_changed");
    }

    let providerResult: unknown;
    try {
      providerResult = await this.#adapter.dispatchRepositoryWrite({
        repositoryFullName: secondPrepared.repositoryFullName,
        path: secondPrepared.path,
        operation: secondPrepared.operation,
        targetRef: secondPrepared.targetRef,
        expectedParentSha: secondPrepared.expectedParentSha,
        payload,
        idempotencyKey: command.idempotencyKey,
      });
    } catch {
      const pending = await this.#hold(
        receiptWithDispatch(receipt),
        "repository_write_provider_outcome_ambiguous",
      );
      throw new GitHubRepositoryWritePendingReconciliationError(pending);
    }

    let verified: VerifiedRepositoryWrite;
    try {
      verified = await verifyRepositoryWriteResult({
        prepared: secondPrepared,
        providerResult,
        refs: this.#adapter,
        now: this.#now,
      });
    } catch (error) {
      const code = error instanceof RepositoryWriteFenceError
        ? error.code
        : "repository_write_verification_failed";
      const pending = await this.#hold(receiptWithDispatch(receipt), code);
      throw new GitHubRepositoryWritePendingReconciliationError(pending);
    }

    let recorded: GitHubRepositoryWriteReceipt;
    try {
      recorded = await this.#store.recordVerifiedRepositoryWrite({
        receipt: receiptWithDispatch(receipt),
        verified,
      });
    } catch {
      const code = "repository_write_verified_receipt_persistence_failed";
      let recovered = receiptWithVerified(
        receiptWithDispatch(receipt),
        verified,
        code,
      );
      try {
        recovered = await this.#store.holdVerifiedRepositoryWriteForReconciliation({
          receipt: receiptWithDispatch(receipt),
          verified,
          code,
          heldAt: exactTimestamp(
            this.#now(),
            "Repository write verified reconciliation time",
          ),
        });
      } catch {
        // The thrown settlement error still carries the exact admitted result.
      }
      throw new GitHubRepositoryWriteSettlementError({
        code,
        receipt: recovered,
        verified,
      });
    }

    try {
      return await this.#store.releaseVerifiedRepositoryWrite({
        receipt: recorded,
        releasedAt: exactTimestamp(this.#now(), "Repository write release time"),
      });
    } catch {
      throw new GitHubRepositoryWriteSettlementError({
        code: "repository_write_verified_lane_release_failed",
        receipt: recorded,
        verified,
      });
    }
  }

  async #prepare(
    command: AdmittedCommand,
    operation: RepositoryWriteOperation,
  ): Promise<PreparedRepositoryWrite> {
    const intent = command.intent;
    const intentRecord = exactRecord(intent, [
      "version",
      "repositoryFullName",
      "path",
      "operation",
      "targetRef",
      "expectedParentSha",
    ]);
    if (intentRecord.operation !== operation) {
      throw new TypeError("Repository write payload operation does not match its intent");
    }
    const repositoryFullName = exactRepository(
      intentRecord.repositoryFullName,
      "Repository write repository",
    );
    const targetRef = exactBranchRef(
      intentRecord.targetRef,
      "Repository write target ref",
    );
    const authority = await this.#authority.getRepositoryWriteAuthority({
      project: command.project,
      repositoryFullName,
      targetRef,
      operation,
      actorId: command.actorId,
      clientId: command.clientId,
    });
    return prepareRepositoryWrite(intent, authority);
  }

  async #reject(
    receipt: GitHubRepositoryWriteReceipt,
    code: string,
  ): Promise<never> {
    const rejected = await this.#store.rejectAndReleaseRepositoryWrite({
      receipt,
      code,
      rejectedAt: exactTimestamp(this.#now(), "Repository write rejection time"),
    });
    throw new GitHubRepositoryWriteRejectedError(code, rejected);
  }

  async #hold(
    receipt: GitHubRepositoryWriteReceipt,
    code: string,
  ): Promise<GitHubRepositoryWriteReceipt> {
    return await this.#store.holdRepositoryWriteForReconciliation({
      receipt,
      code,
      heldAt: exactTimestamp(this.#now(), "Repository write reconciliation time"),
    });
  }
}

interface AdmittedCommand {
  project: string;
  actorId: string;
  clientId: string;
  idempotencyKey: string;
  intent: unknown;
  payload: unknown;
}

function admitCommand(value: unknown): AdmittedCommand {
  const record = exactRecord(value, [
    "project",
    "actorId",
    "clientId",
    "idempotencyKey",
    "intent",
    "payload",
  ]);
  return {
    project: exactIdentifier(record.project, "Repository write project", 120),
    actorId: exactIdentifier(record.actorId, "Repository write actor ID", 120),
    clientId: exactIdentifier(record.clientId, "Repository write client ID", 240),
    idempotencyKey: exactIdentifier(
      record.idempotencyKey,
      "Repository write idempotency key",
      240,
    ),
    intent: record.intent,
    payload: record.payload,
  };
}

function admitPayload(value: unknown): GitHubRepositoryWritePayload {
  const base = exactRecord(value, ["operation"], [
    "content",
    "contentSha",
    "message",
  ]);
  const operation = base.operation;
  if (operation === "create_file") {
    requireExactKeys(base, ["operation", "content", "message"]);
    return Object.freeze({
      operation,
      content: exactContent(base.content),
      message: exactMessage(base.message),
    });
  }
  if (operation === "update_file") {
    requireExactKeys(base, ["operation", "content", "contentSha", "message"]);
    return Object.freeze({
      operation,
      content: exactContent(base.content),
      contentSha: exactGitObjectSha(base.contentSha),
      message: exactMessage(base.message),
    });
  }
  if (operation === "delete_file") {
    requireExactKeys(base, ["operation", "contentSha", "message"]);
    return Object.freeze({
      operation,
      contentSha: exactGitObjectSha(base.contentSha),
      message: exactMessage(base.message),
    });
  }
  throw new TypeError("Repository write payload operation is invalid");
}

function payloadFingerprint(payload: GitHubRepositoryWritePayload): string {
  const evidence = payload.operation === "delete_file"
    ? {
        operation: payload.operation,
        contentSha: payload.contentSha,
        messageSha256: sha256(payload.message),
      }
    : {
        operation: payload.operation,
        contentByteLength: Buffer.byteLength(payload.content, "utf8"),
        contentSha256: sha256(payload.content),
        ...(payload.operation === "update_file"
          ? { contentSha: payload.contentSha }
          : {}),
        messageSha256: sha256(payload.message),
      };
  return sha256(stableJson(evidence));
}

function receiptWithDispatch(
  receipt: GitHubRepositoryWriteReceipt,
): GitHubRepositoryWriteReceipt {
  return freezeReceipt({ ...receipt, dispatchCount: 1 });
}

function receiptWithVerified(
  receipt: GitHubRepositoryWriteReceipt,
  verified: VerifiedRepositoryWrite,
  code = "repository_write_settlement_incomplete",
  updatedAt = verified.verifiedAt,
): GitHubRepositoryWriteReceipt {
  return freezeReceipt({
    ...receipt,
    state: "verified_pending_release",
    dispatchCount: 1,
    updatedAt,
    verified,
    error: {
      code,
      retry: "reconcile_before_retry",
    },
  });
}

export function freezeRepositoryWriteReceipt(
  receipt: GitHubRepositoryWriteReceipt,
): GitHubRepositoryWriteReceipt {
  return freezeReceipt(receipt);
}

function freezeReceipt(
  receipt: GitHubRepositoryWriteReceipt,
): GitHubRepositoryWriteReceipt {
  const cloned = structuredClone(receipt);
  if (cloned.verified) Object.freeze(cloned.verified);
  if (cloned.error) Object.freeze(cloned.error);
  return Object.freeze(cloned);
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Repository write input must be an object");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Repository write input must use the ordinary object prototype");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("Repository write input cannot contain symbol fields");
  }
  const allowed = new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key) || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Repository write input contains an unsupported field");
    }
  }
  for (const key of required) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("Repository write input omitted a required field");
    }
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Repository write payload fields are invalid");
  }
}

const credentialShapedPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{24,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}|bearer\s+[A-Za-z0-9._~+\/-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

function exactIdentifier(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new TypeError(`${label} is invalid`);
  }
  if (
    value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
    || credentialShapedPattern.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactRepository(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function exactBranchRef(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length < 1
    || value.length > 240
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,238}[A-Za-z0-9])?$/u.test(value)
    || value.includes("..")
    || value.includes("//")
    || value.includes("@{")
    || value.endsWith(".lock")
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactCommitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactGitObjectSha(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new TypeError("Repository content SHA is invalid");
  }
  return value;
}

function exactContent(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 10 * 1024 * 1024) {
    throw new TypeError("Repository file content is invalid");
  }
  return value;
}

function exactMessage(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value !== value.trim()
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) {
    throw new TypeError("Repository commit message is invalid");
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
