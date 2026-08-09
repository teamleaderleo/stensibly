import { captureDataMethod } from "./captured-data-method.js";
import {
  GitHubAppInstallationTokenMinter,
} from "./github-app-installation-token.js";
import { HostedGitHubAttachmentBindingStore } from "./hosted-github-attachment-binding.js";
import type {
  GitHubProviderAuthorityDecision,
  GitHubProviderOperation,
  GitHubProviderReceiptStore,
  GitHubPublicationProviderAdapter,
  GitHubPublicationProviderOperation,
} from "./github-provider-contracts.js";
import {
  GitHubPublicationReadbackReconciler,
} from "./github-publication-readback-reconciliation.js";
import {
  GitHubPublishChangeReadbackService,
} from "./github-publish-change-readback.js";
import type {
  GitHubPublishChangeService,
} from "./github-publish-change-operation.js";
import { GitHubRestPublicationWriteAdapter } from "./github-rest-publication-write-adapter.js";
import type { GitHubRepositoryWriteReceipt } from "./github-repository-write-provider-service.js";
import type { WorkLedger } from "./ledger.js";
import { projectAttachmentLedger } from "./project-attachment-ledger.js";

export interface HostedGitHubPublicationReadbackOverrides {
  fetch?: typeof fetch;
  now?: () => number;
  adapter?: GitHubPublicationProviderAdapter;
}

interface HostedGitHubPublicationReadbackConfig {
  project: string;
  appId: string;
  installationId: string;
  accountLogin: string;
  privateKeyPem: string;
  apiBaseUrl: string;
  credentialRef: string;
}

/**
 * Replaces only the already-mounted publish-change service with the readback
 * wrapper. The public MCP catalogue is unchanged; normal publication still
 * delegates to the original hosted operation.
 */
export function mountHostedGitHubPublicationReadbackFromEnv<T extends WorkLedger>(
  ledger: T,
  env: Record<string, string | undefined>,
  overrides: HostedGitHubPublicationReadbackOverrides = {},
): T & Partial<GitHubPublishChangeService> {
  const enabled = optionalBooleanEnv(
    env,
    "STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED",
  );
  if (!enabled) return ledger;

  const config = hostedGitHubPublicationReadbackConfig(env);
  const projects = projectAttachmentLedger(ledger);
  if (!projects) {
    throw new Error(
      "Hosted GitHub publication readback requires a project-attachment ledger",
    );
  }
  const delegate = publishChangeService(ledger);
  const receipts = providerReceiptStore(ledger);
  const repositoryFiles = repositoryWriteReceiptReader(ledger);
  const now = overrides.now ?? Date.now;
  const bindings = new HostedGitHubAttachmentBindingStore(
    projects,
    config,
    new Date(now()).toISOString(),
  );
  const adapter = overrides.adapter ?? publicationAdapter(
    config,
    bindings,
    now,
    overrides.fetch,
  );
  const readback = new GitHubPublicationReadbackReconciler({
    projects,
    bindings,
    authority: new HostedGitHubPublicationReadbackAuthority(config.project),
    adapter,
    receipts,
    now: () => new Date(now()).toISOString(),
  });
  const service = new GitHubPublishChangeReadbackService({
    delegate,
    publicationReadback: readback,
    repositoryFiles,
  });
  return Object.assign(ledger, {
    publishChange: service.publishChange.bind(service),
    reconcilePublishChange: service.reconcilePublishChange.bind(service),
  });
}

class HostedGitHubPublicationReadbackAuthority {
  readonly #project: string;

  constructor(project: string) {
    this.#project = project;
  }

  async authorizeGitHubOperation(input: {
    project: string;
    repositoryFullName: string;
    operation: GitHubPublicationProviderOperation;
    actorId: string;
    clientId: string;
    capabilityGrantId?: string;
    approvalId?: string;
  }): Promise<GitHubProviderAuthorityDecision> {
    return input.project === this.#project
      && publicationOperations.has(input.operation)
      ? { allowed: true }
      : {
        allowed: false,
        reason: "Hosted GitHub publication readback is outside configured authority",
      };
  }
}

const publicationOperations = new Set<GitHubProviderOperation>([
  "github_create_branch",
  "github_create_pull_request",
]);

function publicationAdapter(
  config: HostedGitHubPublicationReadbackConfig,
  bindings: HostedGitHubAttachmentBindingStore,
  now: () => number,
  fetchOverride: typeof fetch | undefined,
): GitHubPublicationProviderAdapter {
  const tokens = new GitHubAppInstallationTokenMinter({
    appId: config.appId,
    installationId: config.installationId,
    accountLogin: config.accountLogin,
    privateKeyPem: config.privateKeyPem,
    authorizeRepository: (repositoryFullName) =>
      bindings.authorizesRepository(repositoryFullName),
    apiBaseUrl: config.apiBaseUrl,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
    now,
  });
  return new GitHubRestPublicationWriteAdapter({
    tokenProvider: tokens,
    apiBaseUrl: config.apiBaseUrl,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
}

function publishChangeService(value: unknown): GitHubPublishChangeService {
  const publish = captureDataMethod(value, "publishChange");
  const reconcile = captureDataMethod(value, "reconcilePublishChange");
  if (!publish || !reconcile) {
    throw new Error(
      "Hosted GitHub publication readback requires the mounted publish-change service",
    );
  }
  return {
    publishChange: publish as GitHubPublishChangeService["publishChange"],
    reconcilePublishChange:
      reconcile as GitHubPublishChangeService["reconcilePublishChange"],
  };
}

function providerReceiptStore(value: unknown): GitHubProviderReceiptStore {
  const reserve = captureDataMethod(value, "reserveGitHubProviderReceipt");
  const update = captureDataMethod(value, "updateGitHubProviderReceipt");
  const get = captureDataMethod(value, "getGitHubProviderReceipt");
  if (!reserve || !update || !get) {
    throw new Error(
      "Hosted GitHub publication readback requires the durable provider receipt store",
    );
  }
  return {
    reserveGitHubProviderReceipt:
      reserve as GitHubProviderReceiptStore["reserveGitHubProviderReceipt"],
    updateGitHubProviderReceipt:
      update as GitHubProviderReceiptStore["updateGitHubProviderReceipt"],
    getGitHubProviderReceipt:
      get as GitHubProviderReceiptStore["getGitHubProviderReceipt"],
  };
}

function repositoryWriteReceiptReader(value: unknown): {
  getRepositoryWriteReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubRepositoryWriteReceipt | null>;
} {
  const get = captureDataMethod(value, "getRepositoryWriteReceipt");
  if (!get) {
    throw new Error(
      "Hosted GitHub publication readback requires the repository-write receipt store",
    );
  }
  return {
    getRepositoryWriteReceipt: get as (
      project: string,
      idempotencyKey: string,
    ) => Promise<GitHubRepositoryWriteReceipt | null>,
  };
}

function hostedGitHubPublicationReadbackConfig(
  env: Record<string, string | undefined>,
): HostedGitHubPublicationReadbackConfig {
  const project = requiredExact(
    env.STENSIBLY_GITHUB_PROVIDER_PROJECT,
    "STENSIBLY_GITHUB_PROVIDER_PROJECT",
  );
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(project)) {
    throw new Error(
      "STENSIBLY_GITHUB_PROVIDER_PROJECT must be an exact lowercase project slug",
    );
  }
  const accountLogin = requiredExact(
    env.STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN,
    "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
  ).toLowerCase();
  return {
    project,
    appId: requiredTrimmed(env.STENSIBLY_GITHUB_APP_ID, "STENSIBLY_GITHUB_APP_ID"),
    installationId: requiredTrimmed(
      env.STENSIBLY_GITHUB_INSTALLATION_ID,
      "STENSIBLY_GITHUB_INSTALLATION_ID",
    ),
    accountLogin,
    privateKeyPem: requiredTrimmed(
      env.STENSIBLY_GITHUB_APP_PRIVATE_KEY,
      "STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    ),
    apiBaseUrl: trimmed(env.STENSIBLY_GITHUB_API_BASE_URL)
      ?? "https://api.github.com",
    credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
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

function requiredExact(value: string | undefined, label: string): string {
  if (
    !value
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/u.test(value)
  ) {
    throw new Error(`${label} requires exact printable ASCII`);
  }
  return value;
}

function requiredTrimmed(value: string | undefined, label: string): string {
  const result = trimmed(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}
