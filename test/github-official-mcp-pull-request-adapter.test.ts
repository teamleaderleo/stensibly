import { describe, expect, test } from "bun:test";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import {
  GitHubDelegatedCatalogueStaleError,
  GitHubDelegatedReadService,
  type GitHubDelegatedReadAuthority,
} from "../src/github-delegated-read.ts";
import {
  GitHubOfficialMcpPullRequestAdapter,
  type GitHubOfficialMcpPullRequestTransport,
} from "../src/github-official-mcp-pull-request-adapter.ts";
import {
  GitHubOfficialMcpRemoteError,
  type GitHubOfficialMcpRemoteCallInput,
  type GitHubOfficialMcpRemoteCallResult,
} from "../src/github-official-mcp-remote-transport.ts";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
  GitHubProviderProjectReader,
} from "../src/github-provider-contracts.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_official_mcp";
const installationId = "98765";
const credentialRef = "secret://github/official-mcp";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const pullRequestNumber = 42;
const headSha = "d".repeat(40);
const baseSha = "e".repeat(40);

class RecordingTransport implements GitHubOfficialMcpPullRequestTransport {
  readonly calls: GitHubOfficialMcpRemoteCallInput[] = [];

  constructor(
    readonly result: unknown = minimalPullRequestPayload(),
    readonly failure: unknown = null,
  ) {}

  async callMappedRead(
    input: GitHubOfficialMcpRemoteCallInput,
  ): Promise<GitHubOfficialMcpRemoteCallResult> {
    this.calls.push(input);
    if (this.failure !== null) throw this.failure;
    return Object.freeze({ result: this.result });
  }
}

function createAdapter(
  transport: GitHubOfficialMcpPullRequestTransport = new RecordingTransport(),
): GitHubOfficialMcpPullRequestAdapter {
  return new GitHubOfficialMcpPullRequestAdapter({
    transport,
    connectionId,
    installationId,
    credentialRef,
  });
}

function callInput(
  tool = "get_pr_info",
  args: Record<string, unknown> = { pr_number: pullRequestNumber },
) {
  return {
    tool,
    arguments: args,
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

describe("official GitHub MCP pull request result verification", () => {
  test("maps one exact get_pr_info call and retains bounded metadata", async () => {
    const transport = new RecordingTransport();
    const called = await createAdapter(transport).callReadTool(callInput());

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.credentialRef).toBe(credentialRef);
    expect(transport.calls[0]?.mapping).toMatchObject({
      state: "mapped",
      stensiblyTool: "get_pr_info",
      repositoryFullName,
      officialToolset: "pull_requests",
      officialTool: "pull_request_read",
      officialArguments: {
        method: "get",
        owner: "teamleaderleo",
        pullNumber: pullRequestNumber,
        repo: "stensibly",
      },
      resultContract: "pull_request_exact",
      maximumResultItems: 1,
      authorizesProviderCall: false,
    });
    expect(called).toEqual({
      result: {
        repositoryFullName,
        number: pullRequestNumber,
        state: "open",
        draft: false,
        merged: false,
        authorLogin: "teamleaderleo",
        headRepositoryFullName: repositoryFullName,
        headSha,
        headRef: "morrow/815-official-pr-result",
        baseSha,
        baseRef: "main",
        createdAt: "2026-08-02T10:00:00.000Z",
        updatedAt: "2026-08-02T10:05:00.000Z",
        closedAt: null,
        mergedAt: null,
        additions: 120,
        deletions: 12,
        changedFiles: 2,
        commits: 1,
        comments: 4,
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
    const serialized = JSON.stringify(called);
    expect(serialized).not.toContain(credentialRef);
    expect(serialized).not.toContain("api.github");
    expect(serialized).not.toContain("provider prose");
    expect(serialized).not.toContain("verified official pull request read");
  });

  test("preserves fork and omitted deleted-head repository identity", async () => {
    const forkPayload = minimalPullRequestPayload();
    ((forkPayload.head as Record<string, unknown>).repo as Record<string, unknown>)
      .full_name = "Contributor/Stensibly-Fork";
    const fork = await createAdapter(
      new RecordingTransport(forkPayload),
    ).callReadTool(callInput());
    expect((fork.result as Record<string, unknown>).headRepositoryFullName)
      .toBe("contributor/stensibly-fork");

    const deletedPayload = minimalPullRequestPayload();
    delete (deletedPayload.head as Record<string, unknown>).repo;
    const deleted = await createAdapter(
      new RecordingTransport(deletedPayload),
    ).callReadTool(callInput());
    expect((deleted.result as Record<string, unknown>).headRepositoryFullName)
      .toBeNull();
  });

  test("rejects mismatched, missing, duplicate, and inferred identity evidence", async () => {
    const numberMismatch = minimalPullRequestPayload();
    numberMismatch.number = pullRequestNumber + 1;
    await expect(createAdapter(
      new RecordingTransport(numberMismatch),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_identity_mismatch",
    });

    const repositoryMismatch = minimalPullRequestPayload();
    (((repositoryMismatch.base as Record<string, unknown>).repo as Record<string, unknown>))
      .full_name = "teamleaderleo/other";
    await expect(createAdapter(
      new RecordingTransport(repositoryMismatch),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_identity_mismatch",
    });

    const missingRepository = minimalPullRequestPayload();
    delete (missingRepository.base as Record<string, unknown>).repo;
    await expect(createAdapter(
      new RecordingTransport(missingRepository),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    });

    const duplicateRepository = minimalPullRequestPayload();
    duplicateRepository.repository = repositoryFullName;
    await expect(createAdapter(
      new RecordingTransport(duplicateRepository),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    });

    const inferredFromUrlOnly = minimalPullRequestPayload();
    delete (inferredFromUrlOnly.base as Record<string, unknown>).repo;
    inferredFromUrlOnly.html_url =
      "https://github.com/teamleaderleo/stensibly/pull/42";
    await expect(createAdapter(
      new RecordingTransport(inferredFromUrlOnly),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    });
  });

  test("rejects raw REST and multi-result shapes outside the pinned minimal schema", async () => {
    const rawRest = {
      ...minimalPullRequestPayload(),
      id: 987654,
      node_id: "PR_kwDOGitHub",
      locked: false,
      merge_commit_sha: null,
      review_comments: 3,
    };
    await expect(createAdapter(
      new RecordingTransport(rawRest),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    });
    await expect(createAdapter(
      new RecordingTransport([minimalPullRequestPayload()]),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    });
  });

  test("rejects binding, argument, catalogue, and unsupported-tool failures before transport", async () => {
    const transport = new RecordingTransport();
    const adapter = createAdapter(transport);

    await expect(adapter.callReadTool({
      ...callInput(),
      connectionId: "ghconn_other",
    })).rejects.toMatchObject({
      code: "github_delegated_adapter_binding_mismatch",
    });
    await expect(adapter.callReadTool(callInput(
      "get_pr_info",
      { pr_number: 0 },
    ))).rejects.toMatchObject({
      code: "github_delegated_adapter_invalid_input",
    });
    await expect(adapter.callReadTool(callInput(
      "get_pr_info",
      { pr_number: pullRequestNumber, owner: "other" },
    ))).rejects.toMatchObject({
      code: "github_delegated_adapter_invalid_input",
    });
    await expect(adapter.callReadTool({
      ...callInput(),
      catalogueFingerprint: "sha256:not-a-digest",
    })).rejects.toMatchObject({
      code: "github_delegated_adapter_invalid_input",
    });
    await expect(adapter.callReadTool(callInput(
      "get_pr_diff",
      { pr_number: pullRequestNumber, format: "diff" },
    ))).rejects.toMatchObject({
      code: "github_delegated_tool_denied",
    });

    expect(transport.calls).toHaveLength(0);
  });

  test("rejects input and provider accessors without invoking getters", async () => {
    let inputGetterCalls = 0;
    const hostileInput = callInput();
    Object.defineProperty(hostileInput, "tool", {
      enumerable: true,
      get() {
        inputGetterCalls += 1;
        return "get_pr_info";
      },
    });
    const inputTransport = new RecordingTransport();
    await expect(createAdapter(inputTransport).callReadTool(hostileInput))
      .rejects.toMatchObject({
        code: "github_delegated_adapter_invalid_input",
      });
    expect(inputGetterCalls).toBe(0);
    expect(inputTransport.calls).toHaveLength(0);

    let providerGetterCalls = 0;
    const hostileResult = minimalPullRequestPayload();
    Object.defineProperty(hostileResult, "title", {
      enumerable: true,
      get() {
        providerGetterCalls += 1;
        return "secret://must-not-run";
      },
    });
    await expect(createAdapter(
      new RecordingTransport(hostileResult),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    });
    expect(providerGetterCalls).toBe(0);
  });

  test("rejects decorated, oversized, and non-canonical provider graphs", async () => {
    const decorated = minimalPullRequestPayload();
    Object.defineProperty(decorated, "hidden", {
      value: "provider prose",
      enumerable: false,
    });
    await expect(createAdapter(
      new RecordingTransport(decorated),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    });

    const oversized = minimalPullRequestPayload();
    oversized.body = "x".repeat(300_000);
    await expect(createAdapter(
      new RecordingTransport(oversized),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_result_too_large",
    });

    const negativeZero = minimalPullRequestPayload();
    negativeZero.additions = -0;
    await expect(createAdapter(
      new RecordingTransport(negativeZero),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    });
  });

  test("rejects impossible lifecycle and credential-shaped retained identity", async () => {
    const lifecycle = minimalPullRequestPayload();
    lifecycle.state = "open";
    lifecycle.closed_at = "2026-08-02T10:04:00Z";
    await expect(createAdapter(
      new RecordingTransport(lifecycle),
    ).callReadTool(callInput())).rejects.toThrow(
      "lifecycle fields were inconsistent",
    );

    const credentialIdentity = minimalPullRequestPayload();
    (credentialIdentity.user as Record<string, unknown>).login =
      `github_pat_${"a".repeat(24)}`;
    await expect(createAdapter(
      new RecordingTransport(credentialIdentity),
    ).callReadTool(callInput())).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    });
  });

  test("discards credential-shaped and multiline upstream prose", async () => {
    const prose = minimalPullRequestPayload();
    prose.title = `github_pat_${"a".repeat(24)}`;
    prose.body = `first line\nsecret://${"x".repeat(32)}\nlast line`;
    ((prose.base as Record<string, unknown>).repo as Record<string, unknown>)
      .description = "line one\nline two";

    const called = await createAdapter(
      new RecordingTransport(prose),
    ).callReadTool(callInput());
    const serialized = JSON.stringify(called);
    expect(serialized).not.toContain("github_pat_");
    expect(serialized).not.toContain("secret://");
    expect(serialized).not.toContain("line one");
  });

  test("converts remote failures to fixed privacy-safe delegated errors", async () => {
    const transport = new RecordingTransport(
      minimalPullRequestPayload(),
      new GitHubOfficialMcpRemoteError(
        "github_official_mcp_transport_failed",
        "Official GitHub MCP read failed before a verified result was available",
      ),
    );
    const error = await capturedError(() =>
      createAdapter(transport).callReadTool(callInput())
    );
    expect(error.code).toBe("github_official_mcp_transport_failed");
    expect(error.message).toBe(
      "Official GitHub MCP read failed before a verified result was available",
    );
    expect(error.message).not.toContain("github_pat_transport_secret_1234567890");
  });

  test("produces one attributable frozen delegated-service receipt", async () => {
    const catalogue = new GitHubCapabilityCatalogueService();
    const transport = new RecordingTransport();
    const adapter = createAdapter(transport);
    const service = new GitHubDelegatedReadService({
      projects: new FakeProjects(),
      bindings: new FakeBindings(),
      authority: delegatedAuthority(),
      adapter,
      catalogue,
    });

    const receipt = await service.call({
      project: "oauth-dogfood",
      repository: repositoryFullName,
      tool: "get_pr_info",
      arguments: { pr_number: pullRequestNumber },
      actorId: "api-token:test",
      clientId: "mcp:api-token:test",
      catalogueFingerprint: catalogue.registry.fingerprint,
    });

    expect(transport.calls).toHaveLength(1);
    expect(receipt).toMatchObject({
      version: 1,
      project: "oauth-dogfood",
      repositoryFullName,
      tool: "get_pr_info",
      actorId: "api-token:test",
      clientId: "mcp:api-token:test",
      connectionId,
      installationId,
      bindingId: "ghbind_official_mcp",
      attachmentId: acceptedAttachment.id,
      capabilityGrantId: "grant_official_mcp",
      providerRequestId: null,
      result: {
        repositoryFullName,
        number: pullRequestNumber,
      },
    });
    expect(receipt.parametersSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.resultSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.result)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(credentialRef);

    let laterTransportCalls = 0;
    const staleService = new GitHubDelegatedReadService({
      projects: new FakeProjects(),
      bindings: new FakeBindings(),
      authority: delegatedAuthority(),
      adapter: {
        async callReadTool() {
          laterTransportCalls += 1;
          return { result: {} };
        },
      },
      catalogue,
    });
    await expect(staleService.call({
      project: "oauth-dogfood",
      repository: repositoryFullName,
      tool: "get_pr_info",
      arguments: { pr_number: pullRequestNumber },
      actorId: "api-token:test",
      clientId: "mcp:api-token:test",
      catalogueFingerprint: `sha256:${"0".repeat(64)}`,
    })).rejects.toBeInstanceOf(GitHubDelegatedCatalogueStaleError);
    expect(laterTransportCalls).toBe(0);
  });
});

function minimalPullRequestPayload(): Record<string, unknown> {
  return {
    number: pullRequestNumber,
    title: "Add one verified official pull request read",
    body: "\nUnretained provider prose with ordinary line breaks.\n",
    state: "open",
    draft: false,
    merged: false,
    mergeable_state: "clean",
    html_url: "https://github.com/teamleaderleo/stensibly/pull/42",
    user: {
      login: "teamleaderleo",
      id: 13091533,
      profile_url: "https://github.com/teamleaderleo",
      avatar_url: "https://avatars.githubusercontent.com/u/13091533",
    },
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    requested_reviewers: ["reviewer"],
    head: {
      ref: "morrow/815-official-pr-result",
      sha: headSha,
      repo: {
        full_name: "TeamLeaderLeo/Stensibly",
        description: "Unretained repository\nprose.",
      },
    },
    base: {
      ref: "main",
      sha: baseSha,
      repo: {
        full_name: "TeamLeaderLeo/Stensibly",
        description: "Unretained repository\nprose.",
      },
    },
    additions: 120,
    deletions: 12,
    changed_files: 2,
    commits: 1,
    comments: 4,
    created_at: "2026-08-02T10:00:00Z",
    updated_at: "2026-08-02T10:05:00Z",
  };
}

async function capturedError(
  run: () => Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      return {
        message: error.message,
        ...("code" in error && typeof error.code === "string"
          ? { code: error.code }
          : {}),
      };
    }
  }
  throw new Error("Expected operation to fail");
}

const snapshot = compileProjectContract(renderProjectContract({
  version: 1,
  project: "oauth-dogfood",
  repositories: [repositoryFullName],
  runnerProfiles: [],
  concurrency: { project: 1, global: 1 },
  autonomousActions: ["inspect"],
  approvalRequired: ["write"],
  checks: [],
  tags: [],
  relatedProjects: [],
}, {
  goal: "Exercise official GitHub MCP PR verification.",
  boundaries: "Keep provider identity bound to accepted policy.",
  evidenceAndHandoff: "Return bounded provider evidence.",
  escalation: "Stop when binding or authority changes.",
}));
const acceptedAttachment: ProjectAttachmentRecord = {
  id: "attachment_official_mcp",
  project: "oauth-dogfood",
  snapshot,
  sourceRevision: "main@official-mcp-pr-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-02T10:00:00.000Z",
};

function connection(): GitHubProviderConnection {
  return {
    id: connectionId,
    provider: "github",
    installationId,
    accountLogin: "teamleaderleo",
    credentialRef,
    status: "active",
    repositoryFullNames: [repositoryFullName],
    observedAt: "2026-08-02T10:00:00.000Z",
  };
}

function binding(): GitHubProjectRepositoryBinding {
  return {
    id: "ghbind_official_mcp",
    project: "oauth-dogfood",
    repositoryFullName,
    connectionId,
    attachmentId: acceptedAttachment.id,
    attachmentSnapshotSha256: acceptedAttachment.snapshot.snapshotSha256,
    status: "active",
    acceptedAt: "2026-08-02T10:00:00.000Z",
  };
}

class FakeProjects implements GitHubProviderProjectReader {
  async getProjectAttachment(project: string): Promise<ProjectAttachmentRecord | null> {
    return project === acceptedAttachment.project ? acceptedAttachment : null;
  }
}

class FakeBindings implements GitHubProviderBindingStore {
  async getGitHubProjectRepositoryBinding(
    project: string,
    repository: string,
  ): Promise<GitHubProjectRepositoryBinding | null> {
    return project === "oauth-dogfood" && repository === repositoryFullName
      ? binding()
      : null;
  }

  async getGitHubProviderConnection(
    id: string,
  ): Promise<GitHubProviderConnection | null> {
    return id === connectionId ? connection() : null;
  }
}

function delegatedAuthority(): GitHubDelegatedReadAuthority {
  return {
    async authorizeGitHubDelegatedRead() {
      return {
        allowed: true,
        capabilityGrantId: "grant_official_mcp",
      };
    },
  };
}
