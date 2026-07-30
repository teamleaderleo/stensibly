import { describe, expect, test } from "bun:test";
import {
  GitHubDelegatedAuthorityError,
  GitHubDelegatedBindingError,
  GitHubDelegatedCatalogueStaleError,
  GitHubDelegatedReadService,
  GitHubDelegatedToolDeniedError,
  type GitHubDelegatedReadAdapter,
  type GitHubDelegatedReadAuthority,
} from "../src/github-delegated-read.ts";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
} from "../src/github-provider-contracts.ts";

const catalogue = new GitHubCapabilityCatalogueService();
const repository = "teamleaderleo/stensibly";

function connection(
  overrides: Partial<GitHubProviderConnection> = {},
): GitHubProviderConnection {
  return {
    id: "ghconn_test",
    provider: "github",
    installationId: "12345",
    accountLogin: "teamleaderleo",
    credentialRef: "secret://github/test",
    status: "active",
    repositoryFullNames: [repository],
    observedAt: "2026-07-30T18:00:00.000Z",
    ...overrides,
  };
}

function binding(
  overrides: Partial<GitHubProjectRepositoryBinding> = {},
): GitHubProjectRepositoryBinding {
  return {
    id: "ghbind_test",
    project: "oauth-dogfood",
    repositoryFullName: repository,
    connectionId: "ghconn_test",
    attachmentId: "attachment_test",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    status: "active",
    acceptedAt: "2026-07-30T18:00:00.000Z",
    ...overrides,
  };
}

class FakeBindings implements GitHubProviderBindingStore {
  constructor(
    readonly bound: GitHubProjectRepositoryBinding | null = binding(),
    readonly connected: GitHubProviderConnection | null = connection(),
  ) {}

  async getGitHubProjectRepositoryBinding(
    project: string,
    repositoryFullName: string,
  ): Promise<GitHubProjectRepositoryBinding | null> {
    if (
      this.bound?.project === project
      && this.bound.repositoryFullName === repositoryFullName
    ) return this.bound;
    return null;
  }

  async getGitHubProviderConnection(
    id: string,
  ): Promise<GitHubProviderConnection | null> {
    return this.connected?.id === id ? this.connected : null;
  }
}

function authority(
  allowed = true,
): GitHubDelegatedReadAuthority {
  return {
    async authorizeGitHubDelegatedRead() {
      return allowed
        ? { allowed: true, capabilityGrantId: "grant_test" }
        : { allowed: false, reason: "policy denied" };
    },
  };
}

function adapter(
  calls: Array<Record<string, unknown>>,
  result: unknown = { path: "README.md", sha: "abc123" },
): GitHubDelegatedReadAdapter {
  return {
    async callReadTool(input) {
      calls.push(input);
      return { result, providerRequestId: "provider-request-1" };
    },
  };
}

function service(input: {
  bindings?: GitHubProviderBindingStore;
  authority?: GitHubDelegatedReadAuthority;
  adapter?: GitHubDelegatedReadAdapter;
} = {}) {
  return new GitHubDelegatedReadService({
    bindings: input.bindings ?? new FakeBindings(),
    authority: input.authority ?? authority(),
    adapter: input.adapter ?? adapter([]),
    catalogue,
  });
}

function callInput(overrides: Record<string, unknown> = {}) {
  return {
    project: "oauth-dogfood",
    repository,
    tool: "fetch_file",
    arguments: { path: "README.md", ref: "main" },
    actorId: "api-token:test",
    clientId: "mcp:api-token:test",
    catalogueFingerprint: catalogue.registry.fingerprint,
    ...overrides,
  } as Parameters<GitHubDelegatedReadService["call"]>[0];
}

describe("guarded delegated GitHub reads", () => {
  test("dispatches one searchable read through the bound active connection", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const receipt = await service({ adapter: adapter(calls) }).call(callInput());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "fetch_file",
      repositoryFullName: repository,
      connectionId: "ghconn_test",
      installationId: "12345",
      credentialRef: "secret://github/test",
      catalogueFingerprint: catalogue.registry.fingerprint,
    });
    expect(receipt).toMatchObject({
      version: 1,
      project: "oauth-dogfood",
      repositoryFullName: repository,
      tool: "fetch_file",
      connectionId: "ghconn_test",
      bindingId: "ghbind_test",
      capabilityGrantId: "grant_test",
      providerRequestId: "provider-request-1",
      result: { path: "README.md", sha: "abc123" },
    });
    expect(receipt.parametersSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.resultSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("secret://github/test");
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  test("rejects stale catalogue identity before authority or provider dispatch", async () => {
    let authorityCalls = 0;
    let adapterCalls = 0;
    const guarded = service({
      authority: {
        async authorizeGitHubDelegatedRead() {
          authorityCalls += 1;
          return { allowed: true };
        },
      },
      adapter: {
        async callReadTool() {
          adapterCalls += 1;
          return { result: {} };
        },
      },
    });

    await expect(guarded.call(callInput({
      catalogueFingerprint: `sha256:${"0".repeat(64)}`,
    }))).rejects.toBeInstanceOf(GitHubDelegatedCatalogueStaleError);
    expect(authorityCalls).toBe(0);
    expect(adapterCalls).toBe(0);
  });

  test("rejects writes, typed first-party reads, and excluded tools", async () => {
    for (const tool of ["create_issue", "search_issues", "get_pr_reactions"]) {
      await expect(service().call(callInput({ tool })))
        .rejects.toBeInstanceOf(GitHubDelegatedToolDeniedError);
    }
  });

  test("rejects missing, revoked, and repository-mismatched bindings", async () => {
    const cases: GitHubProviderBindingStore[] = [
      new FakeBindings(null, connection()),
      new FakeBindings(binding({ status: "revoked" }), connection()),
      new FakeBindings(binding(), connection({ repositoryFullNames: ["teamleaderleo/other"] })),
      new FakeBindings(binding(), connection({ status: "suspended" })),
    ];
    for (const bindings of cases) {
      await expect(service({ bindings }).call(callInput()))
        .rejects.toBeInstanceOf(GitHubDelegatedBindingError);
    }
  });

  test("fails authority before provider dispatch", async () => {
    let adapterCalls = 0;
    await expect(service({
      authority: authority(false),
      adapter: {
        async callReadTool() {
          adapterCalls += 1;
          return { result: {} };
        },
      },
    }).call(callInput())).rejects.toBeInstanceOf(GitHubDelegatedAuthorityError);
    expect(adapterCalls).toBe(0);
  });

  test("bounds request and provider JSON before returning a receipt", async () => {
    await expect(service().call(callInput({
      arguments: { value: Number.NaN },
    }))).rejects.toThrow("non-finite number");

    await expect(service({
      adapter: adapter([], { value: undefined }),
    }).call(callInput())).rejects.toThrow("non-JSON value");
  });
});
