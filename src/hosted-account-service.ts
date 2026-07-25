import { convexApi } from "../convex/refs.js";
import type { ConvexCaller } from "./convex-ledger.js";

export type AccountRole = "owner" | "admin" | "member" | "viewer";
export type AccountScope = "read" | "write" | "admin";

export interface OAuthStateRecord {
  id: string;
  returnTo: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface HostedAccountRecord {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  avatarUrl: string | null;
  defaultActorId: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export interface HostedMembershipRecord {
  workspace: string;
  role: AccountRole;
  projects: string[] | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface HostedSessionRecord {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface HostedAccountContext {
  account: HostedAccountRecord;
  identity: {
    provider: string;
    subject: string;
    username: string | null;
    email: string | null;
    emailVerified: boolean;
    avatarUrl: string | null;
    createdAt: string;
    updatedAt: string;
  };
  membership: HostedMembershipRecord;
}

export interface HostedSessionContext {
  session: HostedSessionRecord;
  account: HostedAccountRecord;
  membership: HostedMembershipRecord;
  principal: {
    type: "account";
    accountId: string;
    name: string;
    workspace: string;
    role: AccountRole;
    scopes: AccountScope[];
    projects: string[] | null;
  };
  capabilities: {
    read: boolean;
    write: boolean;
    admin: boolean;
  };
}

export interface HostedAccountService {
  createOAuthState(input: {
    id: string;
    secretHash: string;
    pkceVerifierHash: string;
    returnTo: string;
    expiresAt: number;
  }): Promise<OAuthStateRecord>;
  consumeOAuthState(input: {
    id: string;
    secretHash: string;
    pkceVerifierHash: string;
  }): Promise<OAuthStateRecord | null>;
  upsertProviderIdentity(input: {
    provider: string;
    subject: string;
    username?: string;
    displayName: string;
    email?: string;
    emailVerified: boolean;
    avatarUrl?: string;
    bootstrapRole: AccountRole;
    projects?: string[];
  }): Promise<HostedAccountContext>;
  createSession(input: {
    accountId: string;
    id: string;
    secretHash: string;
    expiresAt: number;
    userAgent?: string;
  }): Promise<HostedSessionRecord>;
  authenticateSession(input: {
    id: string;
    secretHash: string;
    now: number;
  }): Promise<HostedSessionContext | null>;
  touchSession(input: {
    id: string;
    secretHash: string;
  }): Promise<HostedSessionRecord | null>;
  revokeSession(input: {
    accountId: string;
    id: string;
  }): Promise<HostedSessionRecord | null>;
}

export interface ConvexHostedAccountServiceOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace: string;
}

export class ConvexHostedAccountService implements HostedAccountService {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexHostedAccountServiceOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = normalizeWorkspace(options.workspace);
  }

  async createOAuthState(input: {
    id: string;
    secretHash: string;
    pkceVerifierHash: string;
    returnTo: string;
    expiresAt: number;
  }): Promise<OAuthStateRecord> {
    return await this.client.mutation(
      convexApi.oauthStates.create,
      this.args(input),
    ) as OAuthStateRecord;
  }

  async consumeOAuthState(input: {
    id: string;
    secretHash: string;
    pkceVerifierHash: string;
  }): Promise<OAuthStateRecord | null> {
    return await this.client.mutation(
      convexApi.oauthStates.consume,
      this.args(input),
    ) as OAuthStateRecord | null;
  }

  async upsertProviderIdentity(input: {
    provider: string;
    subject: string;
    username?: string;
    displayName: string;
    email?: string;
    emailVerified: boolean;
    avatarUrl?: string;
    bootstrapRole: AccountRole;
    projects?: string[];
  }): Promise<HostedAccountContext> {
    return await this.client.mutation(
      convexApi.accounts.upsertProviderIdentity,
      this.args(input),
    ) as HostedAccountContext;
  }

  async createSession(input: {
    accountId: string;
    id: string;
    secretHash: string;
    expiresAt: number;
    userAgent?: string;
  }): Promise<HostedSessionRecord> {
    return await this.client.mutation(
      convexApi.accounts.createSession,
      this.args(input),
    ) as HostedSessionRecord;
  }

  async authenticateSession(input: {
    id: string;
    secretHash: string;
    now: number;
  }): Promise<HostedSessionContext | null> {
    return await this.client.query(
      convexApi.accounts.authenticateSession,
      this.args(input),
    ) as HostedSessionContext | null;
  }

  async touchSession(input: {
    id: string;
    secretHash: string;
  }): Promise<HostedSessionRecord | null> {
    return await this.client.mutation(
      convexApi.accounts.touchSession,
      this.args(input),
    ) as HostedSessionRecord | null;
  }

  async revokeSession(input: {
    accountId: string;
    id: string;
  }): Promise<HostedSessionRecord | null> {
    return await this.client.mutation(
      convexApi.accounts.revokeSession,
      this.args(input),
    ) as HostedSessionRecord | null;
  }

  private args(input: object): Record<string, unknown> {
    return {
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
      ...input,
    };
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
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
