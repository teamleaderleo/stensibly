import { randomUUID } from "node:crypto";
import {
  prepareProjectAttachmentAcceptance,
  type AcceptProjectAttachmentInput,
  type ProjectAttachmentAcceptance,
  type ProjectAttachmentRecord,
} from "./project-attachment-ledger.js";
import { parseProjectAttachmentSnapshot } from "./project-contract.js";
import type { StensiblyStore } from "./store.js";

interface ProjectAttachmentRow {
  sequence: number;
  id: string;
  project_id: string;
  snapshot_json: string;
  snapshot_sha256: string;
  content_sha256: string;
  source_path: string;
  source_revision: string;
  accepted_by: string;
  authority_widening: number;
  accepted_at: string;
}

export function ensureProjectAttachmentSchema(store: StensiblyStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS project_attachments (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot_json TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      accepted_by TEXT NOT NULL,
      authority_widening INTEGER NOT NULL CHECK (authority_widening IN (0, 1)),
      accepted_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_attachments_current
      ON project_attachments(project_id, sequence DESC);

    CREATE INDEX IF NOT EXISTS idx_project_attachments_snapshot
      ON project_attachments(project_id, snapshot_sha256, sequence DESC);
  `);
}

export function getSqliteProjectAttachment(
  store: StensiblyStore,
  project: string,
): ProjectAttachmentRecord | null {
  const row = store.db
    .query<ProjectAttachmentRow, [string]>(`
      SELECT *
      FROM project_attachments
      WHERE project_id = ?1
      ORDER BY sequence DESC
      LIMIT 1
    `)
    .get(project);
  return row ? mapAttachment(row) : null;
}

export function acceptSqliteProjectAttachment(
  store: StensiblyStore,
  input: AcceptProjectAttachmentInput,
): ProjectAttachmentAcceptance {
  const transaction = store.db.transaction(() => {
    const current = getSqliteProjectAttachment(store, input.project);
    const prepared = prepareProjectAttachmentAcceptance(current, input);
    if (prepared.replay) {
      return { attachment: prepared.replay, diff: null, replayed: true };
    }

    const acceptedAt = new Date().toISOString();
    const id = `attach_${randomUUID()}`;
    store.db.query(`
      INSERT INTO projects (id, name, created_at)
      VALUES (?1, ?1, ?2)
      ON CONFLICT(id) DO NOTHING
    `).run(input.project, acceptedAt);
    store.db.query(`
      INSERT INTO project_attachments (
        id,
        project_id,
        snapshot_json,
        snapshot_sha256,
        content_sha256,
        source_path,
        source_revision,
        accepted_by,
        authority_widening,
        accepted_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).run(
      id,
      input.project,
      JSON.stringify(prepared.snapshot),
      prepared.snapshot.snapshotSha256,
      prepared.snapshot.source.contentSha256,
      prepared.snapshot.source.path,
      prepared.sourceRevision,
      prepared.acceptedBy,
      prepared.authorityWidening ? 1 : 0,
      acceptedAt,
    );

    const attachment = getSqliteProjectAttachment(store, input.project);
    if (!attachment || attachment.id !== id) {
      throw new Error("Accepted project attachment disappeared");
    }
    return {
      attachment,
      diff: prepared.diff,
      replayed: false,
    };
  });
  return transaction();
}

function mapAttachment(row: ProjectAttachmentRow): ProjectAttachmentRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(row.snapshot_json);
  } catch {
    throw new Error(`Stored project attachment ${row.id} is not valid JSON`);
  }
  const snapshot = parseProjectAttachmentSnapshot(raw);
  if (
    snapshot.snapshotSha256 !== row.snapshot_sha256
    || snapshot.source.contentSha256 !== row.content_sha256
    || snapshot.source.path !== row.source_path
    || snapshot.contract.project !== row.project_id
  ) {
    throw new Error(`Stored project attachment ${row.id} metadata does not match its snapshot`);
  }
  return {
    id: row.id,
    project: row.project_id,
    snapshot,
    sourceRevision: row.source_revision,
    acceptedBy: row.accepted_by,
    authorityWidening: row.authority_widening === 1,
    acceptedAt: row.accepted_at,
  };
}
