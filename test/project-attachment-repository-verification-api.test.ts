import { afterEach, describe, expect, test } from "bun:test";
import { createApiV1 } from "../src/api-v1.ts";
import {
  compileProjectContract,
  renderProjectContract,
  type ProjectContract,
} from "../src/project-contract.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const project = "scrapbook";
const repositoryFullName = "teamleaderleo/scrapbook";
const commitSha = "a".repeat(40);
const catalogueFingerprint = `sha256:${"b".repeat(64)}`;
const principals: Record<string, TokenPrincipal> = {
  admin: {
    tokenId: "tok_repository_verify_admin",
    name: "repository-verify-admin",
    scopes: ["admin"],
    projects: [project],
  },
  reader: {
    tokenId: "tok_repository_verify_reader",
    name: "repository-verify-reader",
    scopes: ["read"],
    projects: [project],
  },
};

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    return principals[rawToken] ?? null;
  }
}

const stores: StensiblyStore[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("project attachment repository verification API", () => {
  test("proves get_repo plus exact-commit fetch_file against the accepted source fingerprint", async () => {
    const { app, calls, attachment, source } = await fixture();
    const response = await verify(app, "admin");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verification: {
        version: 1,
        project,
        repositoryFullName,
        defaultBranch: "main",
        commitSha,
        sourcePath: "STENSIBLY.md",
        sourceContentSha256: attachment.snapshot.source.contentSha256,
        attachment: {
          id: attachment.id,
          snapshotSha256: attachment.snapshot.snapshotSha256,
        },
        steps: {
          repositoryMetadata: "get_repo",
          immutableFileRead: "fetch_file",
          immutableReadRef: "exact_commit_sha",
        },
        verified: true,
        authorizesMutation: false,
        containsSecrets: false,
      },
    });
    expect(calls.health).toHaveLength(1);
    expect(calls.delegated).toEqual([{
      project,
      repository: repositoryFullName,
      tool: "fetch_file",
      arguments: { path: "STENSIBLY.md", ref: commitSha },
      actorId: "token:repository-verify-admin",
      clientId: "http:project-attachment-repository-verification",
      catalogueFingerprint,
    }]);
    expect(Buffer.from(source, "utf8").toString("base64")).toBe(calls.contentBase64);
  });

  test("uses the accepted source path and canonical newline normalization", async () => {
    const sourcePath = ".stensibly/STENSIBLY.md";
    const canonicalSource = renderProjectContract(contract, context);
    const crlfSource = canonicalSource.replace(/\n/g, "\r\n");
    const { app, calls, attachment } = await fixture(crlfSource, sourcePath);

    const response = await verify(app, "admin");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verification: {
        sourcePath,
        sourceContentSha256: attachment.snapshot.source.contentSha256,
        attachment: { snapshotSha256: attachment.snapshot.snapshotSha256 },
        verified: true,
      },
    });
    expect(calls.delegated).toHaveLength(1);
    expect(calls.delegated[0]).toMatchObject({
      tool: "fetch_file",
      arguments: { path: sourcePath, ref: commitSha },
    });
  });

  test("keeps repository-ready incomplete when immutable bytes differ", async () => {
    const { app, calls } = await fixture("# changed source\n");
    const response = await verify(app, "admin");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "repository_source_mismatch",
      verification: {
        project,
        repositoryFullName,
        defaultBranch: "main",
        commitSha,
        verified: false,
        authorizesMutation: false,
        containsSecrets: false,
      },
    });
    expect(calls.delegated).toHaveLength(1);
  });

  test("requires project admin before any guarded provider read", async () => {
    const { app, calls } = await fixture();
    const response = await verify(app, "reader");
    expect(response.status).toBe(403);
    expect(calls.health).toHaveLength(0);
    expect(calls.delegated).toHaveLength(0);
  });
});

async function fixture(
  fileOverride?: string,
  sourcePath = "STENSIBLY.md",
) {
  const store = new StensiblyStore(":memory:");
  stores.push(store);
  const ledger = new SqliteWorkLedger(store);
  const source = renderProjectContract(contract, context);
  const snapshot = compileProjectContract(source, sourcePath);
  const accepted = await ledger.acceptProjectAttachment({
    project,
    snapshot,
    sourceRevision: `main@${commitSha}`,
    acceptedBy: "token:test-admin",
    acceptAuthorityWidening: true,
  });
  const attachment = accepted.attachment;
  const contentBase64 = Buffer.from(fileOverride ?? source, "utf8").toString("base64");
  const calls = {
    health: [] as unknown[],
    delegated: [] as unknown[],
    contentBase64,
  };
  const decorated = Object.assign(ledger, {
    async githubRepoHealth(input: unknown) {
      calls.health.push(input);
      return {
        version: 1,
        project,
        repositoryFullName,
        observedAt: "2026-08-10T02:50:00.000Z",
        health: "healthy",
        attachment: {
          id: attachment.id,
          snapshotSha256: attachment.snapshot.snapshotSha256,
          bindingId: "bind_repository_verify01",
        },
        provider: {
          connectionId: "conn_repository_verify01",
          installationId: "12345",
          connectivity: "ready",
        },
        repository: {
          repositoryFullName,
          defaultBranch: "main",
          defaultBranchSha: commitSha,
        },
        operationSurface: ["github_repo_health"],
        catalogueFingerprint,
        attention: [],
        authorizesMutation: false,
      };
    },
    async callGitHubDelegatedRead(input: unknown) {
      calls.delegated.push(input);
      return {
        version: 1,
        project,
        repositoryFullName,
        tool: "fetch_file",
        actorId: "token:repository-verify-admin",
        clientId: "http:project-attachment-repository-verification",
        connectionId: "conn_repository_verify01",
        installationId: "12345",
        bindingId: "bind_repository_verify01",
        attachmentId: attachment.id,
        attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
        capabilityGrantId: null,
        approvalId: null,
        catalogueFingerprint,
        parametersSha256: `sha256:${"c".repeat(64)}`,
        providerRequestId: "req_repository_verify01",
        resultSha256: `sha256:${"d".repeat(64)}`,
        result: {
          repositoryFullName,
          path: sourcePath,
          ref: commitSha,
          blobSha: "e".repeat(40),
          size: Buffer.byteLength(fileOverride ?? source, "utf8"),
          encoding: "base64",
          contentBase64,
        },
      };
    },
  });
  return {
    app: createApiV1(new FixedAuthenticator(), decorated, { required: true }),
    calls,
    attachment,
    source,
  };
}

function verify(app: ReturnType<typeof createApiV1>, token: string): Promise<Response> | Response {
  return app.request(`/projects/${project}/attachment/verify-repository`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repositoryFullName,
      expectedDefaultBranch: "main",
    }),
  });
}

const contract: ProjectContract = {
  version: 1,
  project,
  repositories: [repositoryFullName],
  runnerProfiles: ["codex-default"],
  concurrency: { project: 1, global: 1 },
  autonomousActions: ["inspect", "propose", "create_draft_pr"],
  approvalRequired: ["merge", "deploy"],
  checks: ["bun test"],
  tags: ["coordination"],
  relatedProjects: [],
};

const context = {
  goal: "Coordinate repository work.",
  boundaries: "Keep provider effects approval-gated.",
  evidenceAndHandoff: "Leave exact repository evidence.",
  escalation: "Escalate authority changes.",
};
