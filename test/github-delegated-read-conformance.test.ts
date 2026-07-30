import { describe, expect, test } from "bun:test";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import {
  GitHubDelegatedReadService,
  type GitHubDelegatedReadAuthority,
} from "../src/github-delegated-read.ts";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
} from "../src/github-provider-contracts.ts";
import { FakeGitHubDelegatedReadAdapter } from "./support/github-delegated-read-fake.ts";

const repository = "teamleaderleo/stensibly";
const catalogue = new GitHubCapabilityCatalogueService();

class FixedBindings implements GitHubProviderBindingStore {
  readonly binding: GitHubProjectRepositoryBinding = {
    id: "ghbind_conformance",
    project: "oauth-dogfood",
    repositoryFullName: repository,
    connectionId: "ghconn_conformance",
    attachmentId: "attachment_conformance",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    status: "active",
    acceptedAt: "2026-07-31T00:00:00.000Z",
  };

  readonly connection: GitHubProviderConnection = {
    id: "ghconn_conformance",
    provider: "github",
    installationId: "98765",
    accountLogin: "teamleaderleo",
    credentialRef: "secret://github/conformance",
    status: "active",
    repositoryFullNames: [repository],
    observedAt: "2026-07-31T00:00:00.000Z",
  };

  async getGitHubProjectRepositoryBinding(
    project: string,
    repositoryFullName: string,
  ): Promise<GitHubProjectRepositoryBinding | null> {
    return project === this.binding.project && repositoryFullName === repository
      ? this.binding
      : null;
  }

  async getGitHubProviderConnection(id: string): Promise<GitHubProviderConnection | null> {
    return id === this.connection.id ? this.connection : null;
  }
}

const authority: GitHubDelegatedReadAuthority = {
  async authorizeGitHubDelegatedRead() {
    return {
      allowed: true,
      capabilityGrantId: "grant_conformance",
      approvalId: "approval_conformance",
    };
  },
};

function service(adapter: FakeGitHubDelegatedReadAdapter): GitHubDelegatedReadService {
  return new GitHubDelegatedReadService({
    bindings: new FixedBindings(),
    authority,
    adapter,
    catalogue,
  });
}

function input() {
  return {
    project: "oauth-dogfood",
    repository,
    tool: "fetch_file",
    arguments: { path: "README.md", ref: "main" },
    actorId: "agent:rook",
    clientId: "mcp:conformance",
    catalogueFingerprint: catalogue.registry.fingerprint,
  };
}

describe("delegated GitHub read provider conformance", () => {
  test("binds the exact official-MCP call envelope to an attributable receipt", async () => {
    const adapter = new FakeGitHubDelegatedReadAdapter();
    adapter.enqueueResponse("fetch_file", {
      result: { path: "README.md", sha: "abc123" },
      providerRequestId: "provider-conformance-1",
    });

    const receipt = await service(adapter).call(input());

    expect(adapter.calls).toEqual([{
      tool: "fetch_file",
      arguments: { path: "README.md", ref: "main" },
      repositoryFullName: repository,
      connectionId: "ghconn_conformance",
      installationId: "98765",
      credentialRef: "secret://github/conformance",
      catalogueFingerprint: catalogue.registry.fingerprint,
    }]);
    expect(receipt).toMatchObject({
      project: "oauth-dogfood",
      repositoryFullName: repository,
      tool: "fetch_file",
      actorId: "agent:rook",
      clientId: "mcp:conformance",
      connectionId: "ghconn_conformance",
      bindingId: "ghbind_conformance",
      capabilityGrantId: "grant_conformance",
      approvalId: "approval_conformance",
      providerRequestId: "provider-conformance-1",
      result: { path: "README.md", sha: "abc123" },
    });
    expect(JSON.stringify(receipt)).not.toContain("secret://github/conformance");
  });

  test("snapshots calls and configured results across caller mutation", async () => {
    const adapter = new FakeGitHubDelegatedReadAdapter();
    const providerResult = { files: [{ path: "README.md" }] };
    adapter.enqueueResponse("fetch_file", { result: providerResult });
    providerResult.files[0]!.path = "mutated-before-call";

    const call = input();
    const receipt = await service(adapter).call(call);
    call.arguments.path = "mutated-after-call";

    expect(adapter.calls[0]?.arguments).toEqual({ path: "README.md", ref: "main" });
    expect(receipt.result).toEqual({ files: [{ path: "README.md" }] });
  });

  test("fails closed for an unconfigured upstream capability", async () => {
    const adapter = new FakeGitHubDelegatedReadAdapter();

    await expect(service(adapter).call(input())).rejects.toThrow(
      "No fake GitHub delegated-read outcome configured for fetch_file",
    );
    expect(adapter.calls).toHaveLength(1);
  });

  test("preserves provider failure and permits an explicit later retry", async () => {
    const adapter = new FakeGitHubDelegatedReadAdapter();
    adapter.enqueueError("fetch_file", new Error("provider unavailable"));
    adapter.enqueueResponse("fetch_file", {
      result: { path: "README.md", sha: "recovered" },
      providerRequestId: "provider-conformance-2",
    });

    await expect(service(adapter).call(input())).rejects.toThrow("provider unavailable");
    const receipt = await service(adapter).call(input());

    expect(adapter.calls).toHaveLength(2);
    expect(receipt.providerRequestId).toBe("provider-conformance-2");
    expect(receipt.result).toEqual({ path: "README.md", sha: "recovered" });
  });
});
