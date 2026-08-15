import { Database } from "bun:sqlite";
import {
  freezeMailThreadRecord,
  type MailThreadRecord,
} from "./mail-thread-contract.js";
import {
  freezeMailDeliveryReceipt,
  freezeMailProviderProjection,
  type MailDeliveryReceipt,
  type MailDeliveryReservation,
  type MailOutboundEffectRecord,
  type MailProviderProjection,
} from "./mail-provider.js";

export interface MailThreadReservation {
  outcome: "created" | "existing" | "handle_conflict" | "source_conflict";
  thread: MailThreadRecord;
}

export interface MailThreadStore {
  reserveThread(thread: MailThreadRecord): Promise<MailThreadReservation>;
  getThreadByHandle(handle: string): Promise<MailThreadRecord | null>;
  getThreadBySource(
    workspace: string,
    project: string,
    sourceIdentity: string,
  ): Promise<MailThreadRecord | null>;
  updateThread(thread: MailThreadRecord): Promise<MailThreadRecord>;
  getProviderProjection(
    threadId: string,
    provider: string,
    accountBinding: string,
  ): Promise<MailProviderProjection | null>;
  reserveDeliveryEffect(
    effect: MailOutboundEffectRecord,
  ): Promise<MailDeliveryReservation>;
  settleDeliveryEffect(input: {
    effect: MailOutboundEffectRecord;
    receipt: MailDeliveryReceipt;
    projection?: MailProviderProjection | null;
  }): Promise<MailOutboundEffectRecord>;
  getDeliveryEffect(outboundEffectId: string): Promise<MailOutboundEffectRecord | null>;
}

interface ThreadRow {
  thread_json: string;
}

interface ProjectionRow {
  projection_json: string;
}

interface EffectRow {
  effect_json: string;
}

export class SqliteMailThreadStore implements MailThreadStore {
  readonly #db: Database;
  readonly #ownsDatabase: boolean;

  constructor(input: { database: Database } | { path: string }) {
    if ("database" in input) {
      this.#db = input.database;
      this.#ownsDatabase = false;
    } else {
      if (typeof input.path !== "string" || input.path.length < 1) {
        throw new TypeError("Mail thread store path is invalid");
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

  async reserveThread(threadInput: MailThreadRecord): Promise<MailThreadReservation> {
    const thread = freezeMailThreadRecord(threadInput);
    const transaction = this.#db.transaction((): MailThreadReservation => {
      const bySource = this.#threadBySource(
        thread.workspace,
        thread.project,
        thread.sourceIdentity,
      );
      if (bySource) {
        return {
          outcome: sameThreadIdentity(bySource, thread) ? "existing" : "source_conflict",
          thread: bySource,
        };
      }
      const byHandle = this.#threadByHandle(thread.handle);
      if (byHandle) return { outcome: "handle_conflict", thread: byHandle };
      if (thread.continuesFromThreadId !== null && !this.#threadById(thread.continuesFromThreadId)) {
        throw new Error("Mail thread parent is missing");
      }
      this.#db.query(`
        INSERT INTO mail_threads (
          thread_id, handle, workspace, project, source_identity, thread_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `).run(
        thread.threadId,
        thread.handle,
        thread.workspace,
        thread.project,
        thread.sourceIdentity,
        JSON.stringify(thread),
      );
      return { outcome: "created", thread };
    });
    return transaction.immediate();
  }

  async getThreadByHandle(handle: string): Promise<MailThreadRecord | null> {
    return this.#threadByHandle(handle);
  }

  async getThreadBySource(
    workspace: string,
    project: string,
    sourceIdentity: string,
  ): Promise<MailThreadRecord | null> {
    return this.#threadBySource(workspace, project, sourceIdentity);
  }

  async updateThread(threadInput: MailThreadRecord): Promise<MailThreadRecord> {
    const thread = freezeMailThreadRecord(threadInput);
    const transaction = this.#db.transaction(() => {
      const current = this.#threadById(thread.threadId);
      if (!current || !sameThreadIdentity(current, thread)) {
        throw new Error("Mail thread identity changed before update");
      }
      const result = this.#db.query(`
        UPDATE mail_threads
        SET thread_json = ?1
        WHERE thread_id = ?2
          AND handle = ?3
          AND workspace = ?4
          AND project = ?5
          AND source_identity = ?6
      `).run(
        JSON.stringify(thread),
        thread.threadId,
        thread.handle,
        thread.workspace,
        thread.project,
        thread.sourceIdentity,
      );
      if (result.changes !== 1) throw new Error("Mail thread update lost its exact identity");
      return thread;
    });
    return transaction.immediate();
  }

  async getProviderProjection(
    threadId: string,
    provider: string,
    accountBinding: string,
  ): Promise<MailProviderProjection | null> {
    const row = this.#db.query<ProjectionRow, [string, string, string]>(`
      SELECT projection_json
      FROM mail_provider_projections
      WHERE thread_id = ?1 AND provider = ?2 AND account_binding = ?3
    `).get(threadId, provider, accountBinding);
    return row ? parseProjection(row.projection_json) : null;
  }

  async reserveDeliveryEffect(
    effectInput: MailOutboundEffectRecord,
  ): Promise<MailDeliveryReservation> {
    const effect = freezeEffect(effectInput);
    if (effect.state !== "reserved" || effect.receipt !== null) {
      throw new TypeError("New mail delivery effect must be reserved without a receipt");
    }
    const transaction = this.#db.transaction((): MailDeliveryReservation => {
      const existing = this.#effectById(effect.outboundEffectId);
      if (existing) {
        return {
          outcome: sameEffectIdentity(existing, effect) ? "replay" : "conflict",
          effect: existing,
        };
      }
      const lane = this.#laneEffect(
        effect.threadId,
        effect.provider,
        effect.accountBinding,
      );
      if (lane) return { outcome: "blocked", effect: lane };
      if (!this.#threadById(effect.threadId)) {
        throw new Error("Mail delivery effect references a missing canonical thread");
      }
      this.#db.query(`
        INSERT INTO mail_delivery_effects (
          outbound_effect_id, thread_id, provider, account_binding,
          content_fingerprint, effect_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `).run(
        effect.outboundEffectId,
        effect.threadId,
        effect.provider,
        effect.accountBinding,
        effect.contentFingerprint,
        JSON.stringify(effect),
      );
      this.#db.query(`
        INSERT INTO mail_delivery_lanes (
          thread_id, provider, account_binding, outbound_effect_id, state
        ) VALUES (?1, ?2, ?3, ?4, 'reserved')
      `).run(
        effect.threadId,
        effect.provider,
        effect.accountBinding,
        effect.outboundEffectId,
      );
      return { outcome: "reserved", effect };
    });
    return transaction.immediate();
  }

  async settleDeliveryEffect(input: {
    effect: MailOutboundEffectRecord;
    receipt: MailDeliveryReceipt;
    projection?: MailProviderProjection | null;
  }): Promise<MailOutboundEffectRecord> {
    const effect = freezeEffect(input.effect);
    const receipt = freezeMailDeliveryReceipt(input.receipt);
    if (!receiptMatchesEffect(receipt, effect)) {
      throw new Error("Mail delivery receipt does not match its outbound effect");
    }
    if (receipt.result === "sent" || receipt.result === "reconciled") {
      if (!input.projection) {
        throw new Error("Successful mail delivery settlement requires a provider projection");
      }
    } else if (input.projection) {
      throw new Error("Unsuccessful mail delivery settlement cannot update provider projection");
    }
    const projection = input.projection
      ? freezeMailProviderProjection(input.projection)
      : null;
    if (
      projection
      && (
        projection.threadId !== effect.threadId
        || projection.provider !== effect.provider
        || projection.accountBinding !== effect.accountBinding
        || projection.latestSentFingerprint !== effect.contentFingerprint
      )
    ) {
      throw new Error("Mail provider projection does not match its outbound effect");
    }
    const settled = freezeEffect({
      ...effect,
      state: receipt.result,
      receipt,
    });
    const transaction = this.#db.transaction(() => {
      const current = this.#effectById(effect.outboundEffectId);
      if (!current || !sameEffectIdentity(current, effect)) {
        throw new Error("Mail delivery effect identity changed before settlement");
      }
      if (current.receipt) {
        if (stableReceipt(current.receipt) === stableReceipt(receipt)) return current;
        if (current.state !== "ambiguous") {
          throw new Error("Terminal mail delivery effect cannot be settled differently");
        }
      }
      if (projection) this.#upsertProjection(projection);
      const result = this.#db.query(`
        UPDATE mail_delivery_effects
        SET effect_json = ?1
        WHERE outbound_effect_id = ?2
          AND thread_id = ?3
          AND provider = ?4
          AND account_binding = ?5
          AND content_fingerprint = ?6
      `).run(
        JSON.stringify(settled),
        effect.outboundEffectId,
        effect.threadId,
        effect.provider,
        effect.accountBinding,
        effect.contentFingerprint,
      );
      if (result.changes !== 1) throw new Error("Mail delivery settlement lost its exact effect");
      if (receipt.result === "ambiguous") {
        const lane = this.#db.query(`
          UPDATE mail_delivery_lanes
          SET state = 'ambiguous'
          WHERE thread_id = ?1 AND provider = ?2 AND account_binding = ?3
            AND outbound_effect_id = ?4
        `).run(effect.threadId, effect.provider, effect.accountBinding, effect.outboundEffectId);
        if (lane.changes !== 1) throw new Error("Mail delivery ambiguity lost its active lane");
      } else {
        const lane = this.#db.query(`
          DELETE FROM mail_delivery_lanes
          WHERE thread_id = ?1 AND provider = ?2 AND account_binding = ?3
            AND outbound_effect_id = ?4
        `).run(effect.threadId, effect.provider, effect.accountBinding, effect.outboundEffectId);
        if (lane.changes !== 1) throw new Error("Mail delivery settlement lost its active lane");
      }
      return settled;
    });
    return transaction.immediate();
  }

  async getDeliveryEffect(outboundEffectId: string): Promise<MailOutboundEffectRecord | null> {
    return this.#effectById(outboundEffectId);
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS mail_threads (
        thread_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        project TEXT NOT NULL,
        source_identity TEXT NOT NULL,
        thread_json TEXT NOT NULL,
        UNIQUE (workspace, project, source_identity)
      );

      CREATE TABLE IF NOT EXISTS mail_provider_projections (
        thread_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_binding TEXT NOT NULL,
        provider_thread_id TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        PRIMARY KEY (thread_id, provider, account_binding),
        FOREIGN KEY (thread_id) REFERENCES mail_threads(thread_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS mail_delivery_effects (
        outbound_effect_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_binding TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        effect_json TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES mail_threads(thread_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS mail_delivery_lanes (
        thread_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_binding TEXT NOT NULL,
        outbound_effect_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'ambiguous')),
        PRIMARY KEY (thread_id, provider, account_binding),
        FOREIGN KEY (thread_id) REFERENCES mail_threads(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (outbound_effect_id) REFERENCES mail_delivery_effects(outbound_effect_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_mail_threads_source
        ON mail_threads(workspace, project, source_identity);
      CREATE INDEX IF NOT EXISTS idx_mail_delivery_thread
        ON mail_delivery_effects(thread_id, provider, account_binding);
    `);
  }

  #threadById(threadId: string): MailThreadRecord | null {
    const row = this.#db.query<ThreadRow, [string]>(`
      SELECT thread_json FROM mail_threads WHERE thread_id = ?1
    `).get(threadId);
    return row ? parseThread(row.thread_json) : null;
  }

  #threadByHandle(handle: string): MailThreadRecord | null {
    const row = this.#db.query<ThreadRow, [string]>(`
      SELECT thread_json FROM mail_threads WHERE handle = ?1
    `).get(handle.toUpperCase());
    return row ? parseThread(row.thread_json) : null;
  }

  #threadBySource(
    workspace: string,
    project: string,
    sourceIdentity: string,
  ): MailThreadRecord | null {
    const row = this.#db.query<ThreadRow, [string, string, string]>(`
      SELECT thread_json FROM mail_threads
      WHERE workspace = ?1 AND project = ?2 AND source_identity = ?3
    `).get(workspace, project, sourceIdentity);
    return row ? parseThread(row.thread_json) : null;
  }

  #effectById(outboundEffectId: string): MailOutboundEffectRecord | null {
    const row = this.#db.query<EffectRow, [string]>(`
      SELECT effect_json FROM mail_delivery_effects WHERE outbound_effect_id = ?1
    `).get(outboundEffectId);
    return row ? parseEffect(row.effect_json) : null;
  }

  #laneEffect(
    threadId: string,
    provider: string,
    accountBinding: string,
  ): MailOutboundEffectRecord | null {
    const row = this.#db.query<EffectRow, [string, string, string]>(`
      SELECT effects.effect_json
      FROM mail_delivery_lanes AS lanes
      JOIN mail_delivery_effects AS effects
        ON effects.outbound_effect_id = lanes.outbound_effect_id
      WHERE lanes.thread_id = ?1 AND lanes.provider = ?2 AND lanes.account_binding = ?3
    `).get(threadId, provider, accountBinding);
    return row ? parseEffect(row.effect_json) : null;
  }

  #upsertProjection(projection: MailProviderProjection): void {
    const current = this.#db.query<ProjectionRow, [string, string, string]>(`
      SELECT projection_json FROM mail_provider_projections
      WHERE thread_id = ?1 AND provider = ?2 AND account_binding = ?3
    `).get(projection.threadId, projection.provider, projection.accountBinding);
    if (current) {
      const prior = parseProjection(current.projection_json);
      if (
        prior.providerThreadId !== projection.providerThreadId
        || prior.rootProviderMessageId !== projection.rootProviderMessageId
        || prior.rootRfcMessageId !== projection.rootRfcMessageId
      ) {
        throw new Error("Mail provider projection attempted to replace canonical provider ancestry");
      }
      const result = this.#db.query(`
        UPDATE mail_provider_projections
        SET provider_thread_id = ?1, projection_json = ?2
        WHERE thread_id = ?3 AND provider = ?4 AND account_binding = ?5
      `).run(
        projection.providerThreadId,
        JSON.stringify(projection),
        projection.threadId,
        projection.provider,
        projection.accountBinding,
      );
      if (result.changes !== 1) throw new Error("Mail provider projection update failed");
      return;
    }
    this.#db.query(`
      INSERT INTO mail_provider_projections (
        thread_id, provider, account_binding, provider_thread_id, projection_json
      ) VALUES (?1, ?2, ?3, ?4, ?5)
    `).run(
      projection.threadId,
      projection.provider,
      projection.accountBinding,
      projection.providerThreadId,
      JSON.stringify(projection),
    );
  }
}

function sameThreadIdentity(left: MailThreadRecord, right: MailThreadRecord): boolean {
  return left.threadId === right.threadId
    && left.handle === right.handle
    && left.workspace === right.workspace
    && left.project === right.project
    && left.threadClass === right.threadClass
    && left.canonicalSubject === right.canonicalSubject
    && left.sourceIdentity === right.sourceIdentity
    && left.continuesFromThreadId === right.continuesFromThreadId;
}

function sameEffectIdentity(
  left: MailOutboundEffectRecord,
  right: MailOutboundEffectRecord,
): boolean {
  return left.outboundEffectId === right.outboundEffectId
    && left.threadId === right.threadId
    && left.handle === right.handle
    && left.provider === right.provider
    && left.accountBinding === right.accountBinding
    && left.attemptNumber === right.attemptNumber
    && left.contentFingerprint === right.contentFingerprint
    && left.rfcMessageId === right.rfcMessageId;
}

function receiptMatchesEffect(
  receipt: MailDeliveryReceipt,
  effect: MailOutboundEffectRecord,
): boolean {
  return receipt.outboundEffectId === effect.outboundEffectId
    && receipt.threadId === effect.threadId
    && receipt.handle === effect.handle
    && receipt.provider === effect.provider
    && receipt.accountBinding === effect.accountBinding
    && receipt.attemptNumber === effect.attemptNumber
    && receipt.contentFingerprint === effect.contentFingerprint
    && receipt.rfcMessageId === effect.rfcMessageId;
}

function stableReceipt(receipt: MailDeliveryReceipt): string {
  return JSON.stringify(receipt);
}

function parseThread(value: string): MailThreadRecord {
  return freezeMailThreadRecord(JSON.parse(value) as MailThreadRecord);
}

function parseProjection(value: string): MailProviderProjection {
  return freezeMailProviderProjection(JSON.parse(value) as MailProviderProjection);
}

function parseEffect(value: string): MailOutboundEffectRecord {
  return freezeEffect(JSON.parse(value) as MailOutboundEffectRecord);
}

function freezeEffect(input: MailOutboundEffectRecord): MailOutboundEffectRecord {
  if (
    input.version !== 1
    || typeof input.outboundEffectId !== "string"
    || typeof input.threadId !== "string"
    || typeof input.handle !== "string"
    || typeof input.provider !== "string"
    || typeof input.accountBinding !== "string"
    || !Number.isInteger(input.attemptNumber)
    || input.attemptNumber < 1
    || typeof input.contentFingerprint !== "string"
    || typeof input.rfcMessageId !== "string"
    || typeof input.reservedAt !== "string"
    || !["reserved", "sent", "ambiguous", "failed", "reconciled"].includes(input.state)
  ) {
    throw new TypeError("Stored mail delivery effect is invalid");
  }
  const receipt = input.receipt === null ? null : freezeMailDeliveryReceipt(input.receipt);
  if ((input.state === "reserved") !== (receipt === null)) {
    throw new TypeError("Stored mail delivery effect state and receipt disagree");
  }
  return Object.freeze({ ...input, receipt });
}
