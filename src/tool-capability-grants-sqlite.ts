import { createHash, randomUUID } from "node:crypto";
import {
  authorizeToolCapability,
  buildToolCapabilityGrant,
  buildToolCapabilityRequest,
  projectToolCapabilityGrant,
  type ToolCapabilityApprovalInput,
  type ToolCapabilityAuthorization,
  type ToolCapabilityDenialReason,
  type ToolCapabilityGrant,
  type ToolCapabilityGrantInput,
  type ToolCapabilityRequestInput,
  type ToolCapabilityResourceInput,
  type ToolCapabilityResourceKind,
} from "./tool-capability-grant.js";
import type { StensiblyStore } from "./store.js";

export interface ToolCapabilityGrantStoreOptions {
  clock?: () => Date;
}

export interface AcceptSqliteToolCapabilityGrantInput {
  workspace: string;
  project: string;
  grant: ToolCapabilityGrant;
  expectedCurrentGeneration: number | null;
  acceptanceRef: string;
  acceptedBy: string;
}

export interface SqliteToolCapabilityGrantRecord {
  id: string;
  workspace: string;
  project: string;
  grantId: string;
  generation: number;
  fingerprint: string;
  grant: ToolCapabilityGrant;
  acceptanceRef: string;
  acceptedBy: string;
  acceptedAt: string;
  isCurrent: boolean;
}

export interface SqliteToolCapabilityGrantAcceptance {
  record: SqliteToolCapabilityGrantRecord;
  replayed: boolean;
}

export interface RevokeSqliteToolCapabilityGrantInput {
  workspace: string;
  project: string;
  grantId: string;
  expectedGeneration: number;
  expectedFingerprint: string;
  revokedBy: string;
  reasonCode: string;
  idempotencyKey: string;
}

export interface SqliteToolCapabilityRevocationRecord {
  id: string;
  workspace: string;
  project: string;
  grantId: string;
  generation: number;
  grantFingerprint: string;
  revokedAt: string;
  revokedBy: string;
  reasonCode: string;
  idempotencyKey: string;
  recordedAt: string;
}

export interface SqliteToolCapabilityRevocationAcceptance {
  record: SqliteToolCapabilityRevocationRecord;
  replayed: boolean;
}

export interface ReserveSqliteToolCapabilityUseInput {
  workspace: string;
  project: string;
  grantId: string;
  expectedGeneration: number;
  request: ToolCapabilityRequestInput;
  idempotencyKey: string;
}

export interface SqliteToolCapabilityAdmissionRecord {
  id: string;
  workspace: string;
  project: string;
  idempotencyKey: string;
  attemptFingerprint: string;
  grantId: string;
  expectedGeneration: number;
  acceptedGrantGeneration: number | null;
  acceptedGrantFingerprint: string | null;
  requestFingerprint: string;
  authorization: ToolCapabilityAuthorization;
  recordedAt: string;
}

export interface SqliteToolCapabilityAdmissionResult {
  record: SqliteToolCapabilityAdmissionRecord;
  replayed: boolean;
}

interface GrantRow {
  sequence: number;
  id: string;
  workspace_id: string;
  project_id: string;
  grant_id: string;
  generation: number;
  fingerprint: string;
  grant_json: string;
  acceptance_ref: string;
  accepted_by: string;
  accepted_at: string;
  is_current: number;
}

interface RevocationRow {
  sequence: number;
  id: string;
  workspace_id: string;
  project_id: string;
  grant_id: string;
  generation: number;
  grant_fingerprint: string;
  revoked_at: string;
  revoked_by: string;
  reason_code: string;
  idempotency_key: string;
  recorded_at: string;
}

interface UsageRow {
  permission_id: string;
  used_uses: number;
}

interface ConsumedUsageRow {
  used_uses: number;
}

interface AdmissionRow {
  sequence: number;
  id: string;
  workspace_id: string;
  project_id: string;
  idempotency_key: string;
  attempt_fingerprint: string;
  grant_id: string;
  expected_generation: number;
  accepted_grant_generation: number | null;
  accepted_grant_fingerprint: string | null;
  request_fingerprint: string;
  authorization_sha256: string;
  authorization_json: string;
  recorded_at: string;
}

const limits = {
  workspace: 80,
  project: 80,
  identifier: 240,
  reasonCode: 160,
} as const;

const workspacePattern = /^[a-z0-9][a-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/;
const reasonCodePattern = /^[a-z0-9][a-z0-9._-]*$/;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const denialReasons = new Set<ToolCapabilityDenialReason>([
  "grant_untrusted",
  "grant_tampered",
  "request_invalid",
  "grant_not_yet_active",
  "grant_expired",
  "grant_revoked",
  "generation_mismatch",
  "workspace_mismatch",
  "project_mismatch",
  "actor_mismatch",
  "worker_session_mismatch",
  "run_mismatch",
  "action_not_allowed",
  "resource_not_allowed",
  "arguments_not_allowed",
  "approval_required",
  "approval_rejected",
  "approval_expired",
  "budget_exhausted",
]);

export class ToolCapabilityGrantStorageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCapabilityGrantStorageConflictError";
  }
}

export function ensureToolCapabilityGrantSchema(store: StensiblyStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS tool_capability_grants (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      grant_json TEXT NOT NULL,
      acceptance_ref TEXT NOT NULL,
      accepted_by TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      is_current INTEGER NOT NULL CHECK (is_current IN (0, 1))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_capability_grant_generation
      ON tool_capability_grants(workspace_id, project_id, grant_id, generation);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_capability_grant_acceptance
      ON tool_capability_grants(workspace_id, project_id, acceptance_ref);

    CREATE INDEX IF NOT EXISTS idx_tool_capability_grant_current
      ON tool_capability_grants(workspace_id, project_id, grant_id, is_current, sequence DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_capability_grant_one_current
    ON tool_capability_grants(workspace_id, project_id, grant_id)
    WHERE is_current = 1;

    CREATE TABLE IF NOT EXISTS tool_capability_revocations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      grant_fingerprint TEXT NOT NULL,
      revoked_at TEXT NOT NULL,
      revoked_by TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_capability_revocation_generation
      ON tool_capability_revocations(workspace_id, project_id, grant_id, generation);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_capability_revocation_idempotency
      ON tool_capability_revocations(workspace_id, project_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS tool_capability_permission_usage (
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      grant_fingerprint TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      used_uses INTEGER NOT NULL CHECK (used_uses >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (
        workspace_id,
        project_id,
        grant_id,
        generation,
        grant_fingerprint,
        permission_id
      )
    );

    CREATE TABLE IF NOT EXISTS tool_capability_admissions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      attempt_fingerprint TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      expected_generation INTEGER NOT NULL,
      accepted_grant_generation INTEGER,
      accepted_grant_fingerprint TEXT,
      request_fingerprint TEXT NOT NULL,
      authorization_sha256 TEXT NOT NULL,
      authorization_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_capability_admission_idempotency
      ON tool_capability_admissions(workspace_id, project_id, idempotency_key);

    CREATE INDEX IF NOT EXISTS idx_tool_capability_admission_grant
      ON tool_capability_admissions(
        workspace_id,
        project_id,
        grant_id,
        expected_generation,
        sequence ASC
      );
  `);
}

export function acceptSqliteToolCapabilityGrant(
  store: StensiblyStore,
  input: AcceptSqliteToolCapabilityGrantInput,
  options: ToolCapabilityGrantStoreOptions = {},
): SqliteToolCapabilityGrantAcceptance {
  ensureToolCapabilityGrantSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const acceptanceRef = boundedIdentifier(input.acceptanceRef, "Grant acceptance reference");
  const acceptedBy = boundedIdentifier(input.acceptedBy, "Grant accepting actor");
  const grant = validateAcceptedGrant(input.grant);
  if (grant.workspace !== workspace || grant.project !== project) {
    throw new ToolCapabilityGrantStorageConflictError(
      "Accepted grant workspace and project must match the storage scope",
    );
  }
  const expectedCurrentGeneration = input.expectedCurrentGeneration === null
    ? null
    : positiveInteger(input.expectedCurrentGeneration, "Expected current grant generation");

  return store.db.transaction(() => {
    const existingAcceptance = getGrantRowByAcceptanceRef(
      store,
      workspace,
      project,
      acceptanceRef,
    );
    if (existingAcceptance) {
      const record = mapGrantRecord(existingAcceptance);
      if (record.fingerprint !== grant.fingerprint || record.acceptedBy !== acceptedBy) {
        throw new ToolCapabilityGrantStorageConflictError(
          `Grant acceptance reference ${acceptanceRef} was reused with altered content`,
        );
      }
      return { record, replayed: true };
    }

    const sameGeneration = getGrantRowByGeneration(
      store,
      workspace,
      project,
      grant.grantId,
      grant.generation,
    );
    if (sameGeneration) {
      const record = mapGrantRecord(sameGeneration);
      if (
      record.fingerprint !== grant.fingerprint
      || record.acceptanceRef !== acceptanceRef
      || record.acceptedBy !== acceptedBy
    ) {
        throw new ToolCapabilityGrantStorageConflictError(
          `Grant ${grant.grantId} generation ${grant.generation} was reused with altered content or acceptance provenance`,
        );
      }
      return { record, replayed: true };
    }

    const current = getCurrentSqliteToolCapabilityGrant(store, {
      workspace,
      project,
      grantId: grant.grantId,
    });
    if (current === null) {
      if (expectedCurrentGeneration !== null) {
        throw new ToolCapabilityGrantStorageConflictError(
          `Expected current generation ${expectedCurrentGeneration}, but no current grant exists`,
        );
      }
    } else {
      if (expectedCurrentGeneration !== current.generation) {
        throw new ToolCapabilityGrantStorageConflictError(
          `Expected current generation ${String(expectedCurrentGeneration)}, but found ${current.generation}`,
        );
      }
      if (grant.generation <= current.generation) {
        throw new ToolCapabilityGrantStorageConflictError(
          `New grant generation ${grant.generation} must exceed current generation ${current.generation}`,
        );
      }
      if (
        grant.actorId !== current.grant.actorId
        || grant.workerSessionId !== current.grant.workerSessionId
        || grant.runId !== current.grant.runId
      ) {
        throw new ToolCapabilityGrantStorageConflictError(
          "A higher generation must preserve the grant actor, worker session, and run",
        );
      }
      store.db.query(`
        UPDATE tool_capability_grants
        SET is_current = 0
        WHERE workspace_id = ?1
          AND project_id = ?2
          AND grant_id = ?3
          AND is_current = 1
      `).run(workspace, project, grant.grantId);
    }

    const id = `accepted_grant_${randomUUID()}`;
    const acceptedAt = serverTimestamp(options, "Grant acceptance time");
    store.db.query(`
      INSERT INTO tool_capability_grants (
        id,
        workspace_id,
        project_id,
        grant_id,
        generation,
        fingerprint,
        grant_json,
        acceptance_ref,
        accepted_by,
        accepted_at,
        is_current
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)
    `).run(
      id,
      workspace,
      project,
      grant.grantId,
      grant.generation,
      grant.fingerprint,
      JSON.stringify(grant),
      acceptanceRef,
      acceptedBy,
      acceptedAt,
    );
    const inserted = getGrantRowById(store, id);
    if (!inserted) throw new Error("Accepted tool capability grant disappeared");
    return { record: mapGrantRecord(inserted), replayed: false };
  })();
}

export function getCurrentSqliteToolCapabilityGrant(
  store: StensiblyStore,
  input: { workspace: string; project: string; grantId: string },
): SqliteToolCapabilityGrantRecord | null {
  ensureToolCapabilityGrantSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const grantId = boundedIdentifier(input.grantId, "Grant ID");
  const row = store.db.query<GrantRow, [string, string, string]>(`
    SELECT *
    FROM tool_capability_grants
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND grant_id = ?3
      AND is_current = 1
    ORDER BY sequence DESC
    LIMIT 1
  `).get(workspace, project, grantId);
  return row ? mapGrantRecord(row) : null;
}

export function listSqliteToolCapabilityGrantHistory(
  store: StensiblyStore,
  input: { workspace: string; project: string; grantId: string },
): SqliteToolCapabilityGrantRecord[] {
  ensureToolCapabilityGrantSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const grantId = boundedIdentifier(input.grantId, "Grant ID");
  return store.db.query<GrantRow, [string, string, string]>(`
    SELECT *
    FROM tool_capability_grants
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND grant_id = ?3
    ORDER BY sequence ASC
  `).all(workspace, project, grantId).map(mapGrantRecord);
}

export function revokeSqliteToolCapabilityGrant(
  store: StensiblyStore,
  input: RevokeSqliteToolCapabilityGrantInput,
  options: ToolCapabilityGrantStoreOptions = {},
): SqliteToolCapabilityRevocationAcceptance {
  ensureToolCapabilityGrantSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const grantId = boundedIdentifier(input.grantId, "Grant ID");
  const expectedGeneration = positiveInteger(
    input.expectedGeneration,
    "Expected grant generation",
  );
  const expectedFingerprint = boundedFingerprint(
    input.expectedFingerprint,
    "Expected grant fingerprint",
  );
  const revokedAt = serverTimestamp(options, "Grant revocation time");
  const revokedBy = boundedIdentifier(input.revokedBy, "Revoking actor");
  const reasonCode = boundedReasonCode(input.reasonCode);
  const idempotencyKey = boundedIdentifier(
    input.idempotencyKey,
    "Grant revocation idempotency key",
  );

  return store.db.transaction(() => {
    const existingByKey = getRevocationRowByIdempotencyKey(
      store,
      workspace,
      project,
      idempotencyKey,
    );
    if (existingByKey) {
      const record = mapRevocationRecord(existingByKey);
      if (!sameRevocation(record, {
        workspace,
        project,
        grantId,
        expectedGeneration,
        expectedFingerprint,
        revokedAt,
        revokedBy,
        reasonCode,
        idempotencyKey,
      })) {
        throw new ToolCapabilityGrantStorageConflictError(
          `Grant revocation idempotency key ${idempotencyKey} was reused with altered content`,
        );
      }
      return { record, replayed: true };
    }

    const current = getCurrentSqliteToolCapabilityGrant(store, {
      workspace,
      project,
      grantId,
    });
    if (!current) {
      throw new ToolCapabilityGrantStorageConflictError(
        `No current grant ${grantId} exists in ${workspace}/${project}`,
      );
    }
    if (
      current.generation !== expectedGeneration
      || current.fingerprint !== expectedFingerprint
    ) {
      throw new ToolCapabilityGrantStorageConflictError(
        "Grant revocation must bind the current generation and fingerprint",
      );
    }
    if (
      Date.parse(revokedAt) < Date.parse(current.grant.issuedAt)
      || Date.parse(revokedAt) > Date.parse(current.grant.expiresAt)
    ) {
      throw new RangeError("Grant revocation time must fall within the grant lifetime");
    }

    const existingGeneration = getRevocationRowByGeneration(
      store,
      workspace,
      project,
      grantId,
      expectedGeneration,
    );
    if (existingGeneration) {
      const record = mapRevocationRecord(existingGeneration);
      if (!sameRevocation(record, {
        workspace,
        project,
        grantId,
        expectedGeneration,
        expectedFingerprint,
        revokedAt,
        revokedBy,
        reasonCode,
        idempotencyKey: record.idempotencyKey,
      })) {
        throw new ToolCapabilityGrantStorageConflictError(
          `Grant ${grantId} generation ${expectedGeneration} already has another revocation`,
        );
      }
      return { record, replayed: true };
    }

    const id = `grant_revocation_${randomUUID()}`;
    store.db.query(`
      INSERT INTO tool_capability_revocations (
        id,
        workspace_id,
        project_id,
        grant_id,
        generation,
        grant_fingerprint,
        revoked_at,
        revoked_by,
        reason_code,
        idempotency_key,
        recorded_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `).run(
      id,
      workspace,
      project,
      grantId,
      expectedGeneration,
      expectedFingerprint,
      revokedAt,
      revokedBy,
      reasonCode,
      idempotencyKey,
      revokedAt,
    );
    const inserted = getRevocationRowById(store, id);
    if (!inserted) throw new Error("Tool capability revocation disappeared");
    return { record: mapRevocationRecord(inserted), replayed: false };
  })();
}

export function getSqliteToolCapabilityRevocation(
  store: StensiblyStore,
  input: { workspace: string; project: string; grantId: string; generation: number },
): SqliteToolCapabilityRevocationRecord | null {
  ensureToolCapabilityGrantSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const grantId = boundedIdentifier(input.grantId, "Grant ID");
  const generation = positiveInteger(input.generation, "Grant generation");
  const row = getRevocationRowByGeneration(store, workspace, project, grantId, generation);
  return row ? mapRevocationRecord(row) : null;
}

export function reserveSqliteToolCapabilityUse(
  store: StensiblyStore,
  input: ReserveSqliteToolCapabilityUseInput,
  options: ToolCapabilityGrantStoreOptions = {},
): SqliteToolCapabilityAdmissionResult {
  ensureToolCapabilityGrantSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const grantId = boundedIdentifier(input.grantId, "Grant ID");
  const expectedGeneration = positiveInteger(
    input.expectedGeneration,
    "Expected grant generation",
  );
  const idempotencyKey = boundedIdentifier(
    input.idempotencyKey,
    "Tool admission idempotency key",
  );
  const request = buildToolCapabilityRequest(input.request);
  const attemptFingerprint = hash(stableJson({
    version: 1,
    workspace,
    project,
    grantId,
    expectedGeneration,
    requestFingerprint: request.fingerprint,
  }));

  return store.db.transaction(() => {
    const existing = getAdmissionRowByIdempotencyKey(
      store,
      workspace,
      project,
      idempotencyKey,
    );
    if (existing) {
      const record = mapAdmissionRecord(existing);
      if (record.attemptFingerprint !== attemptFingerprint) {
        throw new ToolCapabilityGrantStorageConflictError(
          `Tool admission idempotency key ${idempotencyKey} was reused with altered content`,
        );
      }
      return { record, replayed: true };
    }

    const now = serverTimestamp(options, "Tool admission time");
    const current = getCurrentSqliteToolCapabilityGrant(store, {
      workspace,
      project,
      grantId,
    });
    let authorization: ToolCapabilityAuthorization;
    if (!current) {
      authorization = denied(grantId, request.fingerprint, "grant_untrusted");
    } else {
      const revocation = getRevocationRowByGeneration(
        store,
        workspace,
        project,
        grantId,
        current.generation,
      );
      if (revocation && Date.parse(now) >= Date.parse(revocation.revoked_at)) {
        authorization = denied(grantId, request.fingerprint, "grant_revoked");
      } else {
        const usageByPermission = getUsageByPermission(store, current);
        authorization = authorizeToolCapability(current.grant, {
          now,
          trustedGrantFingerprint: current.fingerprint,
          expectedGeneration,
          request: input.request,
          usageByPermission,
        });
        if (authorization.authorized) {
          const authorized = authorization;
          const permission = current.grant.permissions.find((candidate) =>
            candidate.permissionId === authorized.permissionId
          );
          if (!permission) {
            throw new Error("Authorized permission is absent from the accepted grant");
          }
          const consumedUses = tryConsumePermissionUse(
            store,
            current,
            authorized.permissionId,
            permission.maxUses,
            now,
          );
          authorization = consumedUses === null
            ? denied(grantId, request.fingerprint, "budget_exhausted")
            : {
              ...authorized,
              remainingUsesAfterAuthorization: permission.maxUses - consumedUses,
            };
        }
      }
    }

    const id = `tool_admission_${randomUUID()}`;
    const authorizationJson = JSON.stringify(authorization);
    const authorizationSha256 = hash(authorizationJson);
    store.db.query(`
      INSERT INTO tool_capability_admissions (
        id,
        workspace_id,
        project_id,
        idempotency_key,
        attempt_fingerprint,
        grant_id,
        expected_generation,
        accepted_grant_generation,
        accepted_grant_fingerprint,
        request_fingerprint,
        authorization_sha256,
        authorization_json,
        recorded_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `).run(
      id,
      workspace,
      project,
      idempotencyKey,
      attemptFingerprint,
      grantId,
      expectedGeneration,
      current?.generation ?? null,
      current?.fingerprint ?? null,
      request.fingerprint,
      authorizationSha256,
      authorizationJson,
      now,
    );
    const inserted = getAdmissionRowById(store, id);
    if (!inserted) throw new Error("Tool capability admission disappeared");
    return { record: mapAdmissionRecord(inserted), replayed: false };
  })();
}

export function getSqliteToolCapabilityPermissionUsage(
  store: StensiblyStore,
  input: {
    workspace: string;
    project: string;
    grantId: string;
    generation: number;
    fingerprint: string;
    permissionId: string;
  },
): number {
  ensureToolCapabilityGrantSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const grantId = boundedIdentifier(input.grantId, "Grant ID");
  const generation = positiveInteger(input.generation, "Grant generation");
  const fingerprint = boundedFingerprint(input.fingerprint, "Grant fingerprint");
  const permissionId = boundedIdentifier(input.permissionId, "Permission ID");
  const row = store.db.query<UsageRow, [string, string, string, number, string, string]>(`
    SELECT permission_id, used_uses
    FROM tool_capability_permission_usage
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND grant_id = ?3
      AND generation = ?4
      AND grant_fingerprint = ?5
      AND permission_id = ?6
  `).get(workspace, project, grantId, generation, fingerprint, permissionId);
  return row?.used_uses ?? 0;
}

export function listSqliteToolCapabilityAdmissions(
  store: StensiblyStore,
  input: { workspace: string; project: string; grantId: string },
): SqliteToolCapabilityAdmissionRecord[] {
  ensureToolCapabilityGrantSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const grantId = boundedIdentifier(input.grantId, "Grant ID");
  return store.db.query<AdmissionRow, [string, string, string]>(`
    SELECT *
    FROM tool_capability_admissions
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND grant_id = ?3
    ORDER BY sequence ASC
  `).all(workspace, project, grantId).map(mapAdmissionRecord);
}

function validateAcceptedGrant(value: ToolCapabilityGrant): ToolCapabilityGrant {
  if (!isRecord(value)) throw new RangeError("Accepted tool capability grant must be an object");
  const grant = value as ToolCapabilityGrant;
  if (grant.revocation !== null) {
    throw new RangeError("Accepted grants must be immutable and unrevoked; use the revocation ledger");
  }
  const rebuilt = rebuildAcceptedGrant(grant);
  const projection = projectToolCapabilityGrant(rebuilt, {
    now: rebuilt.issuedAt,
    trustedGrantFingerprint: rebuilt.fingerprint,
  });
  if (
    projection.state === "invalid"
    || projection.grantId !== rebuilt.grantId
    || stableJson(rebuilt) !== stableJson(grant)
  ) {
    throw new RangeError("Accepted tool capability grant fingerprint or canonical shape is invalid");
  }
  return rebuilt;
}

function rebuildAcceptedGrant(grant: ToolCapabilityGrant): ToolCapabilityGrant {
  const input: ToolCapabilityGrantInput = {
    grantId: grant.grantId,
    workspace: grant.workspace,
    project: grant.project,
    actorId: grant.actorId,
    workerSessionId: grant.workerSessionId,
    runId: grant.runId,
    generation: grant.generation,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    issuer: grant.issuer,
    evidenceRefs: grant.evidenceRefs,
    permissions: grant.permissions.map((permission) => ({
      permissionId: permission.permissionId,
      action: permission.request.action,
      resource: parseResourceKey(
        permission.request.resource.kind,
        permission.request.resource.key,
      ),
      arguments: permission.request.arguments,
      maxUses: permission.maxUses,
      approval: approvalInput(permission.approval),
    })),
  };
  return buildToolCapabilityGrant(input);
}

function approvalInput(
  approval: ToolCapabilityGrant["permissions"][number]["approval"],
): ToolCapabilityApprovalInput | undefined {
  if (approval.state === "not_required") return undefined;
  if (approval.state === "pending") {
    return {
      state: approval.state,
      approvalId: approval.approvalId,
      bindingFingerprint: approval.bindingFingerprint,
      expiresAt: approval.expiresAt,
    };
  }
  return {
    state: approval.state,
    approvalId: approval.approvalId,
    bindingFingerprint: approval.bindingFingerprint,
    decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt,
    expiresAt: approval.expiresAt,
  };
}

function parseResourceKey(
  kind: ToolCapabilityResourceKind,
  key: string,
): ToolCapabilityResourceInput {
  let match: RegExpExecArray | null;
  switch (kind) {
    case "github_repository":
      match = /^github:repository:([^/]+)\/(.+)$/.exec(key);
      if (match) return { kind, owner: match[1]!, repository: match[2]! };
      break;
    case "github_branch_prefix":
      match = /^github:branch-prefix:([^/]+)\/([^:]+):(.+)$/.exec(key);
      if (match) {
        return { kind, owner: match[1]!, repository: match[2]!, prefix: match[3]! };
      }
      break;
    case "github_pull_request":
      match = /^github:pull-request:([^/]+)\/([^#]+)#([1-9][0-9]*)@([a-f0-9]{40})$/.exec(key);
      if (match) {
        return {
          kind,
          owner: match[1]!,
          repository: match[2]!,
          number: Number(match[3]),
          headSha: match[4]!,
        };
      }
      break;
    case "stensibly_project":
      match = /^stensibly:project:([^/]+)\/(.+)$/.exec(key);
      if (match) return { kind, workspace: match[1]!, project: match[2]! };
      break;
    case "deployment_environment":
      match = /^deployment:environment:([^@]+)@([a-f0-9]{40})$/.exec(key);
      if (match) return { kind, environment: match[1]!, sourceSha: match[2]! };
      break;
    case "credential_handle":
      match = /^credential:handle:(.+)$/.exec(key);
      if (match) return { kind, handle: match[1]! };
      break;
    case "external_recipient":
      match = /^external:recipient:([^:]+):(.+)$/.exec(key);
      if (match) return { kind, provider: match[1]!, recipientRef: match[2]! };
      break;
    case "resource_record":
      match = /^resource:([^:]+):([^:]+):(.+)$/.exec(key);
      if (match) {
        return {
          kind,
          system: match[1]!,
          resourceType: match[2]!,
          resourceId: match[3]!,
        };
      }
      break;
    case "spend_budget":
      match = /^spend:([A-Z]{3}):([1-9][0-9]*)$/.exec(key);
      if (match) {
        return {
          kind,
          currency: match[1]!,
          maximumMinorUnits: Number(match[2]),
        };
      }
      break;
  }
  throw new RangeError(`Tool capability resource key ${key} is invalid for ${kind}`);
}

function mapGrantRecord(row: GrantRow): SqliteToolCapabilityGrantRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.grant_json);
  } catch {
    throw new Error(`Stored tool capability grant ${row.id} is not valid JSON`);
  }
  const grant = validateAcceptedGrant(parsed as ToolCapabilityGrant);
  if (
    grant.workspace !== row.workspace_id
    || grant.project !== row.project_id
    || grant.grantId !== row.grant_id
    || grant.generation !== row.generation
    || grant.fingerprint !== row.fingerprint
  ) {
    throw new Error(`Stored tool capability grant ${row.id} metadata does not match its grant`);
  }
  return {
    id: row.id,
    workspace: row.workspace_id,
    project: row.project_id,
    grantId: row.grant_id,
    generation: row.generation,
    fingerprint: row.fingerprint,
    grant,
    acceptanceRef: boundedIdentifier(row.acceptance_ref, "Stored grant acceptance reference"),
    acceptedBy: boundedIdentifier(row.accepted_by, "Stored grant accepting actor"),
    acceptedAt: canonicalTimestamp(row.accepted_at, "Stored grant acceptance time"),
    isCurrent: row.is_current === 1,
  };
}

function mapRevocationRecord(row: RevocationRow): SqliteToolCapabilityRevocationRecord {
  return {
    id: row.id,
    workspace: row.workspace_id,
    project: row.project_id,
    grantId: row.grant_id,
    generation: positiveInteger(row.generation, "Stored grant generation"),
    grantFingerprint: boundedFingerprint(
      row.grant_fingerprint,
      "Stored grant fingerprint",
    ),
    revokedAt: canonicalTimestamp(row.revoked_at, "Stored grant revocation time"),
    revokedBy: boundedIdentifier(row.revoked_by, "Stored revoking actor"),
    reasonCode: boundedReasonCode(row.reason_code),
    idempotencyKey: boundedIdentifier(
      row.idempotency_key,
      "Stored revocation idempotency key",
    ),
    recordedAt: canonicalTimestamp(row.recorded_at, "Stored revocation record time"),
  };
}

function mapAdmissionRecord(row: AdmissionRow): SqliteToolCapabilityAdmissionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.authorization_json);
  } catch {
    throw new Error(`Stored tool admission ${row.id} authorization is not valid JSON`);
  }
  if (hash(row.authorization_json) !== row.authorization_sha256) {
    throw new Error(`Stored tool admission ${row.id} authorization fingerprint is invalid`);
  }
  const authorization = validateStoredAuthorization(parsed, row);
  return {
    id: row.id,
    workspace: row.workspace_id,
    project: row.project_id,
    idempotencyKey: boundedIdentifier(
      row.idempotency_key,
      "Stored admission idempotency key",
    ),
    attemptFingerprint: boundedFingerprint(
      row.attempt_fingerprint,
      "Stored admission attempt fingerprint",
    ),
    grantId: row.grant_id,
    expectedGeneration: positiveInteger(
      row.expected_generation,
      "Stored expected grant generation",
    ),
    acceptedGrantGeneration: row.accepted_grant_generation === null
      ? null
      : positiveInteger(row.accepted_grant_generation, "Stored accepted grant generation"),
    acceptedGrantFingerprint: row.accepted_grant_fingerprint === null
      ? null
      : boundedFingerprint(
        row.accepted_grant_fingerprint,
        "Stored accepted grant fingerprint",
      ),
    requestFingerprint: boundedFingerprint(
      row.request_fingerprint,
      "Stored request fingerprint",
    ),
    authorization,
    recordedAt: canonicalTimestamp(row.recorded_at, "Stored admission time"),
  };
}

function validateStoredAuthorization(
  value: unknown,
  row: AdmissionRow,
): ToolCapabilityAuthorization {
  if (!isRecord(value) || typeof value.authorized !== "boolean") {
    throw new Error(`Stored tool admission ${row.id} authorization is invalid`);
  }
  if (value.authorized === true) {
    if (
      typeof value.grantId !== "string"
      || typeof value.permissionId !== "string"
      || !Number.isSafeInteger(value.generation)
      || typeof value.requestFingerprint !== "string"
      || typeof value.resourceKey !== "string"
      || (value.approvalId !== null && typeof value.approvalId !== "string")
      || typeof value.expiresAt !== "string"
      || value.consumesUse !== true
      || !Number.isSafeInteger(value.remainingUsesAfterAuthorization)
      || value.remainingUsesAfterAuthorization < 0
      || row.accepted_grant_generation !== value.generation
      || row.accepted_grant_fingerprint === null
    ) {
      throw new Error(`Stored tool admission ${row.id} authorization is invalid`);
    }
  } else if (
    typeof value.grantId !== "string"
    || (value.requestFingerprint !== null && typeof value.requestFingerprint !== "string")
    || typeof value.reason !== "string"
    || !denialReasons.has(value.reason as ToolCapabilityDenialReason)
  ) {
    throw new Error(`Stored tool admission ${row.id} denial is invalid`);
  }
  if (value.grantId !== row.grant_id || value.requestFingerprint !== row.request_fingerprint) {
    throw new Error(`Stored tool admission ${row.id} metadata does not match its authorization`);
  }
  return value as ToolCapabilityAuthorization;
}

function getUsageByPermission(
  store: StensiblyStore,
  grant: SqliteToolCapabilityGrantRecord,
): Record<string, number> {
  const rows = store.db.query<UsageRow, [string, string, string, number, string]>(`
    SELECT permission_id, used_uses
    FROM tool_capability_permission_usage
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND grant_id = ?3
      AND generation = ?4
      AND grant_fingerprint = ?5
  `).all(
    grant.workspace,
    grant.project,
    grant.grantId,
    grant.generation,
    grant.fingerprint,
  );
  return Object.fromEntries(rows.map((row) => [row.permission_id, row.used_uses]));
}

function tryConsumePermissionUse(
  store: StensiblyStore,
  grant: SqliteToolCapabilityGrantRecord,
  permissionId: string,
  maxUses: number,
  now: string,
): number | null {
  const row = store.db.query<ConsumedUsageRow, [
    string,
    string,
    string,
    number,
    string,
    string,
    string,
    number,
  ]>(`
    INSERT INTO tool_capability_permission_usage (
      workspace_id,
      project_id,
      grant_id,
      generation,
      grant_fingerprint,
      permission_id,
      used_uses,
      updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
    ON CONFLICT (
      workspace_id,
      project_id,
      grant_id,
      generation,
      grant_fingerprint,
      permission_id
    ) DO UPDATE SET
      used_uses = tool_capability_permission_usage.used_uses + 1,
      updated_at = excluded.updated_at
    WHERE tool_capability_permission_usage.used_uses < ?8
    RETURNING used_uses
  `).get(
    grant.workspace,
    grant.project,
    grant.grantId,
    grant.generation,
    grant.fingerprint,
    permissionId,
    now,
    maxUses,
  );
  return row?.used_uses ?? null;
}

function getGrantRowById(store: StensiblyStore, id: string): GrantRow | null {
  return store.db.query<GrantRow, [string]>(`
    SELECT * FROM tool_capability_grants WHERE id = ?1
  `).get(id) ?? null;
}

function getGrantRowByAcceptanceRef(
  store: StensiblyStore,
  workspace: string,
  project: string,
  acceptanceRef: string,
): GrantRow | null {
  return store.db.query<GrantRow, [string, string, string]>(`
    SELECT *
    FROM tool_capability_grants
    WHERE workspace_id = ?1 AND project_id = ?2 AND acceptance_ref = ?3
    LIMIT 1
  `).get(workspace, project, acceptanceRef) ?? null;
}

function getGrantRowByGeneration(
  store: StensiblyStore,
  workspace: string,
  project: string,
  grantId: string,
  generation: number,
): GrantRow | null {
  return store.db.query<GrantRow, [string, string, string, number]>(`
    SELECT *
    FROM tool_capability_grants
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND grant_id = ?3
      AND generation = ?4
    LIMIT 1
  `).get(workspace, project, grantId, generation) ?? null;
}

function getRevocationRowById(store: StensiblyStore, id: string): RevocationRow | null {
  return store.db.query<RevocationRow, [string]>(`
    SELECT * FROM tool_capability_revocations WHERE id = ?1
  `).get(id) ?? null;
}

function getRevocationRowByIdempotencyKey(
  store: StensiblyStore,
  workspace: string,
  project: string,
  idempotencyKey: string,
): RevocationRow | null {
  return store.db.query<RevocationRow, [string, string, string]>(`
    SELECT *
    FROM tool_capability_revocations
    WHERE workspace_id = ?1 AND project_id = ?2 AND idempotency_key = ?3
    LIMIT 1
  `).get(workspace, project, idempotencyKey) ?? null;
}

function getRevocationRowByGeneration(
  store: StensiblyStore,
  workspace: string,
  project: string,
  grantId: string,
  generation: number,
): RevocationRow | null {
  return store.db.query<RevocationRow, [string, string, string, number]>(`
    SELECT *
    FROM tool_capability_revocations
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND grant_id = ?3
      AND generation = ?4
    LIMIT 1
  `).get(workspace, project, grantId, generation) ?? null;
}

function getAdmissionRowById(store: StensiblyStore, id: string): AdmissionRow | null {
  return store.db.query<AdmissionRow, [string]>(`
    SELECT * FROM tool_capability_admissions WHERE id = ?1
  `).get(id) ?? null;
}

function getAdmissionRowByIdempotencyKey(
  store: StensiblyStore,
  workspace: string,
  project: string,
  idempotencyKey: string,
): AdmissionRow | null {
  return store.db.query<AdmissionRow, [string, string, string]>(`
    SELECT *
    FROM tool_capability_admissions
    WHERE workspace_id = ?1 AND project_id = ?2 AND idempotency_key = ?3
    LIMIT 1
  `).get(workspace, project, idempotencyKey) ?? null;
}

function sameRevocation(
  record: SqliteToolCapabilityRevocationRecord,
  candidate: {
    workspace: string;
    project: string;
    grantId: string;
    expectedGeneration: number;
    expectedFingerprint: string;
    revokedAt: string;
    revokedBy: string;
    reasonCode: string;
    idempotencyKey: string;
  },
): boolean {
  return record.workspace === candidate.workspace
    && record.project === candidate.project
    && record.grantId === candidate.grantId
    && record.generation === candidate.expectedGeneration
    && record.grantFingerprint === candidate.expectedFingerprint
    && record.revokedBy === candidate.revokedBy
    && record.reasonCode === candidate.reasonCode
    && record.idempotencyKey === candidate.idempotencyKey;
}

function denied(
  grantId: string,
  requestFingerprint: string,
  reason: ToolCapabilityDenialReason,
): ToolCapabilityAuthorization {
  return {
    authorized: false,
    grantId,
    requestFingerprint,
    reason,
  };
}

function serverTimestamp(
  options: ToolCapabilityGrantStoreOptions,
  label: string,
): string {
  const value = (options.clock ?? (() => new Date()))();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} clock returned an invalid date`);
  }
  return value.toISOString();
}

function boundedWorkspace(value: string, label: string): string {
  return boundedPattern(value, label, limits.workspace, workspacePattern).toLowerCase();
}

function boundedIdentifier(value: string, label: string): string {
  return boundedPattern(value, label, limits.identifier, identifierPattern);
}

function boundedReasonCode(value: string): string {
  return boundedPattern(value, "Revocation reason code", limits.reasonCode, reasonCodePattern)
    .toLowerCase();
}

function boundedFingerprint(value: string, label: string): string {
  if (typeof value !== "string" || !fingerprintPattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedPattern(
  value: string,
  label: string,
  maximum: number,
  pattern: RegExp,
): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  if (unsafeTextPattern.test(value)) throw new RangeError(`${label} contains unsafe characters`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || [...normalized].length > maximum || !pattern.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function canonicalTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new RangeError(`${label} must be an ISO UTC timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Canonical JSON number must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) throw new RangeError("Canonical JSON value is invalid");
  const keys = Object.keys(value).sort(codeUnitCompare);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
