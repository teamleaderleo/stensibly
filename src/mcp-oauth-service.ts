import { convexApi } from "../convex/refs.js";
import type { ConvexCaller } from "./convex-ledger.js";
import type { AccountRole, AccountScope } from "./hosted-account-service.js";

export type McpOAuthScope = "read" | "write" | "offline_access";

export interface McpOAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: string[];
  responseTypes: string[];
  createdAt: string;
}

export interface McpOAuthGrant {
  clientId: string;
  resource: string;
  scopes: McpOAuthScope[];
  principal: {
    accountId: string;
    name: string;
    workspace: string;
    role: AccountRole;
    scopes: AccountScope[];
    projects: string[] | null;
  };
}

export type McpOAuthRefreshExchange =
  | { status: "ok"; grant: McpOAuthGrant }
  | { status: "invalid" }
  | { status: "replayed" };

export interface McpOAuthService {
  registerClient(input: {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: "none";
    grantTypes: string[];
    responseTypes: string[];
  }): Promise<McpOAuthClientRecord>;
  getClient(clientId: string): Promise<McpOAuthClientRecord | null>;
  createAuthorizationCode(input: {
    accountId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: McpOAuthScope[];
    resource: string;
    id: string;
    secretHash: string;
    expiresAt: number;
  }): Promise<McpOAuthGrant>;
  exchangeAuthorizationCode(input: {
    id: string;
    secretHash: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    refreshId: string;
    refreshSecretHash: string;
    refreshExpiresAt: number;
  }): Promise<McpOAuthGrant | null>;
  rotateRefreshToken(input: {
    id: string;
    secretHash: string;
    clientId: string;
    nextId: string;
    nextSecretHash: string;
    nextExpiresAt: number;
  }): Promise<McpOAuthRefreshExchange>;
}

export interface ConvexMcpOAuthServiceOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace: string;
}

export class ConvexMcpOAuthService implements McpOAuthService {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexMcpOAuthServiceOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = normalizeWorkspace(options.workspace);
  }

  async registerClient(input: Parameters<McpOAuthService["registerClient"]>[0]) {
    return await this.client.mutation(
      convexApi.mcpOAuth.registerClient,
      this.args(input),
    ) as McpOAuthClientRecord;
  }

  async getClient(clientId: string) {
    return await this.client.query(
      convexApi.mcpOAuth.getClient,
      this.args({ clientId }),
    ) as McpOAuthClientRecord | null;
  }

  async createAuthorizationCode(input: Parameters<McpOAuthService["createAuthorizationCode"]>[0]) {
    return await this.client.mutation(
      convexApi.mcpOAuth.createAuthorizationCode,
      this.args(input),
    ) as McpOAuthGrant;
  }

  async exchangeAuthorizationCode(input: Parameters<McpOAuthService["exchangeAuthorizationCode"]>[0]) {
    return await this.client.mutation(
      convexApi.mcpOAuth.exchangeAuthorizationCode,
      this.args(input),
    ) as McpOAuthGrant | null;
  }

  async rotateRefreshToken(input: Parameters<McpOAuthService["rotateRefreshToken"]>[0]) {
    return await this.client.mutation(
      convexApi.mcpOAuth.rotateRefreshToken,
      this.args(input),
    ) as McpOAuthRefreshExchange;
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
