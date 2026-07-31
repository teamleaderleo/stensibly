import { Database } from "bun:sqlite";
import {
  freezeRepositoryWriteReceipt,
  type GitHubRepositoryWriteReceipt,
  type GitHubRepositoryWriteReservation,
  type GitHubRepositoryWriteStore,
} from "./github-repository-write-provider-service.js";

interface ReceiptRow {
  project: string;
  idempotency_key: string;
  receipt_id: string;
  request_sha256: string;
  payload_sha256: string;
  actor_id: string;
  client_id: string;
  receipt_json: string;
}

interface LaneRow {
  project: string;
  repository_full_name: string;
  target_ref: string;
  receipt_id: string;
  idempotency_key: string;
  expected_parent_sha: string;
  state: string;
  updated_at: string;
}

export class SqliteGitHubRepositoryWriteStore
  implements GitHubRepositoryWriteStore {
  readonly #db: Database;
  readonly #ownsDatabase: boolean;

  constructor(input: { database: Database } | { path: string }) {
    if ("database" in input) {
      this.#db = input.database;
      this.#ownsDatabase = false;
    } else {
      if (typeof input.path !== "string" || input.path.length < 1) {
        throw new TypeError("Repository write store path is invalid");
      }
      this.#db = new Database(input.path, { create: true });
      this.#ownsDatabase = true;
    }
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  close(): void {
    if (this.#ownsDatabase) this.#db.close();
  }

  async reserveRepositoryWrite(
    receiptInput: GitHubRepositoryWriteReceipt,
  ): Promise<GitHubRepositoryWriteReservation> {
    const receipt = freezeRepositoryWriteReceipt(receiptInput);
    const transaction = this.#db.transaction((): GitHubRepositoryWriteReservation => {
      const currentRow = this.#receiptRow(receipt.project, receipt.idempotencyKey);
      if (currentRow) {
        const current = parseReceipt(currentRow.receipt_json);
        return {
          outcome: sameRequest(current, receipt) ? "replay" : "conflict",
          receipt: current,
        };
      }

      const lane = this.#laneRow(
        receipt.project,
        receipt.repositoryFullName,
        receipt.targetRef,
      );
      if (lane) {
        const blocker = this.#receiptById(lane.receipt_id);
        if (!blocker) {
          throw new Error("Repository write lane references a missing receipt");
        }
        return { outcome: "blocked", receipt: blocker };
      }

      this.#insertReceipt(receipt);
      this.#db.query(`
        INSERT INTO github_repository_write_lanes (
          project,
          repository_full_name,
          target_ref,
          receipt_id,
          idempotency_key,
          expected_parent_sha,
          state,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'reserved', ?7)
      `).run(
        receipt.project,
        receipt.repositoryFullName,
        receipt.targetRef,
        receipt.id,
        receipt.idempotencyKey,
        receipt.expectedParentSha,
        receipt.updatedAt,
      );
      return { outcome: "reserved", receipt };
    });
    return transaction.immediate();
  }

  async rejectAndReleaseRepositoryWrite(input: {
    receipt: GitHubRepositoryWriteReceipt;
    code: string;
    rejectedAt: string;
  }): Promise<GitHubRepositoryWriteReceipt> {
    const next = freezeRepositoryWriteReceipt({
      ...input.receipt,
      state: "rejected",
      updatedAt: input.rejectedAt,
      error: {
        code: exactCode(input.code),
        retry: "do_not_retry",
      },
    });
    const transaction = this.#db.transaction(() => {
      this.#requireLaneOwner(input.receipt);
      this.#updateReceipt(next);
      this.#deleteLane(input.receipt);
      return next;
    });
    return transaction.immediate();
  }

  async holdRepositoryWriteForReconciliation(input: {
    receipt: GitHubRepositoryWriteReceipt;
    code: string;
    heldAt: string;
  }): Promise<GitHubRepositoryWriteReceipt> {
    const next = freezeRepositoryWriteReceipt({
      ...input.receipt,
      state: "pending_reconciliation",
      updatedAt: input.heldAt,
      error: {
        code: exactCode(input.code),
        retry: "reconcile_before_retry",
      },
    });
    const transaction = this.#db.transaction(() => {
      this.#requireLaneOwner(input.receipt);
      this.#updateReceipt(next);
      this.#updateLaneState(input.receipt, "pending_reconciliation", input.heldAt);
      return next;
    });
    return transaction.immediate();
  }

  async recordVerifiedRepositoryWrite(input: {
    receipt: GitHubRepositoryWriteReceipt;
    verified: NonNullable<GitHubRepositoryWriteReceipt["verified"]>;
  }): Promise<GitHubRepositoryWriteReceipt> {
    return this.#persistVerified({
      receipt: input.receipt,
      verified: input.verified,
      code: "repository_write_settlement_incomplete",
      updatedAt: input.verified.verifiedAt,
    });
  }

  async holdVerifiedRepositoryWriteForReconciliation(input: {
    receipt: GitHubRepositoryWriteReceipt;
    verified: NonNullable<GitHubRepositoryWriteReceipt["verified"]>;
    code: string;
    heldAt: string;
  }): Promise<GitHubRepositoryWriteReceipt> {
    return this.#persistVerified({
      receipt: input.receipt,
      verified: input.verified,
      code: exactCode(input.code),
      updatedAt: input.heldAt,
    });
  }

  async releaseVerifiedRepositoryWrite(input: {
    receipt: GitHubRepositoryWriteReceipt;
    releasedAt: string;
  }): Promise<GitHubRepositoryWriteReceipt> {
    if (input.receipt.state !== "verified_pending_release" || !input.receipt.verified) {
      throw new Error("Only a durably recorded verified write can release its lane");
    }
    const next = freezeRepositoryWriteReceipt({
      ...input.receipt,
      state: "succeeded",
      updatedAt: input.releasedAt,
      error: null,
    });
    const transaction = this.#db.transaction(() => {
      const current = this.#requireReceipt(input.receipt.project, input.receipt.idempotencyKey);
      if (
        current.id !== input.receipt.id
        || current.state !== "verified_pending_release"
        || current.verified?.commitSha !== input.receipt.verified?.commitSha
      ) {
        throw new Error("Verified repository write receipt changed before lane release");
      }
      this.#requireLaneOwner(input.receipt);
      this.#updateReceipt(next);
      this.#deleteLane(input.receipt);
      return next;
    });
    return transaction.immediate();
  }

  async getRepositoryWriteReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubRepositoryWriteReceipt | null> {
    const row = this.#receiptRow(project, idempotencyKey);
    return row ? parseReceipt(row.receipt_json) : null;
  }

  #persistVerified(input: {
    receipt: GitHubRepositoryWriteReceipt;
    verified: NonNullable<GitHubRepositoryWriteReceipt["verified"]>;
    code: string;
    updatedAt: string;
  }): GitHubRepositoryWriteReceipt {
    const next = freezeRepositoryWriteReceipt({
      ...input.receipt,
      state: "verified_pending_release",
      dispatchCount: 1,
      updatedAt: input.updatedAt,
      verified: input.verified,
      error: {
        code: input.code,
        retry: "reconcile_before_retry",
      },
    });
    const transaction = this.#db.transaction(() => {
      this.#requireLaneOwner(input.receipt);
      this.#updateReceipt(next);
      this.#updateLaneState(
        input.receipt,
        "verified_pending_release",
        input.updatedAt,
      );
      return next;
    });
    return transaction.immediate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS github_repository_write_receipts (
        project TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        receipt_id TEXT NOT NULL UNIQUE,
        request_sha256 TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY (project, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS github_repository_write_lanes (
        project TEXT NOT NULL,
        repository_full_name TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        receipt_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL,
        expected_parent_sha TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('reserved', 'pending_reconciliation', 'verified_pending_release')
        ),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, repository_full_name, target_ref),
        FOREIGN KEY (receipt_id)
          REFERENCES github_repository_write_receipts(receipt_id)
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_github_repository_write_lane_receipt
        ON github_repository_write_lanes(receipt_id);
    `);
  }

  #receiptRow(project: string, idempotencyKey: string): ReceiptRow | null {
    return this.#db.query<ReceiptRow, [string, string]>(`
      SELECT *
      FROM github_repository_write_receipts
      WHERE project = ?1 AND idempotency_key = ?2
    `).get(project, idempotencyKey) ?? null;
  }

  #receiptById(receiptId: string): GitHubRepositoryWriteReceipt | null {
    const row = this.#db.query<ReceiptRow, [string]>(`
      SELECT *
      FROM github_repository_write_receipts
      WHERE receipt_id = ?1
    `).get(receiptId);
    return row ? parseReceipt(row.receipt_json) : null;
  }

  #laneRow(
    project: string,
    repositoryFullName: string,
    targetRef: string,
  ): LaneRow | null {
    return this.#db.query<LaneRow, [string, string, string]>(`
      SELECT *
      FROM github_repository_write_lanes
      WHERE project = ?1
        AND repository_full_name = ?2
        AND target_ref = ?3
    `).get(project, repositoryFullName, targetRef) ?? null;
  }

  #insertReceipt(receipt: GitHubRepositoryWriteReceipt): void {
    this.#db.query(`
      INSERT INTO github_repository_write_receipts (
        project,
        idempotency_key,
        receipt_id,
        request_sha256,
        payload_sha256,
        actor_id,
        client_id,
        receipt_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).run(
      receipt.project,
      receipt.idempotencyKey,
      receipt.id,
      receipt.requestSha256,
      receipt.payloadSha256,
      receipt.actorId,
      receipt.clientId,
      JSON.stringify(receipt),
    );
  }

  #updateReceipt(receipt: GitHubRepositoryWriteReceipt): void {
    const result = this.#db.query(`
      UPDATE github_repository_write_receipts
      SET receipt_json = ?1
      WHERE project = ?2
        AND idempotency_key = ?3
        AND receipt_id = ?4
        AND request_sha256 = ?5
        AND payload_sha256 = ?6
        AND actor_id = ?7
        AND client_id = ?8
    `).run(
      JSON.stringify(receipt),
      receipt.project,
      receipt.idempotencyKey,
      receipt.id,
      receipt.requestSha256,
      receipt.payloadSha256,
      receipt.actorId,
      receipt.clientId,
    );
    if (result.changes !== 1) {
      throw new Error("Repository write receipt update lost its exact reservation");
    }
  }

  #requireReceipt(project: string, idempotencyKey: string): GitHubRepositoryWriteReceipt {
    const row = this.#receiptRow(project, idempotencyKey);
    if (!row) throw new Error("Repository write receipt is missing");
    return parseReceipt(row.receipt_json);
  }

  #requireLaneOwner(receipt: GitHubRepositoryWriteReceipt): LaneRow {
    const lane = this.#laneRow(
      receipt.project,
      receipt.repositoryFullName,
      receipt.targetRef,
    );
    if (
      !lane
      || lane.receipt_id !== receipt.id
      || lane.idempotency_key !== receipt.idempotencyKey
      || lane.expected_parent_sha !== receipt.expectedParentSha
    ) {
      throw new Error("Repository write lane ownership changed");
    }
    return lane;
  }

  #updateLaneState(
    receipt: GitHubRepositoryWriteReceipt,
    state: "pending_reconciliation" | "verified_pending_release",
    updatedAt: string,
  ): void {
    const result = this.#db.query(`
      UPDATE github_repository_write_lanes
      SET state = ?1, updated_at = ?2
      WHERE project = ?3
        AND repository_full_name = ?4
        AND target_ref = ?5
        AND receipt_id = ?6
        AND idempotency_key = ?7
        AND expected_parent_sha = ?8
    `).run(
      state,
      updatedAt,
      receipt.project,
      receipt.repositoryFullName,
      receipt.targetRef,
      receipt.id,
      receipt.idempotencyKey,
      receipt.expectedParentSha,
    );
    if (result.changes !== 1) {
      throw new Error("Repository write lane update lost its exact reservation");
    }
  }

  #deleteLane(receipt: GitHubRepositoryWriteReceipt): void {
    const result = this.#db.query(`
      DELETE FROM github_repository_write_lanes
      WHERE project = ?1
        AND repository_full_name = ?2
        AND target_ref = ?3
        AND receipt_id = ?4
        AND idempotency_key = ?5
        AND expected_parent_sha = ?6
    `).run(
      receipt.project,
      receipt.repositoryFullName,
      receipt.targetRef,
      receipt.id,
      receipt.idempotencyKey,
      receipt.expectedParentSha,
    );
    if (result.changes !== 1) {
      throw new Error("Repository write lane release lost its exact reservation");
    }
  }
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

const receiptStates = new Set([
  "reserved",
  "rejected",
  "pending_reconciliation",
  "verified_pending_release",
  "succeeded",
]);
const operations = new Set(["create_file", "update_file", "delete_file"]);

function parseReceipt(value: string): GitHubRepositoryWriteReceipt {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored repository write receipt is invalid");
  }
  const record = parsed as Partial<GitHubRepositoryWriteReceipt>;
  if (
    record.version !== 1
    || typeof record.id !== "string"
    || typeof record.project !== "string"
    || typeof record.repositoryFullName !== "string"
    || typeof record.targetRef !== "string"
    || typeof record.path !== "string"
    || typeof record.operation !== "string"
    || !operations.has(record.operation)
    || typeof record.expectedParentSha !== "string"
    || typeof record.requestSha256 !== "string"
    || typeof record.payloadSha256 !== "string"
    || typeof record.actorId !== "string"
    || typeof record.clientId !== "string"
    || typeof record.idempotencyKey !== "string"
    || typeof record.state !== "string"
    || !receiptStates.has(record.state)
    || (record.dispatchCount !== 0 && record.dispatchCount !== 1)
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
    || (record.verified !== null && typeof record.verified !== "object")
    || (record.error !== null && typeof record.error !== "object")
  ) {
    throw new Error("Stored repository write receipt is invalid");
  }
  return freezeRepositoryWriteReceipt(record as GitHubRepositoryWriteReceipt);
}

function exactCode(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,119}$/u.test(value)) {
    throw new TypeError("Repository write error code is invalid");
  }
  return value;
}
