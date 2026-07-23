import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { FunctionReference } from "convex/server";
import { convexApi } from "../convex/refs.ts";
import {
  authenticateApiToken,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type CreatedToken,
  type TokenPrincipal,
  type TokenRecord,
  type TokenScope,
} from "./auth.ts";
import type { ConvexCaller } from "./convex-ledger.ts";
import { StensiblyStore } from "./store.ts";

export interface CreateTokenInput {
  name: string;
  scopes: TokenScope[];
  projects?: string[] | null;
}

export interface ApiTokenAuthenticator {
  authenticate(rawToken: string): Promise<TokenPrincipal | null>;
}

export interface ApiTokenManager extends ApiTokenAuthenticator {
  create(input: CreateTokenInput): Promise<CreatedToken>;
  list(): Promise<TokenRecord[]>;
  revoke(id: string): Promise<TokenRecord>;
}

export class SqliteTokenProvider implements ApiTokenManager {
  constructor(readonly store: StensiblyStore) {}

  async authenticate(rawToken: string) {
    return authenticateApiToken(this.store, rawToken);
  }

  async create(input: CreateTokenInput) {
    return createApiToken(this.store, input);
  }

  async list() {
    return listApiTokens(this.store);
  }

  async revoke(id: string) {
    return revokeApiToken(this.store, id);
  }
}

export interface ConvexTokenProviderOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class ConvexTokenProvider implements ApiTokenManager {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexTokenProviderOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = normalizeWorkspace(options.workspace ?? "default");
  }

  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    const parsed = parseToken(rawToken);
    if (!parsed) return null;
    return await this.client.query(
      convexApi.tokens.authenticate as FunctionReference<"query">,
      this.args({ id: parsed.id, secretHash: hashSecret(parsed.secret) }),
    ) as TokenPrincipal | null;
  }

  async create(input: CreateTokenInput): Promise<CreatedToken> {
    const name = input.name.trim();
    if (!name || name.length > 160) {
      throw new RangeError("Token name must be between 1 and 160 characters");
    }
    const scopes = normalizeScopes(input.scopes);
    const projects = normalizeProjects(input.projects);
    const id = `tok_${randomUUID().replaceAll("-", "")}`;
    const secret = randomBytes(32).toString("base64url");
    const token = `stn.${id}.${secret}`;
    const record = await this.client.mutation(
      convexApi.tokens.register as FunctionReference<"mutation">,
      this.args({
        id,
        name,
        secretHash: hashSecret(secret),
        scopes,
        ...(projects === null ? {} : { projects }),
      }),
    ) as TokenRecord;
    return { ...record, token };
  }

  async list(): Promise<TokenRecord[]> {
    return await this.client.query(
      convexApi.tokens.list as FunctionReference<"query">,
      this.args({}),
    ) as TokenRecord[];
  }

  async revoke(id: string): Promise<TokenRecord> {
    return await this.client.mutation(
      convexApi.tokens.revoke as FunctionReference<"mutation">,
      this.args({ id }),
    ) as TokenRecord;
  }

  private args(input: object): Record<string, unknown> {
    return {
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
      ...input,
    };
  }
}

export function parseToken(rawToken: string): { id: string; secret: string } | null {
  const match = /^stn\.(tok_[a-f0-9]{32})\.([A-Za-z0-9_-]{40,})$/.exec(rawToken.trim());
  if (!match?.[1] || !match[2]) return null;
  return { id: match[1], secret: match[2] };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function normalizeScopes(scopes: TokenScope[]): TokenScope[] {
  const unique = new Set(scopes);
  if (unique.size === 0) throw new RangeError("Token requires at least one scope");
  return (["read", "write", "admin"] as const).filter((scope) => unique.has(scope));
}

function normalizeProjects(projects: string[] | null | undefined): string[] | null {
  if (projects === null || projects === undefined) return null;
  const unique = new Set<string>();
  for (const raw of projects) {
    const project = raw.trim();
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(project)) {
      throw new RangeError(`Invalid project slug: ${raw}`);
    }
    unique.add(project);
  }
  return [...unique].sort();
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeWorkspace(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(normalized) || normalized.length > 80) {
    throw new Error("Workspace must be a lowercase slug up to 80 characters");
  }
  return normalized;
}
