import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubPublishChangeOperation,
  OperationWorkflowSettlementError,
} from "../src/github-publish-change-operation.js";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.js";
import type { GitHubRepositoryWriteReceipt } from "../src/github-repository-write-provider-service.js";
import type { OperationWorkflow, OperationWorkflowStore } from "../src/operation-workflow-contracts.js";
import { canonicalOperationWorkflowJson } from "../src/operation-workflow-admission.js";
import { SqliteOperationWorkflowStore } from "../src/operation-workflow-sqlite-store.js";
import { StensiblyStore } from "../src/store.js";

const commit = (digit: string) => digit.repeat(40);

describe("GitHub publish change operation", () => {
  test("lands branch, exact-parent file, and PR under one content-minimised saga", async () => {
    const fixture = createFixture();
    const result = await fixture.operation.execute(fixture.input);
    expect(result.state).toBe("succeeded");
    expect(result.steps.map((step) => step.state)).toEqual(["verified", "verified", "verified"]);
    expect(fixture.calls).toEqual(["branch", "file", "file:get", "pull_request"]);
    expect(fixture.pullRequestHeadSha).toBe(commit("b"));
    const stored = canonicalOperationWorkflowJson(result);
    expect(stored).not.toContain(fixture.input.file.content);
    expect(stored).not.toContain(fixture.input.body!);
    expect(stored).toContain("github_repository_write_receipt:ghrw_file");

    const replay = await fixture.operation.execute(fixture.input);
    expect(replay).toEqual(result);
    expect(fixture.calls).toEqual(["branch", "file", "file:get", "pull_request"]);
    const renewed = await fixture.operation.execute({
      ...fixture.input,
      authorityFence: {
        ...fixture.input.authorityFence,
        expiresAt: "2026-08-10T00:01:59.000Z",
      },
    });
    expect(renewed).toEqual(result);
    expect(fixture.calls).toEqual(["branch", "file", "file:get", "pull_request"]);
    fixture.close();
  });

  test("holds an ambiguous file outcome and never opens a PR or redispatches", async () => {
    const fixture = createFixture({ ambiguousFile: true });
    const firstError = await fixture.operation.execute(fixture.input).catch((error: unknown) => error);
    expect(firstError).toMatchObject({
      code: "operation_workflow_pending_reconciliation",
      workflow: { state: "waiting_reconciliation" },
    });
    expect((firstError as { workflow: OperationWorkflow }).workflow.steps[1]?.providerIdempotencyKey)
      .toMatch(/^opstep:[a-f0-9]{48}$/);
    expect(fixture.calls).toEqual(["branch", "file"]);
    await expect(fixture.operation.execute(fixture.input)).rejects.toMatchObject({
      code: "operation_workflow_pending_reconciliation",
    });
    expect(fixture.calls).toEqual(["branch", "file"]);
    fixture.close();
  });

  test("response loss after provider success becomes durable reconciliation without replay", async () => {
    const fixture = createFixture({ failFirstVerifiedSettlement: true });
    await expect(fixture.operation.execute(fixture.input)).rejects.toBeInstanceOf(
      OperationWorkflowSettlementError,
    );
    expect(fixture.calls).toEqual(["branch"]);
    await expect(fixture.operation.execute(fixture.input)).rejects.toMatchObject({
      code: "operation_workflow_pending_reconciliation",
      workflow: { state: "waiting_reconciliation" },
    });
    expect(fixture.calls).toEqual(["branch"]);
    fixture.close();
  });

  test("rechecks runner authority before reserving every later provider step", async () => {
    const fixture = createFixture({ failAuthorityOnCheck: 4 });
    await expect(fixture.operation.execute(fixture.input)).rejects.toThrow("runner authority expired");
    expect(fixture.calls).toEqual(["branch"]);
    fixture.close();
  });
});

function createFixture(options: {
  ambiguousFile?: boolean;
  failFirstVerifiedSettlement?: boolean;
  failAuthorityOnCheck?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "github-publish-change-"));
  const sqlite = new StensiblyStore(join(directory, "db.sqlite"));
  sqlite.createItem({ project: "stensibly", kind: "task", title: "Fixture", priority: 50 });
  const durable = new SqliteOperationWorkflowStore(sqlite);
  let failVerified = options.failFirstVerifiedSettlement ?? false;
  const workflows: OperationWorkflowStore = {
    reserveOperationWorkflow: (workflow) => durable.reserveOperationWorkflow(workflow),
    getOperationWorkflow: (project, key) => durable.getOperationWorkflow(project, key),
    transitionOperationWorkflow: async (input) => {
      const changed = input.next.steps.some((step, index) =>
        step.state === "verified" && input.current.steps[index]?.state !== "verified");
      if (changed && failVerified) {
        failVerified = false;
        throw new Error("simulated response loss after provider success");
      }
      return await durable.transitionOperationWorkflow(input);
    },
  };
  const calls: string[] = [];
  let storedWrite: GitHubRepositoryWriteReceipt | null = null;
  let pullRequestHeadSha: string | null = null;
  let tick = 0;
  let authorityChecks = 0;
  const now = () => `2026-08-10T00:00:${String(tick++).padStart(2, "0")}.000Z`;
  const operation = new GitHubPublishChangeOperation({
    workflows,
    assertAuthority: async () => {
      authorityChecks += 1;
      if (authorityChecks === options.failAuthorityOnCheck) {
        throw new Error("runner authority expired");
      }
    },
    publication: {
      createBranch: async () => {
        calls.push("branch");
        return branchReceipt();
      },
      createPullRequest: async (input) => {
        calls.push("pull_request");
        pullRequestHeadSha = input.expectedHeadSha;
        return pullRequestReceipt(input.expectedHeadSha);
      },
    },
    repositoryFiles: {
      createRepositoryFile: async () => {
        calls.push("file");
        storedWrite = options.ambiguousFile ? pendingWriteReceipt() : succeededWriteReceipt();
        if (options.ambiguousFile) {
          throw Object.assign(new Error("provider response lost"), {
            code: "repository_write_provider_outcome_ambiguous",
            receipt: storedWrite,
          });
        }
        return storedWrite;
      },
      updateRepositoryFile: async () => {
        throw new Error("unexpected update");
      },
      getRepositoryWriteReceipt: async () => {
        calls.push("file:get");
        return storedWrite;
      },
    },
    now,
    idFactory: () => "opw_publish_change",
  });
  const input = {
    project: "stensibly",
    repository: "teamleaderleo/stensibly",
    actorId: "agent_keel",
    clientId: "codex",
    itemId: "item_154",
    runId: "run_keel",
    authorityFence: {
      resource: "run:run_keel:generation:1",
      holderId: "agent_keel",
      generation: 1,
      expiresAt: "2026-08-10T00:00:59.000Z",
    },
    branch: "codex/operations",
    fromCommitSha: commit("a"),
    file: {
      operation: "create_file" as const,
      path: "docs/operation.md",
      content: "private change body never retained",
      message: "Add operation documentation",
    },
    base: "main",
    expectedBaseSha: commit("a"),
    title: "Add durable operations",
    body: "private pull request body never retained",
    draft: true,
    idempotencyKey: "publish-change:154",
  };
  return {
    operation,
    input,
    calls,
    get pullRequestHeadSha() { return pullRequestHeadSha; },
    close: () => sqlite.close(),
  };
}

function branchReceipt(): GitHubProviderReceipt {
  return providerReceipt({
    id: "ghop_branch",
    operation: "github_create_branch",
    target: "teamleaderleo/stensibly:refs/heads/codex/operations",
    result: {
      kind: "branch",
      name: "codex/operations",
      ref: "refs/heads/codex/operations",
      commitSha: commit("a"),
      canonicalUrl: "https://github.com/teamleaderleo/stensibly/tree/codex/operations",
      sourceRevision: "branch-revision",
    },
  });
}

function pullRequestReceipt(headSha: string): GitHubProviderReceipt {
  return providerReceipt({
    id: "ghop_pr",
    operation: "github_create_pull_request",
    target: "teamleaderleo/stensibly:pull:new:codex/operations->main",
    result: {
      kind: "pull_request",
      number: 1540,
      providerNodeId: "PR_node",
      title: "Add durable operations",
      head: "codex/operations",
      headSha,
      base: "main",
      baseSha: commit("a"),
      draft: true,
      state: "open",
      canonicalUrl: "https://github.com/teamleaderleo/stensibly/pull/1540",
      createdAt: "2026-08-10T00:00:10.000Z",
      updatedAt: "2026-08-10T00:00:10.000Z",
      bodyRevision: { byteLength: 42, sha256: "sha256:" + "9".repeat(64) },
      sourceRevision: "pull-request-revision",
      containsBody: false,
    },
  });
}

function providerReceipt(input: Pick<GitHubProviderReceipt, "id" | "operation" | "target" | "result">): GitHubProviderReceipt {
  return {
    version: 1,
    id: input.id,
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation: input.operation,
    target: input.target,
    actorId: "agent_keel",
    clientId: "codex",
    connectionId: "connection",
    installationId: "installation",
    bindingId: "binding",
    attachmentId: "attachment",
    attachmentSnapshotSha256: "sha256:" + "8".repeat(64),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: `provider:${input.id}`,
    parametersSha256: "sha256:" + "7".repeat(64),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z",
    providerRequestId: "request",
    result: input.result,
    verification: { state: "passed", checkedAt: "2026-08-10T00:00:01.000Z", sourceRevision: "revision" },
    error: null,
    recovery: { nextAction: "none" },
  };
}

function succeededWriteReceipt(): GitHubRepositoryWriteReceipt {
  return {
    version: 1,
    id: "ghrw_file",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "refs/heads/codex/operations",
    path: "docs/operation.md",
    operation: "create_file",
    expectedParentSha: commit("a"),
    requestSha256: "sha256:" + "5".repeat(64),
    payloadSha256: "sha256:" + "6".repeat(64),
    actorId: "agent_keel",
    clientId: "codex",
    idempotencyKey: "publish-change:154:step:2",
    state: "succeeded",
    dispatchCount: 1,
    createdAt: "2026-08-10T00:00:03.000Z",
    updatedAt: "2026-08-10T00:00:04.000Z",
    verified: {
      version: 1,
      state: "verified",
      repositoryFullName: "teamleaderleo/stensibly",
      path: "docs/operation.md",
      operation: "create_file",
      targetRef: "refs/heads/codex/operations",
      defaultBranch: "main",
      expectedParentSha: commit("a"),
      authorityId: "authority",
      authorityGeneration: 1,
      defaultBranchApprovalId: null,
      commitSha: commit("b"),
      nextExpectedParentSha: commit("b"),
      providerRequestId: "write-request",
      requestSha256: "sha256:" + "5".repeat(64),
      verifiedAt: "2026-08-10T00:00:04.000Z",
      authorizesRetry: false,
    },
    error: null,
  };
}

function pendingWriteReceipt(): GitHubRepositoryWriteReceipt {
  return {
    ...succeededWriteReceipt(),
    state: "pending_reconciliation",
    dispatchCount: 1,
    verified: null,
    error: { code: "repository_write_provider_outcome_ambiguous", retry: "reconcile_before_retry" },
  };
}
