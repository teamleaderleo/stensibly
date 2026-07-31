import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderConnection,
} from "./github-provider-contracts.js";
import {
  canonicalTimestamp,
  normalizeGitHubRepository,
} from "./github-provider-validation.js";

const connectionKeys = [
  "id",
  "provider",
  "installationId",
  "accountLogin",
  "credentialRef",
  "status",
  "repositoryFullNames",
  "observedAt",
] as const;

const bindingKeys = [
  "id",
  "project",
  "repositoryFullName",
  "connectionId",
  "attachmentId",
  "attachmentSnapshotSha256",
  "status",
  "acceptedAt",
] as const;

/**
 * Compiles one persistence-ready GitHub provider connection.
 * Credential material stays behind an opaque secret reference.
 */
export function admitGitHubProviderConnection(
  input: unknown,
): GitHubProviderConnection {
  const record = exactRecord(input, connectionKeys, "GitHub provider connection");
  if (record.provider !== "github") {
    throw new RangeError("GitHub provider connection provider must be github");
  }
  const accountLogin = githubLogin(record.accountLogin);
  const repositories = repositoryList(record.repositoryFullNames, accountLogin);
  return Object.freeze({
    id: identifier(record.id, "GitHub provider connection ID"),
    provider: "github" as const,
    installationId: numericIdentifier(
      record.installationId,
      "GitHub App installation ID",
    ),
    accountLogin,
    credentialRef: credentialReference(record.credentialRef),
    status: connectionStatus(record.status),
    repositoryFullNames: Object.freeze(repositories) as unknown as string[],
    observedAt: exactTimestamp(
      record.observedAt,
      "GitHub provider connection observed time",
    ),
  });
}

/**
 * Compiles one project/repository binding and optionally proves that it belongs to
 * the supplied connection before persistence.
 */
export function admitGitHubProjectRepositoryBinding(
  input: unknown,
  connection?: GitHubProviderConnection,
): GitHubProjectRepositoryBinding {
  const record = exactRecord(input, bindingKeys, "GitHub project repository binding");
  const binding = Object.freeze({
    id: identifier(record.id, "GitHub project repository binding ID"),
    project: bindingProjectSlug(record.project),
    repositoryFullName: canonicalRepository(record.repositoryFullName),
    connectionId: identifier(record.connectionId, "GitHub provider connection ID"),
    attachmentId: identifier(record.attachmentId, "Project attachment ID"),
    attachmentSnapshotSha256: fingerprint(
      record.attachmentSnapshotSha256,
      "Project attachment snapshot fingerprint",
    ),
    status: bindingStatus(record.status),
    acceptedAt: exactTimestamp(
      record.acceptedAt,
      "GitHub project binding accepted time",
    ),
  });
  if (connection) {
    validateAdmittedBindingConnection(
      binding,
      admitGitHubProviderConnection(connection),
    );
  }
  return binding;
}

/** Re-admits both values before trusting their authority-bearing fields. */
export function validateBindingConnection(
  binding: unknown,
  connection: unknown,
): void {
  validateAdmittedBindingConnection(
    admitGitHubProjectRepositoryBinding(binding),
    admitGitHubProviderConnection(connection),
  );
}

function validateAdmittedBindingConnection(
  binding: GitHubProjectRepositoryBinding,
  connection: GitHubProviderConnection,
): void {
  if (binding.status !== "active") {
    throw new RangeError("GitHub project binding must be active");
  }
  if (binding.connectionId !== connection.id) {
    throw new RangeError("GitHub project binding connection ID does not match connection");
  }
  if (connection.status !== "active") {
    throw new RangeError("GitHub project binding requires an active connection");
  }
  if (!connection.repositoryFullNames.includes(binding.repositoryFullName)) {
    throw new RangeError("GitHub project binding repository is outside the connection");
  }
}

function exactRecord<const T extends readonly string[]>(
  value: unknown,
  allowedKeys: T,
  label: string,
): Record<T[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set<string>(allowedKeys);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) {
      throw new RangeError(`${label} contains unknown field ${key}`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} field ${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(descriptors, key)) {
      throw new RangeError(`${label} is missing field ${key}`);
    }
  }
  return result as Record<T[number], unknown>;
}

function repositoryList(value: unknown, accountLogin: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new RangeError("GitHub provider connection requires 0 to 100 repositories");
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError(
      "GitHub provider connection repositories must use the default array prototype",
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError("GitHub provider connection repositories contain a symbol field");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw new RangeError(
        `GitHub provider connection repositories contain unknown field ${key}`,
      );
    }
  }
  const repositories: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) {
      throw new RangeError("GitHub provider connection repositories must be dense");
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(
        "GitHub provider connection repositories must contain enumerable data entries",
      );
    }
    const repository = canonicalRepository(descriptor.value);
    const [owner] = repository.split("/");
    if (owner !== accountLogin) {
      throw new RangeError(
        `GitHub App repository ${repository} is outside installation account ${accountLogin}`,
      );
    }
    repositories.push(repository);
  }
  repositories.sort(codeUnitCompare);
  if (new Set(repositories).size !== repositories.length) {
    throw new RangeError("GitHub provider connection repositories must be unique");
  }
  return repositories;
}

function canonicalRepository(value: unknown): string {
  const repository = exactBoundedAscii(value, "GitHub repository", 4_096);
  return normalizeGitHubRepository(repository).toLowerCase();
}

function bindingProjectSlug(value: unknown): string {
  const project = exactBoundedAscii(value, "Project slug", 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
    throw new RangeError("Use a lowercase project slug");
  }
  return project;
}

function identifier(value: unknown, label: string): string {
  const id = exactBoundedAscii(value, label, 240);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,238}[A-Za-z0-9])?$/.test(id)) {
    throw new RangeError(`${label} is invalid`);
  }
  return id;
}

function numericIdentifier(value: unknown, label: string): string {
  const id = exactBoundedAscii(value, label, 32);
  if (!/^[1-9][0-9]*$/.test(id)) throw new RangeError(`${label} must be numeric`);
  return id;
}

function githubLogin(value: unknown): string {
  const login = exactBoundedAscii(value, "GitHub account login", 39).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login) || login.includes("--")) {
    throw new RangeError("GitHub account login is invalid");
  }
  return login;
}

function credentialReference(value: unknown): string {
  const reference = stringValue(value, "GitHub credential reference");
  if (
    reference.length > 240
    || !/^(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}$/.test(reference)
  ) {
    throw new RangeError("GitHub credential reference must use env:// or secret://");
  }
  return reference;
}

function fingerprint(value: unknown, label: string): string {
  const result = exactBoundedAscii(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) {
    throw new RangeError(`${label} must be a SHA-256 fingerprint`);
  }
  return result;
}

function exactTimestamp(value: unknown, label: string): string {
  return canonicalTimestamp(exactBoundedAscii(value, label, 40), label);
}

function exactBoundedAscii(value: unknown, label: string, maximum: number): string {
  const text = stringValue(value, label);
  if (!text || text.length > maximum) {
    throw new RangeError(`${label} must contain 1 to ${maximum} ASCII characters`);
  }
  if (!/^[\x20-\x7e]+$/.test(text)) {
    throw new RangeError(`${label} must use exact printable ASCII`);
  }
  if (text !== text.trim()) {
    throw new RangeError(`${label} must not contain surrounding whitespace`);
  }
  return text;
}

function connectionStatus(value: unknown): GitHubProviderConnection["status"] {
  if (value !== "active" && value !== "suspended" && value !== "revoked") {
    throw new RangeError("GitHub provider connection status is invalid");
  }
  return value;
}

function bindingStatus(value: unknown): GitHubProjectRepositoryBinding["status"] {
  if (value !== "active" && value !== "revoked") {
    throw new RangeError("GitHub project repository binding status is invalid");
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  return value;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
