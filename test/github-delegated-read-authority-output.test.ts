import { describe, expect, test } from "bun:test";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import {
  GitHubDelegatedAuthorityError,
  GitHubDelegatedReadService,
  type GitHubDelegatedReadAdapter,
  type GitHubDelegatedReadAuthority,
  type GitHubDelegatedReadAuthorityDecision,
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

const catalogue = new GitHubCapabilityCatalogueService();
const project = "oauth-dogfood";
const repository = "teamleaderleo/stensibly";
const commitSha = "a".repeat(40);
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
  goal: "Exercise authority-output admission for delegated GitHub reads.",
  boundaries: "Keep authority metadata bounded before receipt publication.",
  evidenceAndHandoff: "Return only admitted authority identities.",
  escalation: "Stop before provider dispatch when authority output is malformed.",
}));
const attachment: ProjectAttachmentRecord = {
  id: "attachment_authority_output",
  project,
  snapshot,
  sourceRevision: "main@authority-output-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-07-31T10:00:00.000Z",
};
const connection: GitHubProviderConnection = {
  id: "ghconn_authority_output",
  provider: "github",
  installationId: "12345",
  accountLogin: "teamleaderleo",
  credentialRef: "secret://github/test",
  status: "active",
  repositoryFullNames: [repository],
  observedAt: "2026-07-31T10:00:00.000Z",
};
const binding: GitHubProjectRepositoryBinding = {
  id: "ghbind_authority_output",
  project,
  repositoryFullName: repository,
  connectionId: connection.id,
  attachmentId: attachment.id,
  attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
  status: "active",
  acceptedAt: "2026-07-31T10:00:00.000Z",
};

class Projects implements GitHubProviderProjectReader {
  async getProjectAttachment(value: string): Promise<ProjectAttachmentRecord | null> {
    return value === project ? attachment : null;
  }
}

class Bindings implements GitHubProviderBindingStore {
  async getGitHubProjectRepositoryBinding(
    valueProject: string,
    valueRepository: string,
  ): Promise<GitHubProjectRepositoryBinding | null> {
    return valueProject === project && valueRepository === repository
      ? binding
      : null;
  }

  async getGitHubProviderConnection(
    id: string,
  ): Promise<GitHubProviderConnection | null> {
    return id === connection.id ? connection : null;
  }
}

function createService(
  decision: GitHubDelegatedReadAuthorityDecision,
  adapterCalls: { value: number },
  authorityCalls: { value: number } = { value: 0 },
): GitHubDelegatedReadService {
  const authority: GitHubDelegatedReadAuthority = {
    async authorizeGitHubDelegatedRead() {
      authorityCalls.value += 1;
      return decision;
    },
  };
  const adapter: GitHubDelegatedReadAdapter = {
    async callReadTool() {
      adapterCalls.value += 1;
      return {
        result: { path: "README.md", sha: commitSha },
        providerRequestId: "provider-request-authority-output",
      };
    },
  };
  return new GitHubDelegatedReadService({
    projects: new Projects(),
    bindings: new Bindings(),
    authority,
    adapter,
    catalogue,
  });
}

function callInput(overrides: Record<string, unknown> = {}) {
  return {
    project,
    repository,
    tool: "fetch_file",
    arguments: { path: "README.md", ref: commitSha },
    actorId: "api-token:test",
    clientId: "mcp:api-token:test",
    catalogueFingerprint: catalogue.registry.fingerprint,
    ...overrides,
  } as Parameters<GitHubDelegatedReadService["call"]>[0];
}

async function rejectedAuthorityError(
  decision: GitHubDelegatedReadAuthorityDecision,
  adapterCalls: { value: number },
): Promise<Error> {
  let error: unknown;
  try {
    await createService(decision, adapterCalls).call(callInput());
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GitHubDelegatedAuthorityError);
  return error as Error;
}

describe("delegated GitHub authority output admission", () => {
  test("publishes exact safe authority-returned identities", async () => {
    const adapterCalls = { value: 0 };
    const receipt = await createService({
      allowed: true,
      capabilityGrantId: "grant:authority/v1-2_3.4",
      approvalId: "approval:authority/v1-2_3.4",
    }, adapterCalls).call(callInput({
      capabilityGrantId: "grant:caller/v1-2_3.4",
      approvalId: "approval:caller/v1-2_3.4",
    }));

    expect(adapterCalls.value).toBe(1);
    expect(receipt.capabilityGrantId).toBe("grant:authority/v1-2_3.4");
    expect(receipt.approvalId).toBe("approval:authority/v1-2_3.4");
  });

  test("drops caller identity claims when authority omits them", async () => {
    const adapterCalls = { value: 0 };
    const receipt = await createService({ allowed: true }, adapterCalls).call(
      callInput({
        capabilityGrantId: "grant_caller",
        approvalId: "approval_caller",
      }),
    );

    expect(adapterCalls.value).toBe(1);
    expect(receipt.capabilityGrantId).toBeNull();
    expect(receipt.approvalId).toBeNull();
  });

  test("rejects explicit empty caller identities before authority or provider dispatch", async () => {
    for (const overrides of [
      { capabilityGrantId: "" },
      { approvalId: "" },
    ]) {
      const adapterCalls = { value: 0 };
      const authorityCalls = { value: 0 };
      let error: unknown;
      try {
        await createService(
          { allowed: true },
          adapterCalls,
          authorityCalls,
        ).call(callInput(overrides));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RangeError);
      expect(authorityCalls.value).toBe(0);
      expect(adapterCalls.value).toBe(0);
    }
  });

  test("rejects authority accessors without invocation or provider dispatch", async () => {
    let getterReads = 0;
    const decision = { allowed: true } as Record<string, unknown>;
    Object.defineProperty(decision, "capabilityGrantId", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "grant_accessor";
      },
    });
    const adapterCalls = { value: 0 };
    const error = await rejectedAuthorityError(
      decision as unknown as GitHubDelegatedReadAuthorityDecision,
      adapterCalls,
    );

    expect(error.message).toBe(
      "GitHub delegated read authority response is invalid",
    );
    expect(getterReads).toBe(0);
    expect(adapterCalls.value).toBe(0);
  });

  test("rejects oversized and secret-shaped authority identities before dispatch", async () => {
    for (const decision of [
      { allowed: true, capabilityGrantId: "x".repeat(241) },
      { allowed: true, capabilityGrantId: "secret://github/private-key" },
      { allowed: true, approvalId: "env://GITHUB_TOKEN" },
      { allowed: true, capabilityGrantId: `github_pat_${"a".repeat(24)}` },
      { allowed: true, capabilityGrantId: `ghp_${"a".repeat(24)}` },
      { allowed: true, approvalId: `stn.tok_${"a".repeat(24)}` },
      { allowed: true, approvalId: `sk-proj-${"a".repeat(24)}` },
      { allowed: true, approvalId: `xoxb-${"a".repeat(24)}` },
      { allowed: true, capabilityGrantId: `grant:github_pat_${"a".repeat(24)}` },
      { allowed: true, capabilityGrantId: `approval/ghp_${"a".repeat(24)}` },
      { allowed: true, approvalId: `grant:stn.tok_${"a".repeat(24)}` },
      { allowed: true, approvalId: `approval:sk-proj-${"a".repeat(24)}` },
      { allowed: true, approvalId: `grant/xoxb-${"a".repeat(24)}` },
    ] satisfies GitHubDelegatedReadAuthorityDecision[]) {
      const adapterCalls = { value: 0 };
      const error = await rejectedAuthorityError(decision, adapterCalls);
      expect(error.message).toBe(
        "GitHub delegated read authority response is invalid",
      );
      expect(adapterCalls.value).toBe(0);
    }
  });

  test("rejects secret-shaped caller identities before authority or provider dispatch", async () => {
    for (const overrides of [
      { capabilityGrantId: `github_pat_${"a".repeat(24)}` },
      { capabilityGrantId: `ghp_${"a".repeat(24)}` },
      { approvalId: `stn.tok_${"a".repeat(24)}` },
      { approvalId: `sk-proj-${"a".repeat(24)}` },
      { approvalId: `xoxb-${"a".repeat(24)}` },
      { capabilityGrantId: `grant:github_pat_${"a".repeat(24)}` },
      { capabilityGrantId: `approval/ghp_${"a".repeat(24)}` },
      { approvalId: `grant:stn.tok_${"a".repeat(24)}` },
      { approvalId: `approval:sk-proj-${"a".repeat(24)}` },
      { approvalId: `grant/xoxb-${"a".repeat(24)}` },
    ]) {
      const adapterCalls = { value: 0 };
      const authorityCalls = { value: 0 };
      let error: unknown;
      try {
        await createService(
          { allowed: true },
          adapterCalls,
          authorityCalls,
        ).call(callInput(overrides));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toContain("cannot be secret-shaped");
      expect(authorityCalls.value).toBe(0);
      expect(adapterCalls.value).toBe(0);
    }
  });

  test("rejects padded and full-width caller identity aliases before authority", async () => {
    for (const overrides of [
      { capabilityGrantId: " grant_safe" },
      { capabilityGrantId: "grant_safe " },
      { approvalId: "ａｐｐｒｏｖａｌ" },
    ]) {
      const adapterCalls = { value: 0 };
      const authorityCalls = { value: 0 };
      let error: unknown;
      try {
        await createService(
          { allowed: true },
          adapterCalls,
          authorityCalls,
        ).call(callInput(overrides));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RangeError);
      expect(authorityCalls.value).toBe(0);
      expect(adapterCalls.value).toBe(0);
    }
  });

  test("rejects padded and full-width authority identity aliases before dispatch", async () => {
    for (const decision of [
      { allowed: true, capabilityGrantId: " grant_safe" },
      { allowed: true, capabilityGrantId: "grant_safe " },
      { allowed: true, approvalId: "ａｐｐｒｏｖａｌ" },
    ] satisfies GitHubDelegatedReadAuthorityDecision[]) {
      const adapterCalls = { value: 0 };
      const error = await rejectedAuthorityError(decision, adapterCalls);
      expect(error.message).toBe(
        "GitHub delegated read authority response is invalid",
      );
      expect(adapterCalls.value).toBe(0);
    }
  });

  test("hides arbitrary authority field names behind fixed diagnostics", async () => {
    const privateField = "secret://github/private-key";
    const decision = {
      allowed: true,
      [privateField]: "credential",
    } as unknown as GitHubDelegatedReadAuthorityDecision;
    const adapterCalls = { value: 0 };
    const error = await rejectedAuthorityError(decision, adapterCalls);

    expect(error.message).toBe(
      "GitHub delegated read authority response is invalid",
    );
    expect(error.message).not.toContain(privateField);
    expect(adapterCalls.value).toBe(0);
  });

  test("uses fixed denial prose and keeps authority text out of errors", async () => {
    const adapterCalls = { value: 0 };
    const error = await rejectedAuthorityError({
      allowed: false,
      reason: "secret://github/private-key",
    }, adapterCalls);

    expect(error.message).toBe(
      "GitHub delegated read authority denied",
    );
    expect(error.message).not.toContain("private-key");
    expect(adapterCalls.value).toBe(0);
  });

  test("rejects denied decisions that carry grant or approval authority", async () => {
    for (const decision of [
      { allowed: false, capabilityGrantId: "grant_denied" },
      { allowed: false, approvalId: "approval_denied" },
    ] satisfies GitHubDelegatedReadAuthorityDecision[]) {
      const adapterCalls = { value: 0 };
      const error = await rejectedAuthorityError(decision, adapterCalls);
      expect(error.message).toBe(
        "GitHub delegated read authority response is invalid",
      );
      expect(adapterCalls.value).toBe(0);
    }
  });
});