import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { StensiblyStore } from "./store.js";
import {
  tokenScopes,
  type AuthorizationPrincipal,
  type CreatedToken,
  type TokenPrincipal,
  type TokenRecord,
  type TokenScope,
  type RunnerCredentialGrantV1,
  normalizeRunnerCredentialGrant,
} from "./token-contracts.js";

export { tokenScopes } from "./token-contracts.js";
export type {
  AuthorizationPrincipal,
  CreatedToken,
  TokenPrincipal,
  TokenRecord,
  TokenScope,
} from "./token-contracts.js";

interface TokenRow {
  id: string;
  name: string;
  secret_hash: string;
  scopes_json: string;
  projects_json: string | null;
  created_at: string;
  revoked_at: string | null;
  runner_grant_json: string | null;
}

export function createApiToken(
  store: StensiblyStore,
  input: {
    name: string;
    scopes: TokenScope[];
    projects?: string[] | null;
    runnerGrant?: RunnerCredentialGrantV1;
  },
): CreatedToken {
  ensureAuthSchema(store);
  const name = input.name.trim();
  if (!name || name.length > 160) {
    throw new RangeError("Token name must be between 1 and 160 characters");
  }

  const scopes = normalizeScopes(input.scopes);
  if (scopes.length === 0) throw new RangeError("Token requires at least one scope");
  const projects = normalizeProjects(input.projects);
  const runnerGrant = normalizeRunnerCredentialGrant(input.runnerGrant);
  if (runnerGrant && (projects === null || projects.length !== 1)) {
    throw new RangeError("Runner credential requires exactly one project");
  }
  if (runnerGrant && (scopes.length !== 1 || scopes[0] !== "write")) {
    throw new RangeError("Runner credential scope must be exactly write");
  }
  const id = `tok_${randomUUID().replaceAll("-", "")}`;
  const secret = randomBytes(32).toString("base64url");
  const token = `stn.${id}.${secret}`;
  const now = new Date().toISOString();

  store.db
    .query(`
      INSERT INTO api_tokens (
        id, name, secret_hash, scopes_json, projects_json, runner_grant_json, created_at, revoked_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
    `)
    .run(
      id,
      name,
      hashSecret(secret),
      JSON.stringify(scopes),
      projects === null ? null : JSON.stringify(projects),
      runnerGrant === undefined ? null : JSON.stringify(runnerGrant),
      now,
    );

  return {
    id,
    name,
    token,
    scopes,
    projects,
    ...(runnerGrant ? { runnerGrant } : {}),
    createdAt: now,
    revokedAt: null,
  };
}

export function authenticateApiToken(
  store: StensiblyStore,
  rawToken: string,
): TokenPrincipal | null {
  ensureAuthSchema(store);
  const parsed = parseToken(rawToken);
  if (!parsed) return null;

  const row = store.db
    .query<TokenRow, [string]>("SELECT * FROM api_tokens WHERE id = ?1")
    .get(parsed.id);
  if (!row || row.revoked_at) return null;

  const actual = Buffer.from(hashSecret(parsed.secret), "hex");
  const expected = Buffer.from(row.secret_hash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  return {
    tokenId: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes_json),
    projects: parseProjects(row.projects_json),
    ...parseRunnerGrant(row.runner_grant_json),
  };
}

export function listApiTokens(store: StensiblyStore): TokenRecord[] {
  ensureAuthSchema(store);
  return store.db
    .query<TokenRow, []>(`
      SELECT *
      FROM api_tokens
      ORDER BY created_at DESC, id DESC
    `)
    .all()
    .map(mapTokenRecord);
}

export function revokeApiToken(store: StensiblyStore, id: string): TokenRecord {
  ensureAuthSchema(store);
  const now = new Date().toISOString();
  const result = store.db
    .query(`
      UPDATE api_tokens
      SET revoked_at = COALESCE(revoked_at, ?1)
      WHERE id = ?2
    `)
    .run(now, id);
  if (result.changes !== 1) throw new Error(`Token ${id} does not exist`);

  const row = store.db
    .query<TokenRow, [string]>("SELECT * FROM api_tokens WHERE id = ?1")
    .get(id);
  if (!row) throw new Error(`Token ${id} does not exist`);
  return mapTokenRecord(row);
}

export function principalHasScope(
  principal: AuthorizationPrincipal,
  required: "read" | "write",
): boolean {
  return principal.scopes.includes("admin") || principal.scopes.includes(required);
}

export function principalCanAccessProject(
  principal: AuthorizationPrincipal,
  project: string,
): boolean {
  return principal.projects === null || principal.projects.includes(project);
}

export function filterItemsForPrincipal<
  T extends { project: string },
>(principal: AuthorizationPrincipal, items: T[]): T[] {
  if (principal.projects === null) return items;
  const allowed = new Set(principal.projects);
  return items.filter((item) => allowed.has(item.project));
}

export function ensureAuthSchema(store: StensiblyStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      projects_json TEXT,
      runner_grant_json TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_api_tokens_revoked
      ON api_tokens(revoked_at, created_at DESC);
  `);
  const columns = new Set(store.db
    .query<{ name: string }, []>("PRAGMA table_info(api_tokens)")
    .all()
    .map((column) => column.name));
  if (!columns.has("runner_grant_json")) {
    store.db.exec("ALTER TABLE api_tokens ADD COLUMN runner_grant_json TEXT");
  }
}

function normalizeScopes(scopes: TokenScope[]): TokenScope[] {
  const unique = new Set<TokenScope>();
  for (const scope of scopes) {
    if (!tokenScopes.includes(scope)) throw new RangeError(`Unknown token scope: ${scope}`);
    unique.add(scope);
  }
  return tokenScopes.filter((scope) => unique.has(scope));
}

function normalizeProjects(projects: string[] | null | undefined): string[] | null {
  if (projects === null || projects === undefined) return null;
  const unique = new Set<string>();
  for (const rawProject of projects) {
    const project = rawProject.trim();
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(project)) {
      throw new RangeError(`Invalid project slug: ${rawProject}`);
    }
    unique.add(project);
  }
  return [...unique].sort();
}

function parseToken(rawToken: string): { id: string; secret: string } | null {
  const match = /^stn\.(tok_[a-f0-9]{32})\.([A-Za-z0-9_-]{40,})$/.exec(rawToken.trim());
  if (!match?.[1] || !match[2]) return null;
  return { id: match[1], secret: match[2] };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function parseScopes(value: string): TokenScope[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((scope): scope is TokenScope =>
    typeof scope === "string" && tokenScopes.includes(scope as TokenScope),
  );
}

function parseProjects(value: string | null): string[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((project): project is string => typeof project === "string");
}

function parseRunnerGrant(value: string | null): { runnerGrant?: RunnerCredentialGrantV1 } {
  if (value === null) return {};
  const parsed = JSON.parse(value) as RunnerCredentialGrantV1;
  const runnerGrant = normalizeRunnerCredentialGrant(parsed);
  if (!runnerGrant) throw new Error("Stored runner credential grant is invalid");
  return { runnerGrant };
}

function mapTokenRecord(row: TokenRow): TokenRecord {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes_json),
    projects: parseProjects(row.projects_json),
    ...parseRunnerGrant(row.runner_grant_json),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
