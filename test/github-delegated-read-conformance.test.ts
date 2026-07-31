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
  GitHubProviderProjectReader,
} from "../src/github-provider-contracts.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import { FakeGitHubDelegatedReadAdapter } from "./support/github-delegated-read-fake.ts";

const repository = "teamleaderleo/stensibly";
const project = "oauth-dogfood";
const commitSha = "a".repeat(40);
const catalogue = new GitHubCapabilityCatalogueService();
const snapshot = compileProjectContract(renderProjectContract({
  version: 1,
  project,
  repositories: [repository],
  runnerProfiles: [],
  concurrency: { project: 1, global: 1 },
  autonomousActions: ["inspect"],
  approvalRequired: ["write"],
  checks: [],
  tags: [],
  relatedProjects: [],
}, {
  goal: "Conform delegated GitHub reads.",
  boundaries: "Keep repository authority explicit.",
  evidenceAndHandoff: "Return attributable bounded receipts.",
  escalation: "Stop on stale binding or provider ambiguity.",
}));
const attachment: ProjectAttachmentRecord = {
  id: "attachment_conformance",
  project,
  snapshot,
  sourceRevision: "main@delegated-conformance",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-07-31T00:00:00.000Z",
};

class FixedProjects implements GitHubProviderProjectReader {
  async getProjectAttachment(requestedProject: string) {
    return requestedProject === project ? attachment : null;
  }
}

class FixedBindings implements GitHubProviderBindingStore {
  readonly binding: GitHubProjectRepositoryBinding = {
    id: "ghbind_conformance",
    project,
    repositoryFullName: repository,
    connectionId: "ghconn_conformance",
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
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
    requestedProject: string,
    repositoryFullName: string,
  ): Promise<GitHubProjectRepositoryBinding | null> {
    return requestedProject === project && repositoryFullName === repository
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
    projects: new FixedProjects(),
    bindings: new FixedBindings(),
    authority,
    adapter,
    catalogue,
  });
}

function input() {
  return {
    project,
    repository,
    tool: "fetch_file",
    arguments: { path: "README.md", ref: commitSha },
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
      arguments: { path: "README.md", ref: commitSha },
      repositoryFullName: repository,
      connectionId: "ghconn_conformance",
      installationId: "98765",
      credentialRef: "secret://github/conformance",
      catalogueFingerprint: catalogue.registry.fingerprint,
    }]);
    expect(receipt).toMatchObject({
      project,
      repositoryFullName: repository,
      tool: "fetch_file",
      actorId: "agent:rook",
      clientId: "mcp:conformance",
      connectionId: "ghconn_conformance",
      bindingId: "ghbind_conformance",
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
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

    expect(adapter.calls[0]?.arguments).toEqual({ path: "README.md", ref: commitSha });
    expect(receipt.result).toEqual({ files: [{ path: "README.md" }] });
    expect(Object.isFrozen(receipt.result)).toBe(true);
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
