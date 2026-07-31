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
import { GitHubDelegatedReadContractError } from "../src/github-delegated-read-contracts.ts";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
  GitHubProviderProjectReader,
} from "../src/github-provider-contracts.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";

const catalogue = new GitHubCapabilityCatalogueService();
const repository = "teamleaderleo/stensibly";
const commitSha = "a".repeat(40);
const snapshot = compileProjectContract(renderProjectContract({
  version: 1,
  project: "oauth-dogfood",
  repositories: [repository],
  runnerProfiles: [],
  concurrency: { project: 1, global: 1 },
  autonomousActions: ["inspect"],
  approvalRequired: ["write"],
  checks: [],
  tags: [],
  relatedProjects: [],
}, {
  goal: "Exercise guarded delegated GitHub reads.",
  boundaries: "Keep repository identity bound to accepted policy.",
  evidenceAndHandoff: "Return bounded provider evidence.",
  escalation: "Stop when binding or authority changes.",
}));
const acceptedAttachment: ProjectAttachmentRecord = {
  id: "attachment_test",
  project: "oauth-dogfood",
  snapshot,
  sourceRevision: "main@delegated-read-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-07-30T18:00:00.000Z",
};

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
    attachmentId: acceptedAttachment.id,
    attachmentSnapshotSha256: acceptedAttachment.snapshot.snapshotSha256,
    status: "active",
    acceptedAt: "2026-07-30T18:00:00.000Z",
    ...overrides,
  };
}

class FakeProjects implements GitHubProviderProjectReader {
  constructor(readonly attachment: ProjectAttachmentRecord | null = acceptedAttachment) {}

  async getProjectAttachment(project: string): Promise<ProjectAttachmentRecord | null> {
    return this.attachment?.project === project ? this.attachment : null;
  }
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
  projects?: GitHubProviderProjectReader;
  bindings?: GitHubProviderBindingStore;
  authority?: GitHubDelegatedReadAuthority;
  adapter?: GitHubDelegatedReadAdapter;
} = {}) {
  return new GitHubDelegatedReadService({
    projects: input.projects ?? new FakeProjects(),
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
    arguments: { path: "README.md", ref: commitSha },
    actorId: "api-token:test",
    clientId: "mcp:api-token:test",
    catalogueFingerprint: catalogue.registry.fingerprint,
    ...overrides,
  } as Parameters<GitHubDelegatedReadService["call"]>[0];
}

describe("guarded delegated GitHub reads", () => {
  test("dispatches one contracted read through the current accepted binding", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const receipt = await service({ adapter: adapter(calls) }).call(callInput());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "fetch_file",
      arguments: { path: "README.md", ref: commitSha },
      repositoryFullName: repository,
      connectionId: "ghconn_test",
      installationId: "12345",
      credentialRef: "secret://github/test",
      catalogueFingerprint: catalogue.registry.fingerprint,
    });
    expect(Object.isFrozen(calls[0]?.arguments)).toBe(true);
    expect(receipt).toMatchObject({
      version: 1,
      project: "oauth-dogfood",
      repositoryFullName: repository,
      tool: "fetch_file",
      connectionId: "ghconn_test",
      bindingId: "ghbind_test",
      attachmentId: acceptedAttachment.id,
      attachmentSnapshotSha256: acceptedAttachment.snapshot.snapshotSha256,
      capabilityGrantId: "grant_test",
      providerRequestId: "provider-request-1",
      result: { path: "README.md", sha: "abc123" },
    });
    expect(receipt.parametersSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.resultSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("secret://github/test");
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.result)).toBe(true);
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

  test("rejects writes, typed reads, excluded tools, and uncontracted delegated reads", async () => {
    for (const tool of [
      "create_issue",
      "search_issues",
      "get_pr_reactions",
      "fetch_commit",
    ]) {
      await expect(service().call(callInput({ tool })))
        .rejects.toBeInstanceOf(GitHubDelegatedToolDeniedError);
    }
  });

  test("rejects caller repository selectors and unknown tool arguments", async () => {
    await expect(service().call(callInput({
      arguments: { path: "README.md", ref: commitSha, repository_full_name: "other/repo" },
    }))).rejects.toBeInstanceOf(GitHubDelegatedReadContractError);
    await expect(service().call(callInput({
      arguments: { path: "README.md", ref: commitSha, recursive: true },
    }))).rejects.toThrow("recursive is unsupported");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(service().call(callInput({
      arguments: { path: "README.md", ref: commitSha, recursive: cyclic },
    }))).rejects.toThrow("recursive is unsupported");

    await expect(service().call(callInput({
      arguments: { path: "../README.md", ref: commitSha },
    }))).rejects.toThrow("canonical relative path");
  });

  test("requires exact immutable identities before provider dispatch", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const uppercaseSha = "ABCDEF1234567890ABCDEF1234567890ABCDEF12";
    await service({ adapter: adapter(calls) }).call(callInput({
      tool: "fetch_commit_workflow_runs",
      arguments: { commit_sha: uppercaseSha },
    }));
    expect(calls[0]?.arguments).toEqual({
      commit_sha: uppercaseSha.toLowerCase(),
    });

    for (const commit_sha of ["ABCDEF1234567", ` ${uppercaseSha}`, `${uppercaseSha} `]) {
      await expect(service().call(callInput({
        tool: "fetch_commit_workflow_runs",
        arguments: { commit_sha },
      }))).rejects.toThrow("exactly 40 hexadecimal characters");
    }
    for (const tool of [" fetch_file", "fetch_file ", "ｆetch_file"]) {
      await expect(service().call(callInput({ tool }))).rejects.toThrow();
    }
    await expect(service().call(callInput({
      arguments: { path: "README.md", ref: "main" },
    }))).rejects.toThrow("exactly 40 hexadecimal characters");
  });

  test("rejects missing, revoked, repository-mismatched, and stale bindings", async () => {
    const cases: Array<{
      projects?: GitHubProviderProjectReader;
      bindings?: GitHubProviderBindingStore;
    }> = [
      { projects: new FakeProjects(null) },
      { bindings: new FakeBindings(null, connection()) },
      { bindings: new FakeBindings(binding({ status: "revoked" }), connection()) },
      { bindings: new FakeBindings(binding(), connection({ repositoryFullNames: ["teamleaderleo/other"] })) },
      { bindings: new FakeBindings(binding(), connection({ status: "suspended" })) },
      { bindings: new FakeBindings(binding({ attachmentId: "attachment_stale" }), connection()) },
      {
        projects: new FakeProjects({
          ...acceptedAttachment,
          snapshot: compileProjectContract(renderProjectContract({
            ...snapshot.contract,
            repositories: ["teamleaderleo/other"],
          }, snapshot.context)),
        }),
      },
    ];
    for (const candidate of cases) {
      await expect(service(candidate).call(callInput()))
        .rejects.toBeInstanceOf(GitHubDelegatedBindingError);
    }
  });

  test("rejects a binding store response whose identity differs from the query", async () => {
    const mismatched: GitHubProviderBindingStore = {
      async getGitHubProjectRepositoryBinding() {
        return binding({ project: "other-project" });
      },
      async getGitHubProviderConnection() {
        return connection();
      },
    };
    await expect(service({ bindings: mismatched }).call(callInput()))
      .rejects.toBeInstanceOf(GitHubDelegatedBindingError);
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

  test("rejects provider result accessors and decorated graphs without invocation", async () => {
    let reads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        return "credential";
      },
    });
    await expect(service({ adapter: adapter([], accessor) }).call(callInput()))
      .rejects.toThrow("field secret must be an enumerable data property");
    expect(reads).toBe(0);

    const hidden = { value: 1 };
    Object.defineProperty(hidden, "secret", { value: "credential" });
    await expect(service({ adapter: adapter([], hidden) }).call(callInput()))
      .rejects.toThrow("field secret must be an enumerable data property");

    const symbolic = { value: 1 };
    Object.defineProperty(symbolic, Symbol("secret"), { value: "credential" });
    await expect(service({ adapter: adapter([], symbolic) }).call(callInput()))
      .rejects.toThrow("objects contain a symbol field");

    const custom = Object.assign(Object.create({ inherited: true }), { value: 1 });
    await expect(service({ adapter: adapter([], custom) }).call(callInput()))
      .rejects.toThrow("objects must be plain JSON objects");
  });

  test("deeply freezes the admitted provider result graph", async () => {
    const receipt = await service({
      adapter: adapter([], {
        nested: {
          values: [{ ok: true }],
        },
      }),
    }).call(callInput());
    const result = receipt.result as {
      nested: { values: Array<{ ok: boolean }> };
    };

    expect(result).toEqual({ nested: { values: [{ ok: true }] } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nested)).toBe(true);
    expect(Object.isFrozen(result.nested.values)).toBe(true);
    expect(Object.isFrozen(result.nested.values[0])).toBe(true);
    expect(() => result.nested.values.push({ ok: false })).toThrow();
    expect(() => {
      result.nested.values[0]!.ok = false;
    }).toThrow();
  });

  test("bounds request and provider JSON before returning a receipt", async () => {
    await expect(service().call(callInput({
      arguments: { path: Number.NaN, ref: commitSha },
    }))).rejects.toThrow("non-JSON value");

    await expect(service({
      adapter: adapter([], { value: undefined }),
    }).call(callInput())).rejects.toThrow("non-JSON value");
  });
});
