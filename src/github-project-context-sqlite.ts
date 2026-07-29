import { randomUUID } from "node:crypto";
import {
  parseAcceptedInstructionSetIdentity,
  parseStoredGitHubIssueContext,
  prepareGitHubProjectIssueContextAcceptance,
  type AcceptGitHubProjectIssueContextInput,
  type GitHubProjectIssueContextAcceptance,
  type GitHubProjectIssueContextRecord,
} from "./github-project-context.js";
import {
  ensureProjectAttachmentSchema,
  getSqliteProjectAttachment,
} from "./project-attachments-sqlite.js";
import type { StensiblyStore } from "./store.js";

interface GitHubProjectIssueContextRow {
  sequence: number;
  id: string;
  workspace_id: string;
  project_id: string;
  external_id: string;
  context_json: string;
  context_snapshot_sha256: string;
  source_revision: string;
  provider_updated_at: string;
  project_attachment_id: string;
  project_attachment_snapshot_sha256: string;
  instruction_set_json: string;
  instruction_set_sha256: string;
  observed_at: string;
  accepted_by: string;
  accepted_at: string;
}

export class SqliteGitHubProjectContextStore {
  constructor(
    readonly store: StensiblyStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    ensureProjectAttachmentSchema(store);
    ensureGitHubProjectContextSchema(store);
  }

  async getIssueContext(input: {
    workspace: string;
    project: string;
    externalId: string;
  }): Promise<GitHubProjectIssueContextRecord | null> {
    const row = this.store.db
      .query<GitHubProjectIssueContextRow, [string, string, string]>(`
        SELECT *
        FROM github_project_issue_contexts
        WHERE workspace_id = ?1
          AND project_id = ?2
          AND external_id = ?3
        ORDER BY sequence DESC
        LIMIT 1
      `)
      .get(input.workspace, input.project, input.externalId);
    return row ? mapRecord(row) : null;
  }

  async listIssueContexts(input: {
    workspace: string;
    project: string;
  }): Promise<GitHubProjectIssueContextRecord[]> {
    const rows = this.store.db
      .query<GitHubProjectIssueContextRow, [string, string]>(`
        SELECT context.*
        FROM github_project_issue_contexts AS context
        INNER JOIN (
          SELECT external_id, MAX(sequence) AS latest_sequence
          FROM github_project_issue_contexts
          WHERE workspace_id = ?1 AND project_id = ?2
          GROUP BY external_id
        ) AS latest
          ON latest.external_id = context.external_id
          AND latest.latest_sequence = context.sequence
        WHERE context.workspace_id = ?1 AND context.project_id = ?2
        ORDER BY context.external_id ASC
      `)
      .all(input.workspace, input.project);
    return rows.map(mapRecord);
  }

  async acceptIssueContext(
    input: AcceptGitHubProjectIssueContextInput,
  ): Promise<GitHubProjectIssueContextAcceptance> {
    const transaction = this.store.db.transaction(() => {
      const externalId = parseStoredGitHubIssueContext(input.context).reference.externalId;
      const current = this.getIssueContextSync({
        workspace: input.workspace,
        project: input.project,
        externalId,
      });
      const attachment = getSqliteProjectAttachment(this.store, input.project);
      const prepared = prepareGitHubProjectIssueContextAcceptance(
        current,
        attachment,
        input,
      );
      if (prepared.replay) {
        return {
          record: prepared.replay,
          replayed: true,
          comparison: prepared.comparison,
        };
      }

      const acceptedAt = this.now().toISOString();
      const id = `ghctx_${randomUUID()}`;
      this.store.db.query(`
        INSERT INTO github_project_issue_contexts (
          id,
          workspace_id,
          project_id,
          external_id,
          context_json,
          context_snapshot_sha256,
          source_revision,
          provider_updated_at,
          project_attachment_id,
          project_attachment_snapshot_sha256,
          instruction_set_json,
          instruction_set_sha256,
          observed_at,
          accepted_by,
          accepted_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, ?14, ?15
        )
      `).run(
        id,
        prepared.workspace,
        prepared.project,
        prepared.context.reference.externalId,
        JSON.stringify(prepared.context),
        prepared.context.snapshotSha256,
        prepared.context.sourceRevision,
        prepared.context.updatedAt,
        attachment!.id,
        attachment!.snapshot.snapshotSha256,
        JSON.stringify(prepared.instructionSet),
        prepared.instructionSet.snapshotSha256,
        prepared.observedAt,
        prepared.acceptedBy,
        acceptedAt,
      );

      const record = this.getIssueContextSync({
        workspace: prepared.workspace,
        project: prepared.project,
        externalId: prepared.context.reference.externalId,
      });
      if (!record || record.id !== id) {
        throw new Error("Accepted GitHub project issue context disappeared");
      }
      return {
        record,
        replayed: false,
        comparison: prepared.comparison,
      };
    });
    return transaction();
  }

  private getIssueContextSync(input: {
    workspace: string;
    project: string;
    externalId: string;
  }): GitHubProjectIssueContextRecord | null {
    const row = this.store.db
      .query<GitHubProjectIssueContextRow, [string, string, string]>(`
        SELECT *
        FROM github_project_issue_contexts
        WHERE workspace_id = ?1
          AND project_id = ?2
          AND external_id = ?3
        ORDER BY sequence DESC
        LIMIT 1
      `)
      .get(input.workspace, input.project, input.externalId);
    return row ? mapRecord(row) : null;
  }
}

export function ensureGitHubProjectContextSchema(store: StensiblyStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS github_project_issue_contexts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      context_json TEXT NOT NULL,
      context_snapshot_sha256 TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      provider_updated_at TEXT NOT NULL,
      project_attachment_id TEXT NOT NULL,
      project_attachment_snapshot_sha256 TEXT NOT NULL,
      instruction_set_json TEXT NOT NULL,
      instruction_set_sha256 TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      accepted_by TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_github_project_issue_context_current
      ON github_project_issue_contexts(
        workspace_id,
        project_id,
        external_id,
        sequence DESC
      );

    CREATE INDEX IF NOT EXISTS idx_github_project_issue_context_attachment
      ON github_project_issue_contexts(
        project_id,
        project_attachment_snapshot_sha256,
        sequence DESC
      );
  `);
}

function mapRecord(row: GitHubProjectIssueContextRow): GitHubProjectIssueContextRecord {
  const context = parseJson(
    row.context_json,
    `Stored GitHub project issue context ${row.id}`,
    parseStoredGitHubIssueContext,
  );
  const instructionSet = parseJson(
    row.instruction_set_json,
    `Stored GitHub project instruction set ${row.id}`,
    parseAcceptedInstructionSetIdentity,
  );
  if (
    context.reference.externalId !== row.external_id
    || context.snapshotSha256 !== row.context_snapshot_sha256
    || context.sourceRevision !== row.source_revision
    || context.updatedAt !== row.provider_updated_at
    || instructionSet.project !== row.project_id
    || instructionSet.projectAttachmentId !== row.project_attachment_id
    || instructionSet.projectAttachmentSnapshotSha256
      !== row.project_attachment_snapshot_sha256
    || instructionSet.snapshotSha256 !== row.instruction_set_sha256
  ) {
    throw new Error(
      `Stored GitHub project issue context ${row.id} metadata does not match its snapshots`,
    );
  }
  return {
    id: row.id,
    workspace: row.workspace_id,
    project: row.project_id,
    context,
    projectAttachmentId: row.project_attachment_id,
    projectAttachmentSnapshotSha256: row.project_attachment_snapshot_sha256,
    instructionSet,
    observedAt: canonicalStoredTimestamp(row.observed_at, "observation"),
    acceptedBy: row.accepted_by,
    acceptedAt: canonicalStoredTimestamp(row.accepted_at, "acceptance"),
  };
}

function parseJson<T>(
  json: string,
  label: string,
  parse: (value: unknown) => T,
): T {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return parse(raw);
}

function canonicalStoredTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`Stored GitHub project context ${label} time is invalid`);
  }
  return value;
}
