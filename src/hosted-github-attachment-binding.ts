import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
} from "./github-provider-contracts.js";
import {
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import { normalizeRepositoryRemote } from "./project-contract.js";
import type {
  ProjectAttachmentLedger,
  ProjectAttachmentRecord,
} from "./project-attachment-ledger.js";

export interface HostedGitHubAttachmentBindingConfig {
  project: string;
  installationId: string;
  accountLogin: string;
  credentialRef: string;
}

/**
 * Resolves one hosted GitHub App installation from the project's current
 * accepted attachment. The attachment is the durable repository authority;
 * Worker configuration identifies only the installation and its account.
 */
export class HostedGitHubAttachmentBindingStore
  implements GitHubProviderBindingStore
{
  readonly #projects: ProjectAttachmentLedger;
  readonly #config: HostedGitHubAttachmentBindingConfig;
  readonly #observedAt: string;
  readonly connectionId: string;

  constructor(
    projects: ProjectAttachmentLedger,
    config: HostedGitHubAttachmentBindingConfig,
    observedAt: string,
  ) {
    this.#projects = projects;
    this.#config = config;
    this.#observedAt = observedAt;
    this.connectionId = `ghconn_installation_${config.installationId}`;
  }

  async getGitHubProjectRepositoryBinding(
    project: string,
    repositoryFullName: string,
  ): Promise<GitHubProjectRepositoryBinding | null> {
    if (project !== this.#config.project) return null;
    const repository = canonicalRepository(repositoryFullName);
    const attachment = await this.#admittedAttachment();
    if (!attachment || !this.#repositories(attachment).includes(repository)) {
      return null;
    }
    const digest = sha256(stableJson({
      project,
      repositoryFullName: repository,
      connectionId: this.connectionId,
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    }));
    return Object.freeze({
      id: `ghbind_${digest.slice("sha256:".length, "sha256:".length + 24)}`,
      project,
      repositoryFullName: repository,
      connectionId: this.connectionId,
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      status: "active",
      acceptedAt: attachment.acceptedAt,
    });
  }

  async getGitHubProviderConnection(
    id: string,
  ): Promise<GitHubProviderConnection | null> {
    if (id !== this.connectionId) return null;
    const attachment = await this.#admittedAttachment();
    if (!attachment) return null;
    return Object.freeze({
      id: this.connectionId,
      provider: "github",
      installationId: this.#config.installationId,
      accountLogin: this.#config.accountLogin,
      credentialRef: this.#config.credentialRef,
      status: "active",
      repositoryFullNames: Object.freeze(
        this.#repositories(attachment),
      ) as unknown as string[],
      observedAt: this.#observedAt,
    });
  }

  /** Rechecks current durable authority before a cached token may be used. */
  async authorizesRepository(repositoryFullName: string): Promise<boolean> {
    const repository = canonicalRepository(repositoryFullName);
    const attachment = await this.#admittedAttachment();
    return attachment !== null
      && this.#repositories(attachment).includes(repository);
  }

  async #admittedAttachment(): Promise<ProjectAttachmentRecord | null> {
    const attachment = await this.#projects.getProjectAttachment(
      this.#config.project,
    );
    if (
      !attachment
      || attachment.project !== this.#config.project
      || attachment.snapshot.contract.project !== this.#config.project
    ) {
      return null;
    }
    return attachment;
  }

  #repositories(attachment: ProjectAttachmentRecord): string[] {
    const repositories = attachment.snapshot.contract.repositories
      .map((repository) => normalizeRepositoryRemote(repository))
      .filter((repository): repository is string => repository !== null)
      .map((repository) => tryCanonicalRepository(repository))
      .filter((repository): repository is string => repository !== null)
      .filter((repository) =>
        repository.split("/", 1)[0] === this.#config.accountLogin
      );
    return [...new Set(repositories)].sort(codeUnitCompare);
  }
}

function canonicalRepository(value: string): string {
  return normalizeGitHubRepository(value).toLowerCase();
}

function tryCanonicalRepository(value: string): string | null {
  try {
    return canonicalRepository(value);
  } catch {
    return null;
  }
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
