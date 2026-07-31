import { describe, expect, test } from "bun:test";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import {
  GitHubDelegatedBindingError,
  GitHubDelegatedReadService,
  type GitHubDelegatedReadAdapter,
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
  goal: "Exercise the shared GitHub binding admission boundary.",
  boundaries: "Keep repository identity bound to accepted policy.",
  evidenceAndHandoff: "Return bounded provider evidence.",
  escalation: "Stop when binding or authority changes.",
}));
const attachment: ProjectAttachmentRecord = {
  id: "attachment_shared_admission",
  project: "oauth-dogfood",
  snapshot,
  sourceRevision: "main@shared-admission-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-07-31T02:00:00.000Z",
};

function validBinding(
  overrides: Record<string, unknown> = {},
): GitHubProjectRepositoryBinding {
  return {
    id: "ghbind_shared_admission",
    project: "oauth-dogfood",
    repositoryFullName: repository,
    connectionId: "ghconn_shared_admission",
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    status: "active",
    acceptedAt: "2026-07-31T02:00:00.000Z",
    ...overrides,
  } as GitHubProjectRepositoryBinding;
}

function validConnection(
  overrides: Record<string, unknown> = {},
): GitHubProviderConnection {
  return {
    id: "ghconn_shared_admission",
    provider: "github",
    installationId: "12345",
    accountLogin: "TeamLeaderLeo",
    credentialRef: "secret://github/test",
    status: "active",
    repositoryFullNames: ["TeamLeaderLeo/Stensibly"],
    observedAt: "2026-07-31T02:00:00.000Z",
    ...overrides,
  } as GitHubProviderConnection;
}

class Projects implements GitHubProviderProjectReader {
  async getProjectAttachment(
    project: string,
  ): Promise<ProjectAttachmentRecord | null> {
    return project === attachment.project ? attachment : null;
  }
}

class Bindings implements GitHubProviderBindingStore {
  constructor(
    readonly binding: GitHubProjectRepositoryBinding,
    readonly connection: GitHubProviderConnection,
  ) {}

  async getGitHubProjectRepositoryBinding(): Promise<
    GitHubProjectRepositoryBinding | null
  > {
    return this.binding;
  }

  async getGitHubProviderConnection(): Promise<
    GitHubProviderConnection | null
  > {
    return this.connection;
  }
}

function guarded(
  binding: GitHubProjectRepositoryBinding,
  connection: GitHubProviderConnection,
) {
  let authorityCalls = 0;
  let adapterCalls = 0;
  const authority: GitHubDelegatedReadAuthority = {
    async authorizeGitHubDelegatedRead() {
      authorityCalls += 1;
      return { allowed: true };
    },
  };
  const adapter: GitHubDelegatedReadAdapter = {
    async callReadTool() {
      adapterCalls += 1;
      return { result: {} };
    },
  };
  const service = new GitHubDelegatedReadService({
    projects: new Projects(),
    bindings: new Bindings(binding, connection),
    authority,
    adapter,
    catalogue,
  });
  return {
    service,
    counts: () => ({ authorityCalls, adapterCalls }),
  };
}

function callInput() {
  return {
    project: "oauth-dogfood",
    repository,
    tool: "fetch_file",
    arguments: { path: "README.md", ref: commitSha },
    actorId: "api-token:test",
    clientId: "mcp:api-token:test",
    catalogueFingerprint: catalogue.registry.fingerprint,
  };
}

async function expectRejectedBeforeAuthority(
  binding: GitHubProjectRepositoryBinding,
  connection: GitHubProviderConnection,
): Promise<void> {
  const candidate = guarded(binding, connection);
  await expect(candidate.service.call(callInput())).rejects
    .toBeInstanceOf(GitHubDelegatedBindingError);
  expect(candidate.counts()).toEqual({
    authorityCalls: 0,
    adapterCalls: 0,
  });
}

describe("delegated reads reuse admitted GitHub binding records", () => {
  test("rejects sparse and decorated repository inventories", async () => {
    const sparse: string[] = [];
    sparse.length = 1;
    await expectRejectedBeforeAuthority(
      validBinding(),
      validConnection({ repositoryFullNames: sparse }),
    );

    const decorated = ["TeamLeaderLeo/Stensibly"] as string[] & {
      alias?: string;
    };
    decorated.alias = "hidden-authority";
    await expectRejectedBeforeAuthority(
      validBinding(),
      validConnection({ repositoryFullNames: decorated }),
    );
  });

  test("rejects non-opaque credentials and empty installation authority", async () => {
    await expectRejectedBeforeAuthority(
      validBinding(),
      validConnection({ credentialRef: "github-private-key-material" }),
    );
    await expectRejectedBeforeAuthority(
      validBinding(),
      validConnection({ repositoryFullNames: [] }),
    );
  });

  test("rejects revoked bindings and custom-prototype records", async () => {
    await expectRejectedBeforeAuthority(
      validBinding({ status: "revoked" }),
      validConnection(),
    );

    const customConnection = Object.assign(
      Object.create({ inherited: true }),
      validConnection(),
    ) as GitHubProviderConnection;
    await expectRejectedBeforeAuthority(
      validBinding(),
      customConnection,
    );
  });

  test("accepts canonical case aliases through the shared compiler", async () => {
    const candidate = guarded(validBinding(), validConnection());
    const receipt = await candidate.service.call(callInput());

    expect(candidate.counts()).toEqual({
      authorityCalls: 1,
      adapterCalls: 1,
    });
    expect(receipt.repositoryFullName).toBe(repository);
    expect(receipt.connectionId).toBe("ghconn_shared_admission");
  });
});
