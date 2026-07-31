import {
  GitHubCapabilityCatalogueService,
} from "./github-capability-service.js";
import {
  canonicalGitHubDelegatedReadTool,
  parseGitHubDelegatedReadArguments,
  supportsGitHubDelegatedReadContract,
} from "./github-delegated-read-contracts.js";
import {
  admitGitHubProjectRepositoryBinding,
  admitGitHubProviderConnection,
  validateBindingConnection,
} from "./github-provider-binding-admission.js";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
  GitHubProviderProjectReader,
} from "./github-provider-contracts.js";
import {
  boundedText,
  normalizeGitHubRepository,
  projectSlug,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import { normalizeRepositoryRemote } from "./project-contract.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";

export interface GitHubDelegatedReadAuthorityDecision {
  allowed: boolean;
  reason?: string;
  capabilityGrantId?: string;
  approvalId?: string;
}

export interface GitHubDelegatedReadAuthority {
  authorizeGitHubDelegatedRead(input: {
    project: string;
    repositoryFullName: string;
    tool: string;
    actorId: string;
    clientId: string;
    catalogueFingerprint: string;
    capabilityGrantId?: string;
    approvalId?: string;
  }): Promise<GitHubDelegatedReadAuthorityDecision>;
}

export interface GitHubDelegatedReadAdapter {
  callReadTool(input: {
    tool: string;
    arguments: Record<string, unknown>;
    repositoryFullName: string;
    connectionId: string;
    installationId: string;
    credentialRef: string;
    catalogueFingerprint: string;
  }): Promise<{
    result: unknown;
    providerRequestId?: string;
  }>;
}

export interface GitHubDelegatedReadReceipt {
  version: 1;
  project: string;
  repositoryFullName: string;
  tool: string;
  actorId: string;
  clientId: string;
  connectionId: string;
  installationId: string;
  bindingId: string;
  attachmentId: string;
  attachmentSnapshotSha256: string;
  capabilityGrantId: string | null;
  approvalId: string | null;
  catalogueFingerprint: string;
  parametersSha256: string;
  providerRequestId: string | null;
  resultSha256: string;
  result: unknown;
}

export interface GitHubDelegatedReadDependencies {
  projects: GitHubProviderProjectReader;
  bindings: GitHubProviderBindingStore;
  authority: GitHubDelegatedReadAuthority;
  adapter: GitHubDelegatedReadAdapter;
  catalogue?: GitHubCapabilityCatalogueService;
}

interface ResolvedDelegatedReadScope {
  project: string;
  repositoryFullName: string;
  attachment: ProjectAttachmentRecord;
  binding: GitHubProjectRepositoryBinding;
  connection: GitHubProviderConnection;
  capabilityGrantId: string | null;
  approvalId: string | null;
}

export class GitHubDelegatedReadService {
  readonly #projects: GitHubProviderProjectReader;
  readonly #bindings: GitHubProviderBindingStore;
  readonly #authority: GitHubDelegatedReadAuthority;
  readonly #adapter: GitHubDelegatedReadAdapter;
  readonly #catalogue: GitHubCapabilityCatalogueService;

  constructor(dependencies: GitHubDelegatedReadDependencies) {
    this.#projects = dependencies.projects;
    this.#bindings = dependencies.bindings;
    this.#authority = dependencies.authority;
    this.#adapter = dependencies.adapter;
    this.#catalogue = dependencies.catalogue
      ?? new GitHubCapabilityCatalogueService();
  }

  async call(input: {
    project: string;
    repository: string;
    tool: string;
    arguments: Record<string, unknown>;
    actorId: string;
    clientId: string;
    catalogueFingerprint: string;
    capabilityGrantId?: string;
    approvalId?: string;
  }): Promise<GitHubDelegatedReadReceipt> {
    const project = projectSlug(input.project);
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    const tool = canonicalGitHubDelegatedReadTool(input.tool);
    const actorId = boundedText(
      input.actorId,
      "GitHub delegated actor ID",
      120,
    );
    const clientId = boundedText(
      input.clientId,
      "GitHub delegated client ID",
      240,
    );
    const catalogueFingerprint = boundedFingerprint(
      input.catalogueFingerprint,
      "GitHub delegated catalogue fingerprint",
    );
    if (catalogueFingerprint !== this.#catalogue.registry.fingerprint) {
      throw new GitHubDelegatedCatalogueStaleError(
        this.#catalogue.registry.fingerprint,
      );
    }

    const capability = this.#catalogue.getTool(tool);
    if (
      capability.executionMode !== "delegated"
      || !capability.readOnly
      || !capability.searchable
    ) {
      throw new GitHubDelegatedToolDeniedError(
        `GitHub capability ${tool} is outside guarded delegated reads`,
      );
    }
    if (!capability.repositoryScoped) {
      throw new GitHubDelegatedToolDeniedError(
        `GitHub capability ${tool} requires a separate non-repository authority lane`,
      );
    }
    if (!supportsGitHubDelegatedReadContract(tool)) {
      throw new GitHubDelegatedToolDeniedError(
        `GitHub capability ${tool} is outside the enabled delegated-read subset`,
      );
    }

    const args = parseGitHubDelegatedReadArguments(tool, input.arguments);
    const scope = await this.#resolveScope({
      project,
      repositoryFullName,
      tool,
      actorId,
      clientId,
      catalogueFingerprint,
      ...(input.capabilityGrantId
        ? {
          capabilityGrantId: boundedText(
            input.capabilityGrantId,
            "GitHub delegated capability grant ID",
            240,
          ),
        }
        : {}),
      ...(input.approvalId
        ? {
          approvalId: boundedText(
            input.approvalId,
            "GitHub delegated approval ID",
            240,
          ),
        }
        : {}),
    });

    const parametersJson = stableJson(args);
    const called = await this.#adapter.callReadTool({
      tool,
      arguments: args,
      repositoryFullName,
      connectionId: scope.connection.id,
      installationId: scope.connection.installationId,
      credentialRef: scope.connection.credentialRef,
      catalogueFingerprint,
    });
    const result = boundedJsonValue(
      called.result,
      "GitHub delegated result",
      256 * 1024,
    );
    const resultJson = stableJson(result);
    return Object.freeze({
      version: 1,
      project,
      repositoryFullName,
      tool,
      actorId,
      clientId,
      connectionId: scope.connection.id,
      installationId: scope.connection.installationId,
      bindingId: scope.binding.id,
      attachmentId: scope.attachment.id,
      attachmentSnapshotSha256:
        scope.attachment.snapshot.snapshotSha256,
      capabilityGrantId: scope.capabilityGrantId,
      approvalId: scope.approvalId,
      catalogueFingerprint,
      parametersSha256: sha256(parametersJson),
      providerRequestId: called.providerRequestId
        ? boundedText(
          called.providerRequestId,
          "GitHub provider request ID",
          240,
        )
        : null,
      resultSha256: sha256(resultJson),
      result,
    });
  }

  async #resolveScope(input: {
    project: string;
    repositoryFullName: string;
    tool: string;
    actorId: string;
    clientId: string;
    catalogueFingerprint: string;
    capabilityGrantId?: string;
    approvalId?: string;
  }): Promise<ResolvedDelegatedReadScope> {
    const attachment = await this.#projects.getProjectAttachment(
      input.project,
    );
    if (!attachment) {
      throw new GitHubDelegatedBindingError(
        `Project ${input.project} has no accepted repository attachment`,
      );
    }
    const declaredRepositories = attachment.snapshot.contract.repositories
      .map((repository) => normalizeRepositoryRemote(repository))
      .filter((repository): repository is string => repository !== null)
      .map((repository) => repository.toLowerCase());
    if (!declaredRepositories.includes(input.repositoryFullName)) {
      throw new GitHubDelegatedBindingError(
        `Repository ${input.repositoryFullName} is outside the accepted project attachment`,
      );
    }

    const rawBinding =
      await this.#bindings.getGitHubProjectRepositoryBinding(
        input.project,
        input.repositoryFullName,
      );
    const binding = validatedBinding(
      rawBinding,
      input.project,
      input.repositoryFullName,
      attachment,
    );
    const rawConnection =
      await this.#bindings.getGitHubProviderConnection(
        binding.connectionId,
      );
    const connection = validatedConnection(rawConnection, binding);

    const authority =
      await this.#authority.authorizeGitHubDelegatedRead(input);
    if (!authority.allowed) {
      throw new GitHubDelegatedAuthorityError(
        authority.reason ?? "GitHub delegated read authority denied",
      );
    }
    return {
      project: input.project,
      repositoryFullName: input.repositoryFullName,
      attachment,
      binding,
      connection,
      capabilityGrantId:
        authority.capabilityGrantId ?? input.capabilityGrantId ?? null,
      approvalId: authority.approvalId ?? input.approvalId ?? null,
    };
  }
}

export class GitHubDelegatedCatalogueStaleError extends Error {
  readonly currentFingerprint: string;

  constructor(currentFingerprint: string) {
    super("GitHub delegated catalogue fingerprint is stale");
    this.name = "GitHubDelegatedCatalogueStaleError";
    this.currentFingerprint = currentFingerprint;
  }
}

export class GitHubDelegatedToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubDelegatedToolDeniedError";
  }
}

export class GitHubDelegatedBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubDelegatedBindingError";
  }
}

export class GitHubDelegatedAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubDelegatedAuthorityError";
  }
}

function validatedBinding(
  value: GitHubProjectRepositoryBinding | null,
  project: string,
  repositoryFullName: string,
  attachment: ProjectAttachmentRecord,
): GitHubProjectRepositoryBinding {
  if (!value) {
    throw new GitHubDelegatedBindingError(
      `No active GitHub binding for ${project}/${repositoryFullName}`,
    );
  }
  let binding: GitHubProjectRepositoryBinding;
  try {
    binding = admitGitHubProjectRepositoryBinding(value);
  } catch {
    throw new GitHubDelegatedBindingError(
      "GitHub binding record is invalid",
    );
  }
  if (binding.status !== "active") {
    throw new GitHubDelegatedBindingError(
      `No active GitHub binding for ${project}/${repositoryFullName}`,
    );
  }
  if (
    binding.project !== project
    || binding.repositoryFullName !== repositoryFullName
    || binding.attachmentId !== attachment.id
    || binding.attachmentSnapshotSha256
      !== attachment.snapshot.snapshotSha256
  ) {
    throw new GitHubDelegatedBindingError(
      "GitHub binding is stale or mismatched against the accepted project attachment",
    );
  }
  return binding;
}

function validatedConnection(
  value: GitHubProviderConnection | null,
  binding: GitHubProjectRepositoryBinding,
): GitHubProviderConnection {
  if (!value) {
    throw new GitHubDelegatedBindingError(
      `GitHub connection ${binding.connectionId} is unavailable`,
    );
  }
  let connection: GitHubProviderConnection;
  try {
    connection = admitGitHubProviderConnection(value);
  } catch {
    throw new GitHubDelegatedBindingError(
      "GitHub connection record is invalid",
    );
  }
  if (connection.id !== binding.connectionId) {
    throw new GitHubDelegatedBindingError(
      "GitHub connection identity does not match the accepted binding",
    );
  }
  if (connection.status !== "active") {
    throw new GitHubDelegatedBindingError(
      `GitHub connection ${binding.connectionId} is unavailable`,
    );
  }
  try {
    validateBindingConnection(binding, connection);
  } catch {
    throw new GitHubDelegatedBindingError(
      `GitHub connection ${connection.id} does not include ${binding.repositoryFullName}`,
    );
  }
  return connection;
}

function boundedFingerprint(value: string, label: string): string {
  const fingerprint = boundedText(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) {
    throw new RangeError(`${label} must be a SHA-256 fingerprint`);
  }
  return fingerprint;
}

function boundedJsonValue(
  value: unknown,
  label: string,
  maximumBytes: number,
): unknown {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 1_000) {
      throw new RangeError(`${label} exceeds 1000 JSON nodes`);
    }
    if (depth > 16) {
      throw new RangeError(`${label} exceeds JSON depth 16`);
    }
    if (
      entry === null
      || typeof entry === "string"
      || typeof entry === "boolean"
    ) return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new RangeError(`${label} contains a non-finite number`);
      }
      return Object.is(entry, -0) ? 0 : entry;
    }
    if (Array.isArray(entry)) {
      if (Object.getPrototypeOf(entry) !== Array.prototype) {
        throw new RangeError(
          `${label} arrays must use the default prototype`,
        );
      }
      if (Object.getOwnPropertySymbols(entry).length > 0) {
        throw new RangeError(`${label} arrays contain a symbol field`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      for (const key of Object.keys(descriptors)) {
        if (key === "length") continue;
        if (
          !/^(?:0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= entry.length
        ) {
          throw new RangeError(
            `${label} arrays contain unknown field ${key}`,
          );
        }
      }
      const result: unknown[] = [];
      for (let index = 0; index < entry.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) {
          throw new RangeError(`${label} arrays must be dense`);
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new RangeError(
            `${label} array entry ${index} must be an enumerable data property`,
          );
        }
        result.push(visit(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    if (!entry || typeof entry !== "object") {
      throw new RangeError(`${label} contains a non-JSON value`);
    }
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RangeError(
        `${label} objects must be plain JSON objects`,
      );
    }
    if (Object.getOwnPropertySymbols(entry).length > 0) {
      throw new RangeError(`${label} objects contain a symbol field`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const canonicalKey = boundedText(key, `${label} key`, 256);
      if (canonicalKey !== key) {
        throw new RangeError(`${label} keys must be canonical`);
      }
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new RangeError(
          `${label} field ${key} must be an enumerable data property`,
        );
      }
      result[key] = visit(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const canonical = visit(value, 0);
  const json = stableJson(canonical);
  if (Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw new RangeError(
      `${label} exceeds ${maximumBytes} UTF-8 bytes`,
    );
  }
  return canonical;
}
