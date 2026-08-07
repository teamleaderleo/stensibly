import { describe, expect, test } from "bun:test";
import { readGitHubProjectRepositoryBindingFacts } from "../src/github-provider-binding-facts.ts";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
} from "../src/github-provider-contracts.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const fingerprint = `sha256:${"a".repeat(64)}`;

function binding(
  overrides: Partial<GitHubProjectRepositoryBinding> = {},
): GitHubProjectRepositoryBinding {
  return {
    id: "binding-1",
    project: "pulse",
    repositoryFullName,
    connectionId: "connection-1",
    attachmentId: "attachment-1",
    attachmentSnapshotSha256: fingerprint,
    status: "active",
    acceptedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

function connection(
  overrides: Partial<GitHubProviderConnection> = {},
): GitHubProviderConnection {
  return {
    id: "connection-1",
    provider: "github",
    installationId: "12345",
    accountLogin: "teamleaderleo",
    credentialRef: "secret://github/provider-token",
    status: "active",
    repositoryFullNames: [repositoryFullName],
    observedAt: "2026-08-07T00:01:00.000Z",
    ...overrides,
  };
}

function store(
  currentBinding: GitHubProjectRepositoryBinding | null,
  currentConnection: GitHubProviderConnection | null,
): GitHubProviderBindingStore & {
  bindingReads: Array<[string, string]>;
  connectionReads: string[];
} {
  return {
    bindingReads: [],
    connectionReads: [],
    async getGitHubProjectRepositoryBinding(project: string, repository: string) {
      this.bindingReads.push([project, repository]);
      return currentBinding;
    },
    async getGitHubProviderConnection(id: string) {
      this.connectionReads.push(id);
      return currentConnection;
    },
  };
}

describe("GitHub project repository binding facts", () => {
  test("returns bounded current facts without credentials or repository allowlist", async () => {
    const reader = store(binding(), connection());

    const facts = await readGitHubProjectRepositoryBindingFacts(reader, {
      project: "pulse",
      repositoryFullName,
    });

    expect(facts).toEqual({
      version: 1,
      project: "pulse",
      repositoryFullName,
      binding: {
        id: "binding-1",
        status: "active",
        connectionId: "connection-1",
        attachmentId: "attachment-1",
        attachmentSnapshotSha256: fingerprint,
        acceptedAt: "2026-08-07T00:00:00.000Z",
      },
      connection: {
        id: "connection-1",
        status: "active",
        observedAt: "2026-08-07T00:01:00.000Z",
      },
      connectionIdMatches: true,
      repositoryGranted: true,
      authorizesMutation: false,
    });
    expect(reader.bindingReads).toEqual([["pulse", repositoryFullName]]);
    expect(reader.connectionReads).toEqual(["connection-1"]);
    expect(JSON.stringify(facts)).not.toContain("credentialRef");
    expect(JSON.stringify(facts)).not.toContain("provider-token");
    expect(JSON.stringify(facts)).not.toContain("repositoryFullNames");
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.binding)).toBe(true);
    expect(Object.isFrozen(facts.connection)).toBe(true);
  });

  test("canonicalizes mixed-case repository input before lookup", async () => {
    const reader = store(binding(), connection());
    const facts = await readGitHubProjectRepositoryBindingFacts(reader, {
      project: "pulse",
      repositoryFullName: "TeamLeaderLeo/Stensibly",
    });

    expect(facts.repositoryFullName).toBe(repositoryFullName);
    expect(reader.bindingReads).toEqual([["pulse", repositoryFullName]]);
    expect(facts.binding?.id).toBe("binding-1");
  });

  test("preserves degraded exact statuses instead of converting them into authority", async () => {
    const facts = await readGitHubProjectRepositoryBindingFacts(
      store(
        binding({ status: "revoked" }),
        connection({ status: "suspended", repositoryFullNames: [] }),
      ),
      { project: "pulse", repositoryFullName },
    );

    expect(facts.binding?.status).toBe("revoked");
    expect(facts.connection?.status).toBe("suspended");
    expect(facts.connectionIdMatches).toBe(true);
    expect(facts.repositoryGranted).toBe(false);
    expect(facts.authorizesMutation).toBe(false);
  });

  test("represents missing binding and missing connection without inventing facts", async () => {
    const unboundStore = store(null, connection());
    expect(await readGitHubProjectRepositoryBindingFacts(unboundStore, {
      project: "pulse",
      repositoryFullName,
    })).toEqual({
      version: 1,
      project: "pulse",
      repositoryFullName,
      binding: null,
      connection: null,
      connectionIdMatches: null,
      repositoryGranted: null,
      authorizesMutation: false,
    });
    expect(unboundStore.connectionReads).toEqual([]);

    const missingConnection = await readGitHubProjectRepositoryBindingFacts(
      store(binding(), null),
      { project: "pulse", repositoryFullName },
    );
    expect(missingConnection.binding?.id).toBe("binding-1");
    expect(missingConnection.connection).toBeNull();
    expect(missingConnection.connectionIdMatches).toBeNull();
    expect(missingConnection.repositoryGranted).toBeNull();
  });

  test("re-admits store results and exposes mismatched connection facts literally", async () => {
    const mismatched = await readGitHubProjectRepositoryBindingFacts(
      store(binding(), connection({ id: "connection-other" })),
      { project: "pulse", repositoryFullName },
    );
    expect(mismatched.connection?.id).toBe("connection-other");
    expect(mismatched.connectionIdMatches).toBe(false);
    expect(mismatched.authorizesMutation).toBe(false);

    await expect(readGitHubProjectRepositoryBindingFacts(
      store(binding({ project: "foreign" }), connection()),
      { project: "pulse", repositoryFullName },
    )).rejects.toThrow("outside the requested scope");
  });

  test("rejects accessor-backed reader methods without invoking them", async () => {
    let getterCalls = 0;
    const hostile = {} as GitHubProviderBindingStore;
    Object.defineProperty(hostile, "getGitHubProjectRepositoryBinding", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return async () => null;
      },
    });

    await expect(readGitHubProjectRepositoryBindingFacts(hostile, {
      project: "pulse",
      repositoryFullName,
    })).rejects.toThrow("binding reader is unavailable");
    expect(getterCalls).toBe(0);
  });
});
