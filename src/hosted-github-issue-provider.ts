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
import { GitHubRestIssueProviderAdapter } from "./github-rest-issue-adapter.js";
import { GitHubRestIssueWriteAdapter } from "./github-rest-issue-write-adapter.js";
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
  project: string;
  repositoryFullName: string;
  appId: string;
  installationId: string;
  accountLogin: string;
  privateKeyPem: string;
  apiBaseUrl: string;
  credentialRef: string;
  issueWritesEnabled: boolean;
}

const readOperations = new Set<GitHubIssueProviderOperation>([
  "github_list_issues",
  "github_search_issues",
  "github_get_issue",
]);
const initialWriteOperations = new Set<GitHubIssueProviderOperation>([
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_comment",
]);

/**
 * Mounts the production read provider when the complete GitHub App
 * configuration exists. A separate exact flag mounts the initial write service
 * only when the ledger also exposes the durable hosted receipt contract.
 */
export function mountHostedGitHubIssueProviderFromEnv<T extends WorkLedger>(
  ledger: T,
  env: Record<string, string | undefined>,
  overrides: HostedGitHubIssueProviderOverrides = {},
): T
  & Partial<GitHubIssueProviderReadService>
  & Partial<GitHubIssueProviderWriteService> {
  const config = hostedGitHubIssueProviderConfig(env);
  if (!config) return ledger;
  const projects = projectAttachmentLedger(ledger);
  if (!projects) {
    throw new Error(
      "Hosted GitHub issue provider requires a project-attachment ledger",
    );
  }
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
  const adapterOptions = {
    tokenProvider: tokens,
    apiBaseUrl: config.apiBaseUrl,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  };
  const adapter = config.issueWritesEnabled
    ? new GitHubRestIssueWriteAdapter(adapterOptions)
    : new GitHubRestIssueProviderAdapter(adapterOptions);
  const receipts = config.issueWritesEnabled
    ? durableReceiptStore(ledger)
    : new ReadOnlyGitHubProviderReceiptStore();
  const service = new GitHubIssueProviderService({
    projects,
    bindings,
    authority: new HostedGitHubAuthority(config),
    adapter,
    receipts,
    now: () => new Date(now()).toISOString(),
  });
  const mountedReads = withGitHubIssueProviderReadService(
    ledger,
    canonicalHostedReadService(service),
  );
  if (!config.issueWritesEnabled) return mountedReads;
  return withGitHubIssueProviderWriteService(
    mountedReads,
    canonicalHostedWriteService(service),
  );
}

export function hostedGitHubIssueProviderConfigured(
  env: Record<string, string | undefined>,
): boolean {
  return hostedGitHubIssueProviderConfig(env) !== null;
}

function hostedGitHubIssueProviderConfig(
  env: Record<string, string | undefined>,
): HostedGitHubIssueProviderConfig | null {
  const issueWritesEnabled = optionalBooleanEnv(
    env,
    "STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED",
  );
  const keys = [
    "STENSIBLY_GITHUB_APP_ID",
    "STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    "STENSIBLY_GITHUB_INSTALLATION_ID",
    "STENSIBLY_GITHUB_PROVIDER_PROJECT",
    "STENSIBLY_GITHUB_PROVIDER_REPOSITORY",
    "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
    "STENSIBLY_GITHUB_API_BASE_URL",
  ] as const;
  const configured = issueWritesEnabled
    || keys.some((key) => Boolean(trimmed(env[key])));
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
  return {
    project,
    repositoryFullName,
    appId,
    installationId,
    accountLogin,
    privateKeyPem,
    apiBaseUrl,
    credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    issueWritesEnabled,
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
  readonly #config: HostedGitHubIssueProviderConfig;

  constructor(config: HostedGitHubIssueProviderConfig) {
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
    if (
      this.#config.issueWritesEnabled
      && initialWriteOperations.has(input.operation)
    ) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: this.#config.issueWritesEnabled
        ? "Hosted GitHub label and assignee writes remain unavailable"
        : "Hosted GitHub provider currently authorizes typed issue reads only",
    };
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

function durableReceiptStore(value: unknown): GitHubProviderReceiptStore {
  const reserve = captureMethod(value, "reserveGitHubProviderReceipt");
  const update = captureMethod(value, "updateGitHubProviderReceipt");
  const get = captureMethod(value, "getGitHubProviderReceipt");
  if (!reserve || !update || !get) {
    throw new Error(
      "Hosted GitHub issue writes require the durable provider receipt store",
    );
  }
  return Object.freeze({
    reserveGitHubProviderReceipt: reserve as GitHubProviderReceiptStore["reserveGitHubProviderReceipt"],
    updateGitHubProviderReceipt: update as GitHubProviderReceiptStore["updateGitHubProviderReceipt"],
    getGitHubProviderReceipt: get as GitHubProviderReceiptStore["getGitHubProviderReceipt"],
  });
}

function captureMethod(
  value: unknown,
  name: string,
): ((...args: unknown[]) => unknown) | null {
  if (!value || typeof value !== "object") return null;
  let current: object | null = value;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        return null;
      }
      return (...args: unknown[]) => Reflect.apply(descriptor.value, value, args);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return null;
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
): GitHubIssueProviderWriteService {
  return {
    createIssue: (input) => service.createIssue(canonicalRequest(input)),
    updateIssue: (input) => service.updateIssue(canonicalRequest(input)),
    addIssueComment: (input) => service.addIssueComment(canonicalRequest(input)),
  };
}

function canonicalRequest<T extends GitHubProviderRequestContext>(input: T): T {
  return {
    ...input,
    repository: normalizeGitHubRepository(input.repository).toLowerCase(),
  };
}

function optionalBooleanEnv(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const value = env[key];
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${key} must be exact true or false`);
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
