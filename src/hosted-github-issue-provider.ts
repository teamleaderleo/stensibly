import {
  GitHubAppInstallationTokenMinter,
} from "./github-app-installation-token.js";
import { GitHubIssueProviderService } from "./github-issue-provider-service.js";
import {
  withGitHubIssueProviderReadService,
  withGitHubIssueProviderWriteService,
  type GitHubIssueProviderReadService,
  type GitHubIssueProviderWriteService,
} from "./github-issue-provider-mcp.js";
import {
  evaluateGitHubOutboundText,
  type GitHubOutboundTextField,
} from "./github-outbound-text-policy.js";
import type {
  GitHubIssueProviderOperation,
  GitHubProjectRepositoryBinding,
  GitHubProviderAuthority,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
  GitHubProviderReceipt,
  GitHubProviderReceiptReservation,
  GitHubProviderReceiptStore,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import {
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import { GitHubRestIssueProviderAdapter } from "./github-rest-issue-adapter.js";
import type { WorkLedger } from "./ledger.js";
import {
  projectAttachmentLedger,
  type ProjectAttachmentLedger,
} from "./project-attachment-ledger.js";

export interface HostedGitHubIssueProviderOverrides {
  fetch?: typeof fetch;
  now?: () => number;
}

interface HostedGitHubIssueProviderConfig {
  workspace: string;
  project: string;
  repositoryFullName: string;
  appId: string;
  installationId: string;
  accountLogin: string;
  privateKeyPem: string;
  apiBaseUrl: string;
  credentialRef: string;
  issueWritesEnabled: boolean;
  writeGrantId: string | null;
  writeApprovalId: string | null;
  authorityGeneration: number;
}

const readOperations = new Set<GitHubIssueProviderOperation>([
  "github_list_issues",
  "github_search_issues",
  "github_get_issue",
]);
const mountedWriteOperations = new Set<GitHubIssueProviderOperation>([
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_comment",
]);

/**
 * Mounts the production issue provider only when the full GitHub App
 * configuration exists. Reads are mounted with the base configuration.
 * Writes additionally require the exact write flag, durable receipt store,
 * project contract, grant identity, and any required approval identity.
 */
export function mountHostedGitHubIssueProviderFromEnv<T extends WorkLedger>(
  ledger: T,
  env: Record<string, string | undefined>,
  overrides: HostedGitHubIssueProviderOverrides = {},
): T & Partial<GitHubIssueProviderReadService & GitHubIssueProviderWriteService> {
  const config = hostedGitHubIssueProviderConfig(env);
  if (!config) return ledger;
  const projects = projectAttachmentLedger(ledger);
  if (!projects) {
    throw new Error(
      "Hosted GitHub issue provider requires a project-attachment ledger",
    );
  }
  const receipts = config.issueWritesEnabled
    ? requiredReceiptStore(ledger)
    : new ReadOnlyGitHubProviderReceiptStore();
  const now = overrides.now ?? Date.now;
  const bindings = new AcceptedAttachmentGitHubBindingStore(
    projects,
    config,
    now,
  );
  const tokens = new GitHubAppInstallationTokenMinter({
    appId: config.appId,
    installationId: config.installationId,
    accountLogin: config.accountLogin,
    privateKeyPem: config.privateKeyPem,
    repositoryFullNames: [config.repositoryFullName],
    apiBaseUrl: config.apiBaseUrl,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    now,
  });
  const adapter = new GitHubRestIssueProviderAdapter({
    tokenProvider: tokens,
    apiBaseUrl: config.apiBaseUrl,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  });
  const provider = new GitHubIssueProviderService({
    projects,
    bindings,
    authority: new HostedGitHubAuthority(projects, config),
    adapter,
    receipts,
    now: () => new Date(now()).toISOString(),
  });
  const reads = canonicalHostedReadService(provider);
  const mountedReads = withGitHubIssueProviderReadService(ledger, reads);
  if (!config.issueWritesEnabled) return mountedReads;
  const writes = canonicalHostedWriteService(provider, config);
  return withGitHubIssueProviderWriteService(mountedReads, writes);
}

export function hostedGitHubIssueProviderConfigured(
  env: Record<string, string | undefined>,
): boolean {
  return hostedGitHubIssueProviderConfig(env) !== null;
}

function hostedGitHubIssueProviderConfig(
  env: Record<string, string | undefined>,
): HostedGitHubIssueProviderConfig | null {
  const keys = [
    "STENSIBLY_GITHUB_APP_ID",
    "STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    "STENSIBLY_GITHUB_INSTALLATION_ID",
    "STENSIBLY_GITHUB_PROVIDER_PROJECT",
    "STENSIBLY_GITHUB_PROVIDER_REPOSITORY",
    "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
    "STENSIBLY_GITHUB_API_BASE_URL",
    "STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED",
    "STENSIBLY_GITHUB_PROVIDER_WRITE_GRANT_ID",
    "STENSIBLY_GITHUB_PROVIDER_WRITE_APPROVAL_ID",
    "STENSIBLY_GITHUB_PROVIDER_WRITE_AUTHORITY_GENERATION",
  ] as const;
  const configured = keys.some((key) => Boolean(trimmed(env[key])));
  if (!configured) return null;

  const appId = requiredEnv(env, "STENSIBLY_GITHUB_APP_ID");
  const privateKeyPem = requiredEnv(
    env,
    "STENSIBLY_GITHUB_APP_PRIVATE_KEY",
  );
  const installationId = requiredEnv(
    env,
    "STENSIBLY_GITHUB_INSTALLATION_ID",
  );
  const project = hostedProjectSlug(
    requiredEnv(env, "STENSIBLY_GITHUB_PROVIDER_PROJECT", false),
  );
  const repositoryFullName = normalizeGitHubRepository(
    exactAuthorityEnv(env, "STENSIBLY_GITHUB_PROVIDER_REPOSITORY"),
  ).toLowerCase();
  const accountLogin = exactAuthorityEnv(
    env,
    "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
  ).toLowerCase();
  const apiBaseUrl = trimmed(env.STENSIBLY_GITHUB_API_BASE_URL)
    ?? "https://api.github.com";
  const issueWritesEnabled = exactBooleanFlag(
    env.STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED,
    "STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED",
  );
  const writeGrantId = issueWritesEnabled
    ? exactAuthorityIdentity(
      requiredEnv(env, "STENSIBLY_GITHUB_PROVIDER_WRITE_GRANT_ID", false),
      "STENSIBLY_GITHUB_PROVIDER_WRITE_GRANT_ID",
    )
    : absentAuthorityEnv(env, "STENSIBLY_GITHUB_PROVIDER_WRITE_GRANT_ID");
  const writeApprovalId = optionalAuthorityIdentity(
    env.STENSIBLY_GITHUB_PROVIDER_WRITE_APPROVAL_ID,
    "STENSIBLY_GITHUB_PROVIDER_WRITE_APPROVAL_ID",
  );
  const authorityGeneration = issueWritesEnabled
    ? positiveAuthorityGeneration(
      requiredEnv(
        env,
        "STENSIBLY_GITHUB_PROVIDER_WRITE_AUTHORITY_GENERATION",
        false,
      ),
    )
    : absentAuthorityGeneration(
      env.STENSIBLY_GITHUB_PROVIDER_WRITE_AUTHORITY_GENERATION,
    );
  if (!issueWritesEnabled && writeApprovalId !== null) {
    throw new Error(
      "Hosted GitHub issue write approval identity requires writes to be enabled",
    );
  }
  return {
    workspace: hostedProjectSlug(env.STENSIBLY_WORKSPACE ?? "default"),
    project,
    repositoryFullName,
    appId,
    installationId,
    accountLogin,
    privateKeyPem,
    apiBaseUrl,
    credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    issueWritesEnabled,
    writeGrantId,
    writeApprovalId,
    authorityGeneration,
  };
}

class AcceptedAttachmentGitHubBindingStore implements GitHubProviderBindingStore {
  readonly #projects: ProjectAttachmentLedger;
  readonly #config: HostedGitHubIssueProviderConfig;
  readonly #connection: GitHubProviderConnection;

  constructor(
    projects: ProjectAttachmentLedger,
    config: HostedGitHubIssueProviderConfig,
    now: () => number,
  ) {
    this.#projects = projects;
    this.#config = config;
    this.#connection = Object.freeze({
      id: `ghconn_installation_${config.installationId}`,
      provider: "github",
      installationId: config.installationId,
      accountLogin: config.accountLogin,
      credentialRef: config.credentialRef,
      status: "active",
      repositoryFullNames: [config.repositoryFullName],
      observedAt: new Date(now()).toISOString(),
    });
  }

  async getGitHubProjectRepositoryBinding(
    project: string,
    repositoryFullName: string,
  ): Promise<GitHubProjectRepositoryBinding | null> {
    if (
      project !== this.#config.project
      || normalizeGitHubRepository(repositoryFullName).toLowerCase()
        !== this.#config.repositoryFullName
    ) return null;
    const attachment = await this.#projects.getProjectAttachment(project);
    if (!attachment) return null;
    const digest = sha256(stableJson({
      project,
      repositoryFullName: this.#config.repositoryFullName,
      connectionId: this.#connection.id,
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    }));
    return Object.freeze({
      id: `ghbind_${digest.slice("sha256:".length, "sha256:".length + 24)}`,
      project,
      repositoryFullName: this.#config.repositoryFullName,
      connectionId: this.#connection.id,
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      status: "active",
      acceptedAt: attachment.acceptedAt,
    });
  }

  async getGitHubProviderConnection(
    id: string,
  ): Promise<GitHubProviderConnection | null> {
    return id === this.#connection.id ? this.#connection : null;
  }
}

class HostedGitHubAuthority implements GitHubProviderAuthority {
  readonly #projects: ProjectAttachmentLedger;
  readonly #config: HostedGitHubIssueProviderConfig;

  constructor(
    projects: ProjectAttachmentLedger,
    config: HostedGitHubIssueProviderConfig,
  ) {
    this.#projects = projects;
    this.#config = config;
  }

  async authorizeGitHubOperation(input: {
    project: string;
    repositoryFullName: string;
    operation: GitHubIssueProviderOperation;
    actorId: string;
    clientId: string;
    capabilityGrantId?: string;
    approvalId?: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    if (
      input.project !== this.#config.project
      || normalizeGitHubRepository(input.repositoryFullName).toLowerCase()
        !== this.#config.repositoryFullName
    ) {
      return {
        allowed: false,
        reason: "GitHub operation is outside the configured hosted provider binding",
      };
    }
    if (readOperations.has(input.operation)) return { allowed: true };
    if (!mountedWriteOperations.has(input.operation)) {
      return {
        allowed: false,
        reason: "Hosted GitHub provider operation is outside the mounted issue-write set",
      };
    }
    if (!this.#config.issueWritesEnabled) {
      return {
        allowed: false,
        reason: "Hosted GitHub issue writes are disabled",
      };
    }
    if (input.capabilityGrantId !== this.#config.writeGrantId) {
      return {
        allowed: false,
        reason: "Hosted GitHub issue write requires the active capability grant",
      };
    }
    const attachment = await this.#projects.getProjectAttachment(input.project);
    if (!attachment) {
      return {
        allowed: false,
        reason: "Hosted GitHub issue write requires an accepted project attachment",
      };
    }
    const approvalRequired = attachment.snapshot.contract.approvalRequired
      .includes("write");
    const autonomous = attachment.snapshot.contract.autonomousActions
      .includes("write");
    if (approvalRequired) {
      if (
        this.#config.writeApprovalId === null
        || input.approvalId !== this.#config.writeApprovalId
      ) {
        return {
          allowed: false,
          reason: "Hosted GitHub issue write requires the active approval identity",
        };
      }
    } else if (!autonomous) {
      return {
        allowed: false,
        reason: "Accepted project policy does not authorize autonomous GitHub writes",
      };
    } else if (
      input.approvalId !== undefined
      && input.approvalId !== this.#config.writeApprovalId
    ) {
      return {
        allowed: false,
        reason: "Hosted GitHub issue write approval identity is not current",
      };
    }
    return { allowed: true };
  }
}

class ReadOnlyGitHubProviderReceiptStore implements GitHubProviderReceiptStore {
  async reserveGitHubProviderReceipt(
    _receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceiptReservation> {
    throw new Error(
      "GitHub provider writes require the durable hosted receipt store",
    );
  }

  async updateGitHubProviderReceipt(
    _receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceipt> {
    throw new Error(
      "GitHub provider writes require the durable hosted receipt store",
    );
  }

  async getGitHubProviderReceipt(
    _project: string,
    _idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null> {
    return null;
  }
}

function canonicalHostedReadService(
  service: GitHubIssueProviderReadService,
): GitHubIssueProviderReadService {
  return {
    listIssues: (input) => service.listIssues(canonicalRequest(input)),
    searchIssues: (input) => service.searchIssues(canonicalRequest(input)),
    getIssue: (input) => service.getIssue(canonicalRequest(input)),
  };
}

function canonicalHostedWriteService(
  service: GitHubIssueProviderWriteService,
  config: HostedGitHubIssueProviderConfig,
): GitHubIssueProviderWriteService {
  return {
    createIssue: async (input) => {
      preflightWrite(config, "github_create_issue", input.idempotencyKey, [
        { name: "title", text: input.title },
        { name: "body", text: input.body ?? "" },
      ], "issue");
      return await service.createIssue(canonicalRequest(input));
    },
    updateIssue: async (input) => {
      preflightWrite(config, "github_update_issue", input.idempotencyKey, [
        { name: "title", text: input.title ?? "" },
        { name: "body", text: input.body ?? "" },
      ], "issue");
      return await service.updateIssue(canonicalRequest(input));
    },
    addIssueComment: async (input) => {
      preflightWrite(config, "github_add_issue_comment", input.idempotencyKey, [
        { name: "body", text: input.body },
      ], "comment");
      return await service.addIssueComment(canonicalRequest(input));
    },
  };
}

function preflightWrite(
  config: HostedGitHubIssueProviderConfig,
  operation: "github_create_issue" | "github_update_issue" | "github_add_issue_comment",
  idempotencyKey: string,
  fields: GitHubOutboundTextField[],
  surface: "issue" | "comment",
): void {
  const [owner, repository] = config.repositoryFullName.split("/") as [
    string,
    string,
  ];
  const receipt = evaluateGitHubOutboundText({
    workspace: config.workspace,
    project: config.project,
    destination: { owner, repository },
    surface,
    operationRef: `${operation}:${fingerprintCanonicalRequest({ idempotencyKey })}`,
    authorityGeneration: config.authorityGeneration,
    fields,
    policy: {
      version: 1,
      controlledOwners: [owner],
      controlledRepositories: [config.repositoryFullName],
    },
    externalContactAuthority: null,
  });
  if (receipt.decision === "reject") {
    throw new GitHubOutboundTextRejectedError(
      receipt.referenceCounts.rejected,
      receipt.receiptFingerprint,
    );
  }
}

export class GitHubOutboundTextRejectedError extends Error {
  readonly code = "github_outbound_text_rejected";
  readonly rejectedReferenceCount: number;
  readonly receiptFingerprint: string;

  constructor(rejectedReferenceCount: number, receiptFingerprint: string) {
    super(
      `GitHub outbound text contains ${rejectedReferenceCount} external repository reference(s) outside the controlled destination`,
    );
    this.name = "GitHubOutboundTextRejectedError";
    this.rejectedReferenceCount = rejectedReferenceCount;
    this.receiptFingerprint = receiptFingerprint;
  }
}

function canonicalRequest<T extends GitHubProviderRequestContext>(input: T): T {
  return {
    ...input,
    repository: normalizeGitHubRepository(input.repository).toLowerCase(),
  };
}

function requiredReceiptStore(value: unknown): GitHubProviderReceiptStore {
  if (!value || typeof value !== "object") {
    throw new Error(
      "Hosted GitHub issue writes require the durable provider receipt store",
    );
  }
  const candidate = value as Partial<GitHubProviderReceiptStore>;
  if (
    typeof candidate.reserveGitHubProviderReceipt !== "function"
    || typeof candidate.updateGitHubProviderReceipt !== "function"
    || typeof candidate.getGitHubProviderReceipt !== "function"
  ) {
    throw new Error(
      "Hosted GitHub issue writes require the durable provider receipt store",
    );
  }
  return candidate as GitHubProviderReceiptStore;
}

function hostedProjectSlug(value: string): string {
  if (
    !value
    || value.length > 80
    || !/^[\x20-\x7e]+$/.test(value)
    || value !== value.trim()
    || !/^[a-z0-9][a-z0-9_-]*$/.test(value)
  ) {
    throw new RangeError("Use an exact lowercase project slug");
  }
  return value;
}

function exactBooleanFlag(
  raw: string | undefined,
  key: string,
): boolean {
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`${key} must be exactly true, false, or absent`);
}

function exactAuthorityIdentity(value: string, key: string): string {
  if (
    value.length > 240
    || value !== value.trim()
    || !/^[A-Za-z0-9._:/@#-]+$/.test(value)
  ) {
    throw new Error(`Hosted GitHub issue provider requires an exact ${key}`);
  }
  return value;
}

function optionalAuthorityIdentity(
  value: string | undefined,
  key: string,
): string | null {
  if (value === undefined || value === "") return null;
  return exactAuthorityIdentity(value, key);
}

function absentAuthorityEnv(
  env: Record<string, string | undefined>,
  key: string,
): null {
  if (env[key] !== undefined && env[key] !== "") {
    throw new Error(`${key} requires hosted GitHub issue writes to be enabled`);
  }
  return null;
}

function positiveAuthorityGeneration(value: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new Error(
      "STENSIBLY_GITHUB_PROVIDER_WRITE_AUTHORITY_GENERATION must be a positive integer",
    );
  }
  return Number(value);
}

function absentAuthorityGeneration(value: string | undefined): number {
  if (value !== undefined && value !== "") {
    throw new Error(
      "STENSIBLY_GITHUB_PROVIDER_WRITE_AUTHORITY_GENERATION requires hosted GitHub issue writes to be enabled",
    );
  }
  return 1;
}

function exactAuthorityEnv(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = requiredEnv(env, key, false);
  if (
    value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new Error(`Hosted GitHub issue provider requires exact printable ASCII ${key}`);
  }
  return value;
}

function requiredEnv(
  env: Record<string, string | undefined>,
  key: string,
  trim = true,
): string {
  const raw = env[key];
  const value = trim ? trimmed(raw) : raw;
  if (!value) {
    throw new Error(`Hosted GitHub issue provider requires ${key}`);
  }
  return value;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
