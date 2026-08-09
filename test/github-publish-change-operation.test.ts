import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubPublishChangeOperation,
  OperationWorkflowSettlementError,
} from "../src/github-publish-change-operation.js";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.js";
import {
  fingerprintGitHubRepositoryWritePayload,
  type GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service.js";
import type { OperationWorkflow, OperationWorkflowStore } from "../src/operation-workflow-contracts.js";
import { canonicalOperationWorkflowJson } from "../src/operation-workflow-admission.js";
import { sha256, stableJson } from "../src/canonical-json.js";
import { githubPullRequestSourceRevision } from "../src/github-provider-validation.js";
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

  test("does not create a workflow when reconciliation is requested before publication", async () => {
    const fixture = createFixture();
    await expect(fixture.operation.reconcile(fixture.input)).rejects.toMatchObject({
      code: "operation_workflow_conflict",
    });
    expect(await fixture.getWorkflow()).toBeNull();
    expect(fixture.calls).toEqual([]);
    fixture.close();
  });

  test("settles response loss from the exact durable provider receipt without redispatch", async () => {
    const fixture = createFixture({ failFirstVerifiedSettlement: true });
    await expect(fixture.operation.execute(fixture.input)).rejects.toBeInstanceOf(
      OperationWorkflowSettlementError,
    );
    const reconciled = await fixture.operation.reconcile(fixture.input);
    expect(reconciled.state).toBe("running");
    expect(reconciled.steps.map((step) => step.state)).toEqual([
      "verified", "planned", "planned",
    ]);
    expect(fixture.calls).toEqual(["branch", "branch:get"]);

    const replayedReconciliation = await fixture.operation.reconcile(fixture.input);
    expect(replayedReconciliation).toEqual(reconciled);
    expect(fixture.calls).toEqual(["branch", "branch:get"]);

    const completed = await fixture.operation.execute(fixture.input);
    expect(completed.state).toBe("succeeded");
    expect(fixture.calls).toEqual([
      "branch", "branch:get", "file", "file:get", "pull_request",
    ]);
    fixture.close();
  });

  test("recovers when the reconciliation transition commits but its response is lost", async () => {
    const fixture = createFixture({
      failFirstVerifiedSettlement: true,
      loseReconciliationTransitionOnOrdinal: 1,
    });
    await expect(fixture.operation.execute(fixture.input)).rejects.toBeInstanceOf(
      OperationWorkflowSettlementError,
    );
    const reconciled = await fixture.operation.reconcile(fixture.input);
    expect(reconciled.steps[0]?.state).toBe("verified");
    expect(fixture.calls).toEqual(["branch", "branch:get"]);
    fixture.close();
  });

  test("keeps an ambiguous provider receipt blocked and never redispatches", async () => {
    const fixture = createFixture({ ambiguousFile: true });
    await expect(fixture.operation.execute(fixture.input)).rejects.toMatchObject({
      code: "operation_workflow_pending_reconciliation",
    });
    await expect(fixture.operation.reconcile(fixture.input)).rejects.toMatchObject({
      code: "operation_workflow_pending_reconciliation",
    });
    expect(fixture.calls).toEqual(["branch", "file", "file:get"]);
    fixture.close();
  });

  test("settles an exact file receipt after workflow response loss without rewriting the file", async () => {
    const fixture = createFixture({ failVerifiedSettlementOnOrdinal: 2 });
    await expect(fixture.operation.execute(fixture.input)).rejects.toBeInstanceOf(
      OperationWorkflowSettlementError,
    );
    expect(fixture.calls).toEqual(["branch", "file"]);

    const reconciled = await fixture.operation.reconcile(fixture.input);
    expect(reconciled.steps.map((step) => step.state)).toEqual([
      "verified", "verified", "planned",
    ]);
    expect(fixture.calls).toEqual(["branch", "file", "file:get"]);

    const completed = await fixture.operation.execute(fixture.input);
    expect(completed.state).toBe("succeeded");
    expect(fixture.calls).toEqual([
      "branch", "file", "file:get", "file:get", "pull_request",
    ]);
    fixture.close();
  });

  test("rejects altered request bodies before consulting a durable receipt", async () => {
    const fixture = createFixture({ failVerifiedSettlementOnOrdinal: 2 });
    await expect(fixture.operation.execute(fixture.input)).rejects.toBeInstanceOf(
      OperationWorkflowSettlementError,
    );
    await expect(fixture.operation.reconcile({
      ...fixture.input,
      file: { ...fixture.input.file, content: "altered content" },
    })).rejects.toMatchObject({ code: "operation_workflow_conflict" });
    expect(fixture.calls).toEqual(["branch", "file"]);
    fixture.close();
  });

  test("settles the final pull-request receipt without creating another pull request", async () => {
    const fixture = createFixture({ failVerifiedSettlementOnOrdinal: 3 });
    await expect(fixture.operation.execute(fixture.input)).rejects.toBeInstanceOf(
      OperationWorkflowSettlementError,
    );
    expect(fixture.calls).toEqual(["branch", "file", "file:get", "pull_request"]);

    const reconciled = await fixture.operation.reconcile(fixture.input);
    expect(reconciled.state).toBe("succeeded");
    expect(reconciled.steps.every((step) => step.state === "verified")).toBe(true);
    expect(fixture.calls).toEqual([
      "branch", "file", "file:get", "pull_request", "branch:get", "file:get",
    ]);
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
  failVerifiedSettlementOnOrdinal?: number;
  loseReconciliationTransitionOnOrdinal?: number;
  failAuthorityOnCheck?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "github-publish-change-"));
  const sqlite = new StensiblyStore(join(directory, "db.sqlite"));
  sqlite.createItem({ project: "stensibly", kind: "task", title: "Fixture", priority: 50 });
  const durable = new SqliteOperationWorkflowStore(sqlite);
  const failedSettlementOrdinal = options.failVerifiedSettlementOnOrdinal
    ?? (options.failFirstVerifiedSettlement ? 1 : null);
  let failedSettlement = false;
  let lostReconciliationTransition = false;
  const workflows: OperationWorkflowStore = {
    reserveOperationWorkflow: (workflow) => durable.reserveOperationWorkflow(workflow),
    getOperationWorkflow: (project, key) => durable.getOperationWorkflow(project, key),
    transitionOperationWorkflow: async (input) => {
      const changedIndex = input.next.steps.findIndex((step, index) =>
        step.state === "verified" && input.current.steps[index]?.state !== "verified");
      if (
        changedIndex + 1 === failedSettlementOrdinal
        && !failedSettlement
      ) {
        failedSettlement = true;
        throw new Error("simulated response loss after provider success");
      }
      if (
        changedIndex + 1 === options.loseReconciliationTransitionOnOrdinal
        && failedSettlement
        && !lostReconciliationTransition
      ) {
        lostReconciliationTransition = true;
        await durable.transitionOperationWorkflow(input);
        throw new Error("simulated response loss after reconciliation commit");
      }
      return await durable.transitionOperationWorkflow(input);
    },
  };
  const calls: string[] = [];
  let storedWrite: GitHubRepositoryWriteReceipt | null = null;
  const providerReceipts = new Map<string, GitHubProviderReceipt>();
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
      createBranch: async (input) => {
        calls.push("branch");
        const receipt = branchReceipt(input.idempotencyKey);
        providerReceipts.set(input.idempotencyKey, receipt);
        return receipt;
      },
      createPullRequest: async (input) => {
        calls.push("pull_request");
        pullRequestHeadSha = input.expectedHeadSha;
        const receipt = pullRequestReceipt(input.expectedHeadSha, input.idempotencyKey);
        providerReceipts.set(input.idempotencyKey, receipt);
        return receipt;
      },
      getGitHubProviderReceipt: async (_project, key) => {
        calls.push("branch:get");
        return providerReceipts.get(key) ?? null;
      },
    },
    repositoryFiles: {
      createRepositoryFile: async (input) => {
        calls.push("file");
        storedWrite = options.ambiguousFile
          ? pendingWriteReceipt(input.idempotencyKey)
          : succeededWriteReceipt(input.idempotencyKey);
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
    getWorkflow: () => durable.getOperationWorkflow(
      input.project,
      input.idempotencyKey,
    ),
    get pullRequestHeadSha() { return pullRequestHeadSha; },
    close: () => sqlite.close(),
  };
}

function branchReceipt(idempotencyKey = "provider:ghop_branch"): GitHubProviderReceipt {
  const target = "teamleaderleo/stensibly:refs/heads/codex/operations";
  return providerReceipt({
    id: "ghop_branch",
    operation: "github_create_branch",
    target,
    idempotencyKey,
    parametersSha256: sha256(stableJson({
      operation: "github_create_branch",
      target,
      parameters: { branch: "codex/operations", fromCommitSha: commit("a") },
    })),
    result: {
      kind: "branch",
      name: "codex/operations",
      ref: "refs/heads/codex/operations",
      commitSha: commit("a"),
      canonicalUrl: "https://github.com/teamleaderleo/stensibly/tree/codex%2Foperations",
      sourceRevision: commit("a"),
    },
  });
}

function pullRequestReceipt(
  headSha: string,
  idempotencyKey = "provider:ghop_pr",
): GitHubProviderReceipt {
  const target = "teamleaderleo/stensibly:pull:new:codex/operations->main";
  const body = "private pull request body never retained";
  const retained = {
    kind: "pull_request" as const,
    number: 1540,
    providerNodeId: "PR_node",
    title: "Add durable operations",
    head: "codex/operations",
    headSha,
    base: "main",
    baseSha: commit("a"),
    draft: true,
    state: "open" as const,
    canonicalUrl: "https://github.com/teamleaderleo/stensibly/pull/1540",
    createdAt: "2026-08-10T00:00:10.000Z",
    updatedAt: "2026-08-10T00:00:10.000Z",
    bodyRevision: { byteLength: Buffer.byteLength(body), sha256: sha256(body) },
    containsBody: false as const,
  };
  return providerReceipt({
    id: "ghop_pr",
    operation: "github_create_pull_request",
    target,
    idempotencyKey,
    parametersSha256: sha256(stableJson({
      operation: "github_create_pull_request",
      target,
      parameters: {
        title: "Add durable operations",
        body,
        head: "codex/operations",
        base: "main",
        expectedHeadSha: headSha,
        expectedBaseSha: commit("a"),
        draft: true,
      },
    })),
    result: {
      ...retained,
      sourceRevision: githubPullRequestSourceRevision(retained),
    },
  });
}

function providerReceipt(input: Pick<GitHubProviderReceipt,
  "id" | "operation" | "target" | "result" | "idempotencyKey" | "parametersSha256"
>): GitHubProviderReceipt {
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
    idempotencyKey: input.idempotencyKey,
    parametersSha256: input.parametersSha256,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z",
    providerRequestId: "request",
    result: input.result,
    verification: {
      state: "passed",
      checkedAt: "2026-08-10T00:00:01.000Z",
      sourceRevision: input.result?.sourceRevision ?? null,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}

function succeededWriteReceipt(
  idempotencyKey = "publish-change:154:step:2",
): GitHubRepositoryWriteReceipt {
  return {
    version: 1,
    id: "ghrw_file",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "codex/operations",
    path: "docs/operation.md",
    operation: "create_file",
    expectedParentSha: commit("a"),
    requestSha256: "sha256:" + "5".repeat(64),
    payloadSha256: fingerprintGitHubRepositoryWritePayload({
      operation: "create_file",
      content: "private change body never retained",
      message: "Add operation documentation",
    }),
    actorId: "agent_keel",
    clientId: "codex",
    idempotencyKey,
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
      targetRef: "codex/operations",
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

function pendingWriteReceipt(
  idempotencyKey = "publish-change:154:step:2",
): GitHubRepositoryWriteReceipt {
  return {
    ...succeededWriteReceipt(idempotencyKey),
    state: "pending_reconciliation",
    dispatchCount: 1,
    verified: null,
    error: { code: "repository_write_provider_outcome_ambiguous", retry: "reconcile_before_retry" },
  };
}
