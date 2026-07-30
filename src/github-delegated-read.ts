import {
  GitHubCapabilityCatalogueService,
} from "./github-capability-service.js";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
} from "./github-provider-contracts.js";
import {
  boundedText,
  normalizeGitHubRepository,
  projectSlug,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

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
  bindings: GitHubProviderBindingStore;
  authority: GitHubDelegatedReadAuthority;
  adapter: GitHubDelegatedReadAdapter;
  catalogue?: GitHubCapabilityCatalogueService;
}

interface ResolvedDelegatedReadScope {
  project: string;
  repositoryFullName: string;
  binding: GitHubProjectRepositoryBinding;
  connection: GitHubProviderConnection;
  capabilityGrantId: string | null;
  approvalId: string | null;
}

export class GitHubDelegatedReadService {
  readonly #bindings: GitHubProviderBindingStore;
  readonly #authority: GitHubDelegatedReadAuthority;
  readonly #adapter: GitHubDelegatedReadAdapter;
  readonly #catalogue: GitHubCapabilityCatalogueService;

  constructor(dependencies: GitHubDelegatedReadDependencies) {
    this.#bindings = dependencies.bindings;
    this.#authority = dependencies.authority;
    this.#adapter = dependencies.adapter;
    this.#catalogue = dependencies.catalogue ?? new GitHubCapabilityCatalogueService();
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
    const tool = boundedText(input.tool, "GitHub delegated tool name", 128)
      .toLocaleLowerCase("en-US");
    const actorId = boundedText(input.actorId, "GitHub delegated actor ID", 120);
    const clientId = boundedText(input.clientId, "GitHub delegated client ID", 240);
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

    const args = boundedJsonObject(
      input.arguments,
      "GitHub delegated arguments",
      64 * 1024,
    );
    const scope = await this.#resolveScope({
      project,
      repositoryFullName,
      tool,
      actorId,
      clientId,
      catalogueFingerprint,
      ...(input.capabilityGrantId
        ? { capabilityGrantId: boundedText(
          input.capabilityGrantId,
          "GitHub delegated capability grant ID",
          240,
        ) }
        : {}),
      ...(input.approvalId
        ? { approvalId: boundedText(
          input.approvalId,
          "GitHub delegated approval ID",
          240,
        ) }
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
      attachmentId: scope.binding.attachmentId,
      attachmentSnapshotSha256: scope.binding.attachmentSnapshotSha256,
      capabilityGrantId: scope.capabilityGrantId,
      approvalId: scope.approvalId,
      catalogueFingerprint,
      parametersSha256: sha256(parametersJson),
      providerRequestId: called.providerRequestId
        ? boundedText(called.providerRequestId, "GitHub provider request ID", 240)
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
    const binding = await this.#bindings.getGitHubProjectRepositoryBinding(
      input.project,
      input.repositoryFullName,
    );
    if (!binding || binding.status !== "active") {
      throw new GitHubDelegatedBindingError(
        `No active GitHub binding for ${input.project}/${input.repositoryFullName}`,
      );
    }
    const connection = await this.#bindings.getGitHubProviderConnection(
      binding.connectionId,
    );
    if (!connection || connection.status !== "active") {
      throw new GitHubDelegatedBindingError(
        `GitHub connection ${binding.connectionId} is unavailable`,
      );
    }
    if (!connection.repositoryFullNames.includes(input.repositoryFullName)) {
      throw new GitHubDelegatedBindingError(
        `GitHub connection ${connection.id} does not include ${input.repositoryFullName}`,
      );
    }
    const authority = await this.#authority.authorizeGitHubDelegatedRead(input);
    if (!authority.allowed) {
      throw new GitHubDelegatedAuthorityError(
        authority.reason ?? "GitHub delegated read authority denied",
      );
    }
    return {
      project: input.project,
      repositoryFullName: input.repositoryFullName,
      binding,
      connection,
      capabilityGrantId: authority.capabilityGrantId ?? input.capabilityGrantId ?? null,
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

function boundedFingerprint(value: string, label: string): string {
  const fingerprint = boundedText(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) {
    throw new RangeError(`${label} must be a SHA-256 fingerprint`);
  }
  return fingerprint;
}

function boundedJsonObject(
  value: unknown,
  label: string,
  maximumBytes: number,
): Record<string, unknown> {
  const canonical = boundedJsonValue(value, label, maximumBytes);
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
    throw new RangeError(`${label} must be a JSON object`);
  }
  return canonical as Record<string, unknown>;
}

function boundedJsonValue(
  value: unknown,
  label: string,
  maximumBytes: number,
): unknown {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 1_000) throw new RangeError(`${label} exceeds 1000 JSON nodes`);
    if (depth > 16) throw new RangeError(`${label} exceeds JSON depth 16`);
    if (
      entry === null
      || typeof entry === "string"
      || typeof entry === "boolean"
    ) return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new RangeError(`${label} contains a non-finite number`);
      return Object.is(entry, -0) ? 0 : entry;
    }
    if (Array.isArray(entry)) return entry.map((item) => visit(item, depth + 1));
    if (!entry || typeof entry !== "object") {
      throw new RangeError(`${label} contains a non-JSON value`);
    }
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
      const canonicalKey = boundedText(key, `${label} key`, 256);
      if (canonicalKey !== key) throw new RangeError(`${label} keys must be canonical`);
      result[key] = visit(nested, depth + 1);
    }
    return result;
  };
  const canonical = visit(value, 0);
  const json = stableJson(canonical);
  if (Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw new RangeError(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return canonical;
}
