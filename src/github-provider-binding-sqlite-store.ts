import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
} from "./github-provider-contracts.js";
import {
  admitGitHubProjectRepositoryBinding,
  admitGitHubProviderConnection,
} from "./github-provider-binding-admission.js";
import type { StensiblyStore } from "./store.js";

interface GitHubProviderConnectionRow {
  sequence: number;
  id: string;
  installation_id: string;
  account_login: string;
  status: GitHubProviderConnection["status"];
  observed_at: string;
  record_json: string;
}

interface GitHubProjectRepositoryBindingRow {
  sequence: number;
  id: string;
  project_id: string;
  repository_full_name: string;
  connection_id: string;
  attachment_id: string;
  attachment_snapshot_sha256: string;
  status: GitHubProjectRepositoryBinding["status"];
  accepted_at: string;
  record_json: string;
}

/** A durable identity or transition was reused with incompatible admitted content. */
export class GitHubProviderBindingStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubProviderBindingStoreConflictError";
  }
}

/**
 * Local SQLite implementation of the provider-neutral binding read contract.
 *
 * Connections form append-only observation histories under one stable ID. Reads return
 * the latest admitted status, so suspension or revocation immediately affects every
 * binding that names the connection. Bindings form append-only project/repository
 * histories: an active record may be closed by one exact revoked tombstone, and a later
 * active record may reopen the repository under a new binding identity.
 */
export class SqliteGitHubProviderBindingStore
  implements GitHubProviderBindingStore
{
  constructor(readonly store: StensiblyStore) {
    ensureGitHubProviderBindingSchema(store);
  }

  async getGitHubProjectRepositoryBinding(
    project: string,
    repositoryFullName: string,
  ): Promise<GitHubProjectRepositoryBinding | null> {
    return getSqliteGitHubProjectRepositoryBinding(
      this.store,
      project,
      repositoryFullName,
    );
  }

  async getGitHubProviderConnection(
    id: string,
  ): Promise<GitHubProviderConnection | null> {
    return getSqliteGitHubProviderConnection(this.store, id);
  }

  async putGitHubProviderConnection(
    input: unknown,
  ): Promise<GitHubProviderConnection> {
    return putSqliteGitHubProviderConnection(this.store, input);
  }

  async putGitHubProjectRepositoryBinding(
    input: unknown,
  ): Promise<GitHubProjectRepositoryBinding> {
    return putSqliteGitHubProjectRepositoryBinding(this.store, input);
  }
}

export function ensureGitHubProviderBindingSchema(store: StensiblyStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS github_provider_connections (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      account_login TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
      observed_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      UNIQUE(id, observed_at)
    );

    CREATE INDEX IF NOT EXISTS idx_github_provider_connections_current
      ON github_provider_connections(id, sequence DESC);

    CREATE INDEX IF NOT EXISTS idx_github_provider_connections_installation
      ON github_provider_connections(installation_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS github_project_repository_bindings (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      repository_full_name TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      attachment_snapshot_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      accepted_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_github_project_repository_bindings_current
      ON github_project_repository_bindings(
        project_id,
        repository_full_name,
        sequence DESC
      );
  `);
}

export function putSqliteGitHubProviderConnection(
  store: StensiblyStore,
  input: unknown,
): GitHubProviderConnection {
  ensureGitHubProviderBindingSchema(store);
  const admitted = admitGitHubProviderConnection(input);
  const canonicalJson = JSON.stringify(admitted);

  return store.db.transaction(() => {
    const exactObservation = getSqliteGitHubProviderConnectionObservation(
      store,
      admitted.id,
      admitted.observedAt,
    );
    if (exactObservation) {
      if (JSON.stringify(exactObservation) !== canonicalJson) {
        throw new GitHubProviderBindingStoreConflictError(
          `GitHub provider connection ${admitted.id} observation time already identifies another record`,
        );
      }
      return exactObservation;
    }

    const installationCurrent = getSqliteGitHubProviderConnectionByInstallationId(
      store,
      admitted.installationId,
    );
    if (installationCurrent && installationCurrent.id !== admitted.id) {
      throw new GitHubProviderBindingStoreConflictError(
        `GitHub App installation ${admitted.installationId} already belongs to connection ${installationCurrent.id}`,
      );
    }

    const current = getSqliteGitHubProviderConnectionById(store, admitted.id);
    if (current) {
      if (admitted.observedAt < current.observedAt) {
        throw new GitHubProviderBindingStoreConflictError(
          `GitHub provider connection ${admitted.id} observation predates the current record`,
        );
      }
      assertStableConnectionIdentity(current, admitted);
    }

    store.db.query(`
      INSERT INTO github_provider_connections (
        id,
        installation_id,
        account_login,
        status,
        observed_at,
        record_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(
      admitted.id,
      admitted.installationId,
      admitted.accountLogin,
      admitted.status,
      admitted.observedAt,
      canonicalJson,
    );

    const stored = getSqliteGitHubProviderConnectionById(store, admitted.id);
    if (!stored || stored.observedAt !== admitted.observedAt) {
      throw new Error("Stored GitHub provider connection disappeared");
    }
    return stored;
  })();
}

export function getSqliteGitHubProviderConnection(
  store: StensiblyStore,
  id: string,
): GitHubProviderConnection | null {
  ensureGitHubProviderBindingSchema(store);
  return getSqliteGitHubProviderConnectionById(store, id);
}

export function putSqliteGitHubProjectRepositoryBinding(
  store: StensiblyStore,
  input: unknown,
): GitHubProjectRepositoryBinding {
  ensureGitHubProviderBindingSchema(store);
  const admittedInput = admitGitHubProjectRepositoryBinding(input);

  return store.db.transaction(() => {
    requireSqliteProject(store, admittedInput.project);

    const existing = getSqliteGitHubProjectRepositoryBindingById(
      store,
      admittedInput.id,
    );
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(admittedInput)) {
        throw new GitHubProviderBindingStoreConflictError(
          `GitHub project binding ID ${admittedInput.id} already identifies another record`,
        );
      }
      return existing;
    }

    const connection = getSqliteGitHubProviderConnectionById(
      store,
      admittedInput.connectionId,
    );
    if (!connection) {
      throw new RangeError(
        `GitHub project binding connection ${admittedInput.connectionId} does not exist`,
      );
    }

    const admitted = admittedInput.status === "active"
      ? admitGitHubProjectRepositoryBinding(admittedInput, connection)
      : admitRevokedBinding(admittedInput, connection);
    const current = getSqliteGitHubProjectRepositoryBinding(
      store,
      admitted.project,
      admitted.repositoryFullName,
    );

    if (admitted.status === "active") {
      if (current?.status === "active") {
        throw new GitHubProviderBindingStoreConflictError(
          `GitHub repository ${admitted.repositoryFullName} already has an active binding for project ${admitted.project}`,
        );
      }
      assertChronological(current, admitted);
    } else {
      if (!current || current.status !== "active") {
        throw new GitHubProviderBindingStoreConflictError(
          `GitHub repository ${admitted.repositoryFullName} has no active binding to revoke for project ${admitted.project}`,
        );
      }
      if (
        admitted.connectionId !== current.connectionId
        || admitted.attachmentId !== current.attachmentId
        || admitted.attachmentSnapshotSha256
          !== current.attachmentSnapshotSha256
      ) {
        throw new GitHubProviderBindingStoreConflictError(
          "A revoked GitHub project binding must close the exact current authority record",
        );
      }
      assertChronological(current, admitted);
    }

    store.db.query(`
      INSERT INTO github_project_repository_bindings (
        id,
        project_id,
        repository_full_name,
        connection_id,
        attachment_id,
        attachment_snapshot_sha256,
        status,
        accepted_at,
        record_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).run(
      admitted.id,
      admitted.project,
      admitted.repositoryFullName,
      admitted.connectionId,
      admitted.attachmentId,
      admitted.attachmentSnapshotSha256,
      admitted.status,
      admitted.acceptedAt,
      JSON.stringify(admitted),
    );

    const stored = getSqliteGitHubProjectRepositoryBindingById(
      store,
      admitted.id,
    );
    if (!stored) {
      throw new Error("Stored GitHub project repository binding disappeared");
    }
    return stored;
  })();
}

export function getSqliteGitHubProjectRepositoryBinding(
  store: StensiblyStore,
  project: string,
  repositoryFullName: string,
): GitHubProjectRepositoryBinding | null {
  ensureGitHubProviderBindingSchema(store);
  const canonical = admitLookupBinding(project, repositoryFullName);
  const row = store.db
    .query<GitHubProjectRepositoryBindingRow, [string, string]>(`
      SELECT *
      FROM github_project_repository_bindings
      WHERE project_id = ?1 AND repository_full_name = ?2
      ORDER BY sequence DESC
      LIMIT 1
    `)
    .get(canonical.project, canonical.repositoryFullName);
  return row ? mapBinding(row) : null;
}

function getSqliteGitHubProviderConnectionById(
  store: StensiblyStore,
  id: string,
): GitHubProviderConnection | null {
  const row = store.db
    .query<GitHubProviderConnectionRow, [string]>(`
      SELECT *
      FROM github_provider_connections
      WHERE id = ?1
      ORDER BY sequence DESC
      LIMIT 1
    `)
    .get(id);
  return row ? mapConnection(row) : null;
}

function getSqliteGitHubProviderConnectionObservation(
  store: StensiblyStore,
  id: string,
  observedAt: string,
): GitHubProviderConnection | null {
  const row = store.db
    .query<GitHubProviderConnectionRow, [string, string]>(`
      SELECT *
      FROM github_provider_connections
      WHERE id = ?1 AND observed_at = ?2
      LIMIT 1
    `)
    .get(id, observedAt);
  return row ? mapConnection(row) : null;
}

function getSqliteGitHubProviderConnectionByInstallationId(
  store: StensiblyStore,
  installationId: string,
): GitHubProviderConnection | null {
  const row = store.db
    .query<GitHubProviderConnectionRow, [string]>(`
      SELECT *
      FROM github_provider_connections
      WHERE installation_id = ?1
      ORDER BY sequence DESC
      LIMIT 1
    `)
    .get(installationId);
  return row ? mapConnection(row) : null;
}

function requireSqliteProject(store: StensiblyStore, project: string): void {
  const row = store.db
    .query<{ id: string }, [string]>(`
      SELECT id
      FROM projects
      WHERE id = ?1
      LIMIT 1
    `)
    .get(project);
  if (!row) {
    throw new RangeError(`Stensibly project ${project} does not exist`);
  }
}

function getSqliteGitHubProjectRepositoryBindingById(
  store: StensiblyStore,
  id: string,
): GitHubProjectRepositoryBinding | null {
  const row = store.db
    .query<GitHubProjectRepositoryBindingRow, [string]>(`
      SELECT *
      FROM github_project_repository_bindings
      WHERE id = ?1
      LIMIT 1
    `)
    .get(id);
  return row ? mapBinding(row) : null;
}

function assertStableConnectionIdentity(
  current: GitHubProviderConnection,
  next: GitHubProviderConnection,
): void {
  if (
    current.installationId !== next.installationId
    || current.credentialRef !== next.credentialRef
  ) {
    throw new GitHubProviderBindingStoreConflictError(
      `GitHub provider connection ${next.id} changed its installation or credential identity`,
    );
  }
}

function admitRevokedBinding(
  binding: GitHubProjectRepositoryBinding,
  connection: GitHubProviderConnection,
): GitHubProjectRepositoryBinding {
  const admittedConnection = admitGitHubProviderConnection(connection);
  const admittedBinding = admitGitHubProjectRepositoryBinding(binding);
  if (admittedBinding.connectionId !== admittedConnection.id) {
    throw new RangeError("GitHub project binding connection ID does not match connection");
  }
  return admittedBinding;
}

function admitLookupBinding(
  project: string,
  repositoryFullName: string,
): Pick<GitHubProjectRepositoryBinding, "project" | "repositoryFullName"> {
  const sentinel = admitGitHubProjectRepositoryBinding({
    id: "lookup",
    project,
    repositoryFullName,
    connectionId: "lookup",
    attachmentId: "lookup",
    attachmentSnapshotSha256: `sha256:${"0".repeat(64)}`,
    status: "revoked",
    acceptedAt: "1970-01-01T00:00:00.000Z",
  });
  return {
    project: sentinel.project,
    repositoryFullName: sentinel.repositoryFullName,
  };
}

function assertChronological(
  current: GitHubProjectRepositoryBinding | null,
  next: GitHubProjectRepositoryBinding,
): void {
  if (current && next.acceptedAt <= current.acceptedAt) {
    throw new GitHubProviderBindingStoreConflictError(
      "GitHub project binding transition must advance beyond the current record",
    );
  }
}

function mapConnection(
  row: GitHubProviderConnectionRow,
): GitHubProviderConnection {
  const raw = parseStoredJson(row.record_json, `GitHub provider connection ${row.id}`);
  const connection = admitGitHubProviderConnection(raw);
  if (
    connection.id !== row.id
    || connection.installationId !== row.installation_id
    || connection.accountLogin !== row.account_login
    || connection.status !== row.status
    || connection.observedAt !== row.observed_at
    || JSON.stringify(connection) !== row.record_json
  ) {
    throw new Error(
      `Stored GitHub provider connection ${row.id} metadata does not match its admitted record`,
    );
  }
  return connection;
}

function mapBinding(
  row: GitHubProjectRepositoryBindingRow,
): GitHubProjectRepositoryBinding {
  const raw = parseStoredJson(
    row.record_json,
    `GitHub project repository binding ${row.id}`,
  );
  const binding = admitGitHubProjectRepositoryBinding(raw);
  if (
    binding.id !== row.id
    || binding.project !== row.project_id
    || binding.repositoryFullName !== row.repository_full_name
    || binding.connectionId !== row.connection_id
    || binding.attachmentId !== row.attachment_id
    || binding.attachmentSnapshotSha256 !== row.attachment_snapshot_sha256
    || binding.status !== row.status
    || binding.acceptedAt !== row.accepted_at
    || JSON.stringify(binding) !== row.record_json
  ) {
    throw new Error(
      `Stored GitHub project repository binding ${row.id} metadata does not match its admitted record`,
    );
  }
  return binding;
}

function parseStoredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Stored ${label} is not valid JSON`);
  }
}
