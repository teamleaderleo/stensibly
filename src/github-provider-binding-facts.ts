import { captureDataMethod } from "./captured-data-method.js";
import {
  admitGitHubProjectRepositoryBinding,
  admitGitHubProviderConnection,
} from "./github-provider-binding-admission.js";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
} from "./github-provider-contracts.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { validateProjectScope } from "./project-scope.js";

export interface GitHubProjectRepositoryBindingFacts {
  version: 1;
  project: string;
  repositoryFullName: string;
  binding: {
    id: string;
    status: GitHubProjectRepositoryBinding["status"];
    connectionId: string;
    attachmentId: string;
    attachmentSnapshotSha256: string;
    acceptedAt: string;
  } | null;
  connection: {
    id: string;
    status: GitHubProviderConnection["status"];
    observedAt: string;
  } | null;
  connectionIdMatches: boolean | null;
  repositoryGranted: boolean | null;
  authorizesMutation: false;
}

export async function readGitHubProjectRepositoryBindingFacts(
  store: GitHubProviderBindingStore,
  input: {
    project: string;
    repositoryFullName: string;
  },
): Promise<GitHubProjectRepositoryBindingFacts> {
  const snapshot = snapshotBindingFactsInput(input);
  const project = validateProjectScope(snapshot.project, "project");
  const repositoryFullName = normalizeGitHubRepository(
    snapshot.repositoryFullName,
  ).toLowerCase();
  const getBinding = captureDataMethod(store, "getGitHubProjectRepositoryBinding");
  if (!getBinding) {
    throw new Error("GitHub provider binding reader is unavailable");
  }

  const bindingResult = await getBinding(project, repositoryFullName);
  if (bindingResult === null) {
    return freezeFacts({
      version: 1,
      project,
      repositoryFullName,
      binding: null,
      connection: null,
      connectionIdMatches: null,
      repositoryGranted: null,
      authorizesMutation: false,
    });
  }

  const binding = admitGitHubProjectRepositoryBinding(bindingResult);
  if (
    binding.project !== project
    || binding.repositoryFullName !== repositoryFullName
  ) {
    throw new RangeError(
      "GitHub provider binding reader returned a binding outside the requested scope",
    );
  }

  const getConnection = captureDataMethod(store, "getGitHubProviderConnection");
  if (!getConnection) {
    throw new Error("GitHub provider connection reader is unavailable");
  }
  const connectionResult = await getConnection(binding.connectionId);
  const connection = connectionResult === null
    ? null
    : admitGitHubProviderConnection(connectionResult);

  return freezeFacts({
    version: 1,
    project,
    repositoryFullName,
    binding: projectBindingFacts(binding),
    connection: connection ? providerConnectionFacts(connection) : null,
    connectionIdMatches: connection ? connection.id === binding.connectionId : null,
    repositoryGranted: connection
      ? connection.repositoryFullNames.includes(repositoryFullName)
      : null,
    authorizesMutation: false,
  });
}

function snapshotBindingFactsInput(value: unknown): {
  project: string;
  repositoryFullName: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("GitHub provider binding facts input must be an object");
  }
  return {
    project: inputStringProperty(value, "project"),
    repositoryFullName: inputStringProperty(value, "repositoryFullName"),
  };
}

function inputStringProperty(value: object, key: string): string {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError("GitHub provider binding facts input could not be inspected");
  }
  if (
    !descriptor
    || !("value" in descriptor)
    || descriptor.enumerable !== true
    || typeof descriptor.value !== "string"
  ) {
    throw new TypeError(
      `GitHub provider binding facts input field ${key} must be an enumerable string data property`,
    );
  }
  return descriptor.value;
}

function projectBindingFacts(
  binding: GitHubProjectRepositoryBinding,
): NonNullable<GitHubProjectRepositoryBindingFacts["binding"]> {
  return Object.freeze({
    id: binding.id,
    status: binding.status,
    connectionId: binding.connectionId,
    attachmentId: binding.attachmentId,
    attachmentSnapshotSha256: binding.attachmentSnapshotSha256,
    acceptedAt: binding.acceptedAt,
  });
}

function providerConnectionFacts(
  connection: GitHubProviderConnection,
): NonNullable<GitHubProjectRepositoryBindingFacts["connection"]> {
  return Object.freeze({
    id: connection.id,
    status: connection.status,
    observedAt: connection.observedAt,
  });
}

function freezeFacts(
  facts: GitHubProjectRepositoryBindingFacts,
): GitHubProjectRepositoryBindingFacts {
  return Object.freeze(facts);
}
