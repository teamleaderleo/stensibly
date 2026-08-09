import { captureDataMethod } from "./captured-data-method.js";
import {
  GitHubAppInstallationTokenMinter,
} from "./github-app-installation-token.js";
import { GitHubIssueProviderService } from "./github-issue-provider-service.js";
import {
  withGitHubIssueProviderReadService,
  withGitHubIssueProviderWriteService,
  withGitHubPublicationProviderWriteService,
  withGitHubRepositoryFileWriteService,
  type GitHubIssueProviderReadService,
  type GitHubIssueProviderWriteService,
  type GitHubPublicationProviderWriteService,
  type GitHubRepositoryFileWriteService,
} from "./github-issue-provider-mcp.js";
import {
  admitGitHubProjectRepositoryBinding,
  admitGitHubProviderConnection,
  validateBindingConnection,
} from "./github-provider-binding-admission.js";
import type {
  GitHubProviderOperation,
  GitHubProviderAuthority,
  GitHubProviderReceipt,
  GitHubProviderReceiptReservation,
  GitHubProviderReceiptStore,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import { GitHubPublicationProviderService } from "./github-publication-provider-service.js";
import { githubCapabilityRegistry } from "./github-capability-curation.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import {
  GitHubRepositoryWriteProviderService,
  type GitHubRepositoryWriteAuthorityProvider,
  type GitHubRepositoryWriteStore,
} from "./github-repository-write-provider-service.js";
import {
  repositoryWriteInstallationTokenProvider,
} from "./github-repository-write-installation-token.js";
import { HostedGitHubAttachmentBindingStore } from "./hosted-github-attachment-binding.js";
import { GitHubRestIssueProviderAdapter } from "./github-rest-issue-adapter.js";
import { GitHubRestIssueWriteAdapter } from "./github-rest-issue-write-adapter.js";
import { GitHubRestPublicationWriteAdapter } from "./github-rest-publication-write-adapter.js";
import { GitHubRestDelegatedReadAdapter } from "./github-rest-delegated-read-adapter.js";
import { GitHubRestRepositoryWriteAdapter } from "./github-rest-repository-write-adapter.js";
import { admitGitHubBranchRef } from "./github-repository-write-admission.js";
import type { WorkLedger } from "./ledger.js";
import { projectAttachmentLedger } from "./project-attachment-ledger.js";
import {
  GitHubPublishChangeOperation,
  withGitHubPublishChangeService,
  type GitHubPublishChangeService,
} from "./github-publish-change-operation.js";
import { operationWorkflowStore } from "./operation-workflow-contracts.js";
import { runnerLedger } from "./runner-contracts.js";

export interface HostedGitHubIssueProviderOverrides {
  fetch?: typeof fetch;
  now?: () => number;
}

interface HostedGitHubIssueProviderConfig {
  project: string;
  appId: string;
  installationId: string;
  accountLogin: string;
  privateKeyPem: string;
  apiBaseUrl: string;
  credentialRef: string;
  issueWritesEnabled: boolean;
  publicationWritesEnabled: boolean;
}

const readOperations = new Set<GitHubProviderOperation>([
  "github_list_issues",
  "github_search_issues",
  "github_get_issue",
]);
const initialWriteOperations = new Set<GitHubProviderOperation>([
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_comment",
]);
const publicationWriteOperations = new Set<GitHubProviderOperation>([
  "github_create_branch",
  "github_create_pull_request",
]);

/**
 * Mounts the production read provider when the complete GitHub App
 * configuration exists. A separate exact flag mounts an independent write
 * service only when the ledger also exposes the durable hosted receipt contract.
 */
export function mountHostedGitHubIssueProviderFromEnv<T extends WorkLedger>(
  ledger: T,
  env: Record<string, string | undefined>,
  overrides: HostedGitHubIssueProviderOverrides = {},
): T
  & Partial<GitHubIssueProviderReadService>
  & Partial<GitHubIssueProviderWriteService>
  & Partial<GitHubPublicationProviderWriteService>
  & Partial<GitHubRepositoryFileWriteService>
  & Partial<GitHubPublishChangeService> {
  const config = hostedGitHubIssueProviderConfig(env);
  if (!config) return ledger;
  const projects = projectAttachmentLedger(ledger);
  if (!projects) {
    throw new Error(
      "Hosted GitHub issue provider requires a project-attachment ledger",
    );
  }
  const now = overrides.now ?? Date.now;
  const bindings = new HostedGitHubAttachmentBindingStore(
    projects,
    config,
    new Date(now()).toISOString(),
  );
  const tokens = new GitHubAppInstallationTokenMinter({
    appId: config.appId,
    installationId: config.installationId,
    accountLogin: config.accountLogin,
    privateKeyPem: config.privateKeyPem,
    authorizeRepository: (repositoryFullName) =>
      bindings.authorizesRepository(repositoryFullName),
    apiBaseUrl: config.apiBaseUrl,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    now,
  });
  const adapterOptions = {
    tokenProvider: tokens,
    apiBaseUrl: config.apiBaseUrl,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  };
  const authority = new HostedGitHubAuthority(config);
  const readService = new GitHubIssueProviderService({
    projects,
    bindings,
    authority,
    adapter: new GitHubRestIssueProviderAdapter(adapterOptions),
    receipts: new ReadOnlyGitHubProviderReceiptStore(),
    now: () => new Date(now()).toISOString(),
  });
  const mountedReads = withGitHubIssueProviderReadService(
    ledger,
    canonicalHostedReadService(readService),
  );
  const mountedIssueWrites = config.issueWritesEnabled
    ? withGitHubIssueProviderWriteService(
      mountedReads,
      canonicalHostedWriteService(new GitHubIssueProviderService({
        projects,
        bindings,
        authority,
        adapter: new GitHubRestIssueWriteAdapter(adapterOptions),
        receipts: durableReceiptStore(ledger),
        now: () => new Date(now()).toISOString(),
      })),
    )
    : mountedReads;
  if (!config.publicationWritesEnabled) return mountedIssueWrites;

  const providerReceiptStore = durableReceiptStore(ledger);
  const publicationWrites = canonicalHostedPublicationWriteService(
    new GitHubPublicationProviderService({
      projects,
      bindings,
      authority,
      adapter: new GitHubRestPublicationWriteAdapter(adapterOptions),
      receipts: providerReceiptStore,
      now: () => new Date(now()).toISOString(),
    }),
  );
  const mountedPublication = withGitHubPublicationProviderWriteService(
    mountedIssueWrites,
    publicationWrites,
  );
  const metadataAdapter = new GitHubRestDelegatedReadAdapter({
    connectionId: bindings.connectionId,
    installationId: config.installationId,
    credentialRef: config.credentialRef,
    tokenProvider: tokens,
    apiBaseUrl: config.apiBaseUrl,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  });
  const repositoryWrites = new GitHubRepositoryWriteProviderService({
    authority: new HostedGitHubRepositoryWriteAuthority(
      config,
      bindings,
      metadataAdapter,
    ),
    adapter: new GitHubRestRepositoryWriteAdapter({
      tokenProvider: repositoryWriteInstallationTokenProvider(tokens),
      apiBaseUrl: config.apiBaseUrl,
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    }),
    store: durableRepositoryWriteStore(ledger),
    now: () => new Date(now()).toISOString(),
  });
  const repositoryFileWrites = canonicalHostedRepositoryFileWriteService(repositoryWrites);
  const mountedFiles = withGitHubRepositoryFileWriteService(
    mountedPublication,
    repositoryFileWrites,
  );
  const workflows = operationWorkflowStore(ledger);
  if (!workflows) return mountedFiles;
  const repositoryWriteStore = durableRepositoryWriteStore(ledger);
  return withGitHubPublishChangeService(
    mountedFiles,
    new GitHubPublishChangeOperation({
      workflows,
      assertAuthority: async (input) => {
        const runs = runnerLedger(ledger);
        if (!runs) throw new Error("Hosted GitHub operations require the runner ledger");
        const run = await runs.getRun(input.runId);
        const item = await ledger.getItem(input.itemId);
        const match = /^run:(.+):generation:(\d+)$/u.exec(input.authorityFence.resource);
        const expectedRunGeneration = match ? Number(match[2]) : Number.NaN;
        const currentLeaseExpiry = run.leaseExpiresAt === null
          ? Number.NaN
          : Date.parse(run.leaseExpiresAt);
        const fencedLeaseExpiry = Date.parse(input.authorityFence.expiresAt);
        if (
          !match
          || match[1] !== input.runId
          || run.itemId !== input.itemId
          || item.item.project !== input.project
          || run.generation !== expectedRunGeneration
          || run.leaseGeneration !== input.authorityFence.generation
          || run.leaseOwnerId !== input.actorId
          || !Number.isFinite(currentLeaseExpiry)
          || currentLeaseExpiry < fencedLeaseExpiry
          || (run.status !== "starting" && run.status !== "running")
          || currentLeaseExpiry <= now()
        ) {
          throw new Error("Hosted GitHub operation runner authority is stale or mismatched");
        }
      },
      publication: {
        ...publicationWrites,
        getGitHubProviderReceipt:
          providerReceiptStore.getGitHubProviderReceipt.bind(providerReceiptStore),
      },
      repositoryFiles: {
        ...repositoryFileWrites,
        getRepositoryWriteReceipt:
          repositoryWriteStore.getRepositoryWriteReceipt.bind(repositoryWriteStore),
      },
      now: () => new Date(now()).toISOString(),
    }),
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
  const publicationWritesEnabled = optionalBooleanEnv(
    env,
    "STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED",
  );
  const keys = [
    "STENSIBLY_GITHUB_APP_ID",
    "STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    "STENSIBLY_GITHUB_INSTALLATION_ID",
    "STENSIBLY_GITHUB_PROVIDER_PROJECT",
    "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
    "STENSIBLY_GITHUB_API_BASE_URL",
  ] as const;
  const configured = issueWritesEnabled
    || publicationWritesEnabled
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
  const accountLogin = exactAuthorityEnv(
    env,
    "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
  ).toLowerCase();
  const apiBaseUrl = trimmed(env.STENSIBLY_GITHUB_API_BASE_URL)
    ?? "https://api.github.com";
  return {
    project,
    appId,
    installationId,
    accountLogin,
    privateKeyPem,
    apiBaseUrl,
    credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    issueWritesEnabled,
    publicationWritesEnabled,
  };
}

class HostedGitHubAuthority implements GitHubProviderAuthority {
  readonly #config: HostedGitHubIssueProviderConfig;

  constructor(config: HostedGitHubIssueProviderConfig) {
    this.#config = config;
  }

  async authorizeGitHubOperation(input: {
    project: string;
    repositoryFullName: string;
    operation: GitHubProviderOperation;
    actorId: string;
    clientId: string;
    capabilityGrantId?: string;
    approvalId?: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    if (input.project !== this.#config.project) {
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
    if (
      this.#config.publicationWritesEnabled
      && publicationWriteOperations.has(input.operation)
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

class HostedGitHubRepositoryWriteAuthority
  implements GitHubRepositoryWriteAuthorityProvider
{
  readonly #config: HostedGitHubIssueProviderConfig;
  readonly #bindings: HostedGitHubAttachmentBindingStore;
  readonly #metadata: GitHubRestDelegatedReadAdapter;

  constructor(
    config: HostedGitHubIssueProviderConfig,
    bindings: HostedGitHubAttachmentBindingStore,
    metadata: GitHubRestDelegatedReadAdapter,
  ) {
    this.#config = config;
    this.#bindings = bindings;
    this.#metadata = metadata;
  }

  async getRepositoryWriteAuthority(
    input: Parameters<
      GitHubRepositoryWriteAuthorityProvider["getRepositoryWriteAuthority"]
    >[0],
  ): Promise<unknown> {
    if (
      input.project !== this.#config.project
      || (input.operation !== "create_file" && input.operation !== "update_file")
    ) {
      throw new Error("Hosted GitHub repository-file write is outside enabled authority");
    }
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const bindingRaw = await this.#bindings.getGitHubProjectRepositoryBinding(
      input.project,
      repositoryFullName,
    );
    if (!bindingRaw) {
      throw new Error("Hosted GitHub repository-file write has no active project binding");
    }
    const binding = admitGitHubProjectRepositoryBinding(bindingRaw);
    const connectionRaw = await this.#bindings.getGitHubProviderConnection(
      binding.connectionId,
    );
    if (!connectionRaw) {
      throw new Error("Hosted GitHub repository-file write has no active connection");
    }
    const connection = admitGitHubProviderConnection(connectionRaw);
    validateBindingConnection(binding, connection);
    if (
      binding.project !== input.project
      || binding.repositoryFullName !== repositoryFullName
      || connection.installationId !== this.#config.installationId
      || connection.credentialRef !== this.#config.credentialRef
    ) {
      throw new Error("Hosted GitHub repository-file write binding changed");
    }
    const metadata = await this.#metadata.callReadTool({
      tool: "get_repo",
      arguments: {},
      repositoryFullName,
      connectionId: connection.id,
      installationId: connection.installationId,
      credentialRef: connection.credentialRef,
      catalogueFingerprint: githubCapabilityRegistry.fingerprint,
    });
    const result = metadata.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Hosted GitHub repository metadata is unavailable");
    }
    const defaultBranch = admitGitHubBranchRef(
      (result as Record<string, unknown>).defaultBranch,
    );
    return Object.freeze({
      version: 1 as const,
      repositoryFullName,
      targetRef: admitGitHubBranchRef(input.targetRef),
      defaultBranch,
      authorityId: binding.id,
      authorityGeneration: repositoryWriteAuthorityGeneration(
        binding.attachmentSnapshotSha256,
      ),
      defaultBranchApprovalId: null,
    });
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
  const reserve = captureDataMethod(value, "reserveGitHubProviderReceipt");
  const update = captureDataMethod(value, "updateGitHubProviderReceipt");
  const get = captureDataMethod(value, "getGitHubProviderReceipt");
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

function durableRepositoryWriteStore(value: unknown): GitHubRepositoryWriteStore {
  const reserve = captureDataMethod(value, "reserveRepositoryWrite");
  const reject = captureDataMethod(value, "rejectAndReleaseRepositoryWrite");
  const hold = captureDataMethod(value, "holdRepositoryWriteForReconciliation");
  const record = captureDataMethod(value, "recordVerifiedRepositoryWrite");
  const holdVerified = captureDataMethod(
    value,
    "holdVerifiedRepositoryWriteForReconciliation",
  );
  const release = captureDataMethod(value, "releaseVerifiedRepositoryWrite");
  const get = captureDataMethod(value, "getRepositoryWriteReceipt");
  if (
    !reserve
    || !reject
    || !hold
    || !record
    || !holdVerified
    || !release
    || !get
  ) {
    throw new Error(
      "Hosted GitHub repository-file writes require the durable exact-CAS receipt store",
    );
  }
  return Object.freeze({
    reserveRepositoryWrite:
      reserve as GitHubRepositoryWriteStore["reserveRepositoryWrite"],
    rejectAndReleaseRepositoryWrite:
      reject as GitHubRepositoryWriteStore["rejectAndReleaseRepositoryWrite"],
    holdRepositoryWriteForReconciliation:
      hold as GitHubRepositoryWriteStore["holdRepositoryWriteForReconciliation"],
    recordVerifiedRepositoryWrite:
      record as GitHubRepositoryWriteStore["recordVerifiedRepositoryWrite"],
    holdVerifiedRepositoryWriteForReconciliation:
      holdVerified as GitHubRepositoryWriteStore["holdVerifiedRepositoryWriteForReconciliation"],
    releaseVerifiedRepositoryWrite:
      release as GitHubRepositoryWriteStore["releaseVerifiedRepositoryWrite"],
    getRepositoryWriteReceipt:
      get as GitHubRepositoryWriteStore["getRepositoryWriteReceipt"],
  });
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

function canonicalHostedPublicationWriteService(
  service: GitHubPublicationProviderWriteService,
): GitHubPublicationProviderWriteService {
  return {
    createBranch: (input) => service.createBranch(canonicalRequest(input)),
    createPullRequest: (input) =>
      service.createPullRequest(canonicalRequest(input)),
  };
}

function canonicalHostedRepositoryFileWriteService(
  service: GitHubRepositoryWriteProviderService,
): GitHubRepositoryFileWriteService {
  return {
    createRepositoryFile: (input) => service.execute({
      project: input.project,
      actorId: input.actorId,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      intent: {
        version: 1,
        repositoryFullName: normalizeGitHubRepository(input.repository)
          .toLowerCase(),
        path: input.path,
        operation: "create_file",
        targetRef: input.branch,
        expectedParentSha: input.expectedParentSha,
      },
      payload: {
        operation: "create_file",
        content: input.content,
        message: input.message,
      },
    }),
    updateRepositoryFile: (input) => service.execute({
      project: input.project,
      actorId: input.actorId,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      intent: {
        version: 1,
        repositoryFullName: normalizeGitHubRepository(input.repository)
          .toLowerCase(),
        path: input.path,
        operation: "update_file",
        targetRef: input.branch,
        expectedParentSha: input.expectedParentSha,
      },
      payload: {
        operation: "update_file",
        contentSha: input.contentSha,
        content: input.content,
        message: input.message,
      },
    }),
  };
}

function repositoryWriteAuthorityGeneration(snapshotSha256: string): number {
  const generation = Number.parseInt(snapshotSha256.slice("sha256:".length, 19), 16);
  return generation > 0 ? generation : 1;
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
