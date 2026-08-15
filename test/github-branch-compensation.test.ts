import { describe, expect, test } from "vitest";
import { stableJson } from "../src/canonical-json";
import {
  GitHubBranchCompensationConflictError,
  GitHubBranchCompensationPendingReconciliationError,
  GitHubBranchCompensationService,
  type GitHubBranchCompensationInput,
  type GitHubBranchCompensationObservation,
} from "../src/github-branch-compensation";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts";
import type { GitHubRepositoryWriteReceipt } from "../src/github-repository-write-provider-service";
import type {
  GitHubRunnerGitBranchMutator,
  GitHubRunnerGitMutationResult,
} from "../src/github-runner-git-branch-mutator";
import {
  assertOperationWorkflowTransition,
  operationWorkflowStableRequestJson,
} from "../src/operation-workflow-admission";
import type {
  OperationWorkflow,
  OperationWorkflowReservation,
  OperationWorkflowStore,
} from "../src/operation-workflow-contracts";
import {
  buildOperationWorkflow,
  reserveOperationWorkflowStep,
  settleOperationWorkflowStep,
} from "../src/operation-workflow-machine";

const repository = "teamleaderleo/stensibly";
const branch = "lark/compensation-fixture";
const targetRef = `refs/heads/${branch}`;
const initialSha = "1".repeat(40);
const candidateSha = "2".repeat(40);
const otherSha = "3".repeat(40);
const sourceKey = "publish:fixture";
const sourceId = "opw_publish_fixture";

describe("durable GitHub branch compensation", () => {
  test("exact recorded candidate head deletes once and exact replay returns the settled result", async () => {
    const fixture = setup([present(candidateSha), absent()]);
    const input = deleteInput("delete:exact");
    const first = await fixture.service.execute(input);
    const replay = await fixture.service.execute(input);

    expect(first.state).toBe("succeeded");
    expect(replay).toEqual(first);
    expect(fixture.runner.deleteCalls).toHaveLength(1);
    expect(fixture.runner.restoreCalls).toHaveLength(0);
    expect(fixture.runner.deleteCalls[0]).toMatchObject({
      repositoryFullName: repository,
      targetRef,
      expectedOldSha: candidateSha,
    });
  });

  test("advanced branch conflicts before runner mutation and replays that settled conflict", async () => {
    const fixture = setup([present(otherSha)]);
    const input = deleteInput("delete:advanced");
    await expectConflict(fixture.service.execute(input), "github_branch_compensation_head_conflict");
    await expectConflict(fixture.service.execute(input), "github_branch_compensation_head_conflict");
    expect(fixture.runner.calls).toBe(0);
  });

  test("wrong repository, ref, or recorded SHA fails source admission with zero mutation", async () => {
    const fixture = setup([]);
    await expectConflict(
      fixture.service.execute({ ...deleteInput("wrong:repo"), repository: "teamleaderleo/other" }),
      "github_branch_compensation_source_conflict",
    );
    await expectConflict(
      fixture.service.execute({ ...deleteInput("wrong:ref"), targetRef: "refs/heads/other" }),
      "github_branch_compensation_source_conflict",
    );
    await expectConflict(
      fixture.service.execute({ ...deleteInput("wrong:sha"), recordedSha: otherSha }),
      "github_branch_compensation_recorded_sha_conflict",
    );
    expect(fixture.runner.calls).toBe(0);
  });

  test("same compensation idempotency identity with changed request conflicts", async () => {
    const fixture = setup([present(candidateSha), absent()]);
    const first = deleteInput("delete:altered");
    await fixture.service.execute(first);
    await expect(fixture.service.execute({ ...first, itemId: "item_other" }))
      .rejects.toThrow("idempotency key was reused");
    expect(fixture.runner.calls).toBe(1);
  });

  test("ambiguous delete reconciles from absent GitHub readback before any redispatch", async () => {
    const fixture = setup(
      [present(candidateSha), absent()],
      [{ attemptId: "git-lost-delete", outcome: "ambiguous", code: null }],
    );
    const input = deleteInput("delete:lost-response");
    const settled = await fixture.service.execute(input);
    expect(settled.state).toBe("succeeded");
    expect(fixture.runner.calls).toBe(1);
    expect(await fixture.service.execute(input)).toEqual(settled);
    expect(fixture.runner.calls).toBe(1);
  });

  test("uncertain delete remains waiting until readback proves absence, then settles without redispatch", async () => {
    const fixture = setup(
      [present(candidateSha), present(candidateSha), absent()],
      [{ attemptId: "git-uncertain-delete", outcome: "ambiguous", code: null }],
    );
    const input = deleteInput("delete:pending");
    let pending: OperationWorkflow | null = null;
    try {
      await fixture.service.execute(input);
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubBranchCompensationPendingReconciliationError);
      pending = (error as GitHubBranchCompensationPendingReconciliationError).workflow;
    }
    expect(pending?.state).toBe("waiting_reconciliation");
    expect(pending?.recovery.nextAction).toBe("reconcile_current_step");
    expect(fixture.runner.calls).toBe(1);

    const reconciled = await fixture.service.execute(input);
    expect(reconciled.state).toBe("succeeded");
    expect(fixture.runner.calls).toBe(1);
  });

  test("restore is bound to the successful delete identity and recreates the exact recorded SHA", async () => {
    const fixture = setup([
      present(candidateSha), absent(),
      absent(), present(candidateSha),
    ]);
    const deleted = await fixture.service.execute(deleteInput("delete:for-restore"));
    const restore = restoreInput("restore:exact", deleted.id, deleted.idempotencyKey);
    const restored = await fixture.service.execute(restore);
    expect(restored.state).toBe("succeeded");
    expect(fixture.runner.restoreCalls).toHaveLength(1);
    expect(fixture.runner.restoreCalls[0]).toMatchObject({
      repositoryFullName: repository,
      targetRef,
      recordedSha: candidateSha,
    });
    expect(await fixture.service.execute(restore)).toEqual(restored);
    expect(fixture.runner.restoreCalls).toHaveLength(1);
  });

  test("restore refuses an occupied branch without overwriting it", async () => {
    const fixture = setup([
      present(candidateSha), absent(),
      present(otherSha),
    ]);
    const deleted = await fixture.service.execute(deleteInput("delete:occupied-restore"));
    await expectConflict(
      fixture.service.execute(restoreInput("restore:occupied", deleted.id, deleted.idempotencyKey)),
      "github_branch_compensation_restore_occupied",
    );
    expect(fixture.runner.restoreCalls).toHaveLength(0);
  });

  test("restore requires the exact durable delete compensation identity", async () => {
    const fixture = setup([present(candidateSha), absent()]);
    const deleted = await fixture.service.execute(deleteInput("delete:identity"));
    await expectConflict(
      fixture.service.execute(restoreInput("restore:wrong-delete", deleted.id, "delete:some-other-key")),
      "github_branch_compensation_delete_identity_conflict",
    );
    expect(fixture.runner.restoreCalls).toHaveLength(0);
  });

  test("default, protected, excluded, and unproved-protection refs fail closed before runner mutation", async () => {
    const defaultFixture = setup([present(candidateSha, { defaultBranchRef: targetRef })]);
    await expectConflict(
      defaultFixture.service.execute(deleteInput("delete:default")),
      "github_branch_compensation_default_branch",
    );
    expect(defaultFixture.runner.calls).toBe(0);

    const protectedFixture = setup([present(candidateSha, { protection: "protected" })]);
    await expectConflict(
      protectedFixture.service.execute(deleteInput("delete:protected")),
      "github_branch_compensation_protected_ref",
    );
    expect(protectedFixture.runner.calls).toBe(0);

    const excludedFixture = setup([present(candidateSha)], undefined, [targetRef]);
    await expectConflict(
      excludedFixture.service.execute(deleteInput("delete:excluded")),
      "github_branch_compensation_excluded_ref",
    );
    expect(excludedFixture.runner.calls).toBe(0);

    const unknownFixture = setup([present(candidateSha, { protection: "unknown" })]);
    await expectConflict(
      unknownFixture.service.execute(deleteInput("delete:unknown-protection")),
      "github_branch_compensation_protection_unknown",
    );
    expect(unknownFixture.runner.calls).toBe(0);
  });

  test("an unresolved originating file step blocks compensation before mutation", async () => {
    const fixture = setup([], undefined, [], { sourceFileState: "pending_reconciliation" });
    await expectConflict(
      fixture.service.execute(deleteInput("delete:source-unresolved")),
      "github_branch_compensation_source_unresolved",
    );
    expect(fixture.runner.calls).toBe(0);
  });

  test("lease conflict is typed and performs no second branch mutation", async () => {
    const fixture = setup(
      [present(candidateSha)],
      [{ attemptId: "git-lease-conflict", outcome: "lease_conflict", code: "stale_info" }],
    );
    await expectConflict(
      fixture.service.execute(deleteInput("delete:lease-conflict")),
      "github_branch_compensation_head_conflict",
    );
    expect(fixture.runner.calls).toBe(1);
  });

  test("durable receipt contains no runner/provider prose or credentials", async () => {
    const fixture = setup([present(candidateSha), absent()]);
    const workflow = await fixture.service.execute(deleteInput("delete:minimal-receipt"));
    const json = JSON.stringify(workflow);
    expect(json).not.toContain("Bearer");
    expect(json).not.toContain("stdout");
    expect(json).not.toContain("stderr");
    expect(json).not.toContain("provider prose");
    expect(json).toContain("runner-git:git-attempt-1");
  });
});

function setup(
  observations: GitHubBranchCompensationObservation[],
  mutations?: GitHubRunnerGitMutationResult[],
  excludedRefs: readonly string[] = [],
  options: { sourceFileState?: "verified" | "pending_reconciliation" } = {},
) {
  const workflows = new MemoryWorkflowStore();
  const source = sourceWorkflow(options.sourceFileState ?? "verified");
  workflows.seed(source.workflow);
  const runner = new FakeRunner(mutations);
  const queue = [...observations];
  const service = new GitHubBranchCompensationService({
    workflows,
    assertAuthority: async () => undefined,
    getGitHubProviderReceipt: async (_project, key) =>
      key === source.branchReceipt.idempotencyKey ? source.branchReceipt : null,
    getRepositoryWriteReceipt: async (_project, key) =>
      key === source.writeReceipt.idempotencyKey ? source.writeReceipt : null,
    observeBranch: async () => {
      const next = queue.shift();
      if (!next) throw new Error("fixture observation unavailable");
      return next;
    },
    runner,
    excludedRefs,
    now: monotonicClock(),
    idFactory: (() => {
      let next = 0;
      return () => `opw_branch_comp_${++next}`;
    })(),
  });
  return { service, workflows, runner };
}

function sourceWorkflow(fileState: "verified" | "pending_reconciliation") {
  const authorityFence = {
    resource: "run:run_source:generation:1",
    holderId: "actor_source",
    generation: 1,
    expiresAt: "2026-08-16T00:00:00.000Z",
  };
  let workflow = buildOperationWorkflow({
    id: sourceId,
    project: "stensibly",
    itemId: "item_source",
    runId: "run_source",
    actorId: "actor_source",
    clientId: "client_source",
    kind: "github_publish_change",
    target: `${repository}:${targetRef}`,
    request: { fixture: "publish" },
    idempotencyKey: sourceKey,
    authorityFence,
    steps: [
      {
        kind: "github_create_branch",
        providerIdempotencyKey: "source:branch",
        command: { repository, branch, fromCommitSha: initialSha },
        compensation: {
          disposition: "conditionally_reversible",
          kind: "github_delete_created_branch_if_owned",
          command: { repository, branch, operationId: sourceId },
        },
      },
      {
        kind: "github_create_file",
        providerIdempotencyKey: "source:file",
        command: { repository, branch, path: "fixture.txt", expectedParentSha: initialSha },
        compensation: {
          disposition: "compensatable",
          kind: "github_restore_file_preimage",
          command: { repository, branch, path: "fixture.txt", operationId: sourceId },
        },
      },
      {
        kind: "github_create_pull_request",
        providerIdempotencyKey: "source:pr",
        command: { repository, head: branch, base: "main" },
        compensation: {
          disposition: "conditionally_reversible",
          kind: "github_close_created_pull_request_if_open",
          command: { repository, head: branch, base: "main", operationId: sourceId },
        },
      },
    ],
    now: "2026-08-15T08:00:00.000Z",
  });
  workflow = reserveOperationWorkflowStep(workflow, workflow.steps[0]!.id, "2026-08-15T08:00:01.000Z");
  workflow = settleOperationWorkflowStep(workflow, {
    stepId: workflow.steps[0]!.id,
    outcome: "verified",
    settledAt: "2026-08-15T08:00:02.000Z",
    providerReceiptRef: "github_provider_receipt:source-branch",
    before: { state: "absent" },
    after: { ref: targetRef, commitSha: initialSha },
    verification: { exact: true },
  });
  workflow = reserveOperationWorkflowStep(workflow, workflow.steps[1]!.id, "2026-08-15T08:00:03.000Z");
  workflow = settleOperationWorkflowStep(workflow, {
    stepId: workflow.steps[1]!.id,
    outcome: fileState === "verified" ? "verified" : "pending_reconciliation",
    settledAt: "2026-08-15T08:00:04.000Z",
    ...(fileState === "verified"
      ? {
        providerReceiptRef: "github_repository_write_receipt:source-file",
        before: { head: initialSha },
        after: { head: candidateSha },
        verification: { exact: true },
      }
      : { errorCode: "fixture_pending" }),
  } as any);

  const branchReceipt: GitHubProviderReceipt = {
    version: 1,
    id: "source-branch",
    project: "stensibly",
    provider: "github",
    repositoryFullName: repository,
    operation: "github_create_branch",
    target: `${repository}:${targetRef}`,
    actorId: "actor_source",
    clientId: "client_source",
    connectionId: "connection_fixture",
    installationId: "installation_fixture",
    bindingId: "binding_fixture",
    attachmentId: "attachment_fixture",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "source:branch",
    parametersSha256: `sha256:${"b".repeat(64)}`,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-15T08:00:00.000Z",
    updatedAt: "2026-08-15T08:00:02.000Z",
    providerRequestId: "request-source-branch",
    result: {
      kind: "branch",
      name: branch,
      ref: targetRef,
      commitSha: initialSha,
      canonicalUrl: `https://github.com/${repository}/tree/${branch}`,
      sourceRevision: initialSha,
    },
    verification: {
      state: "passed",
      checkedAt: "2026-08-15T08:00:02.000Z",
      sourceRevision: initialSha,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
  const writeReceipt: GitHubRepositoryWriteReceipt = {
    version: 1,
    id: "source-file",
    project: "stensibly",
    repositoryFullName: repository,
    targetRef,
    path: "fixture.txt",
    operation: "create_file",
    expectedParentSha: initialSha,
    requestSha256: `sha256:${"c".repeat(64)}`,
    payloadSha256: `sha256:${"d".repeat(64)}`,
    actorId: "actor_source",
    clientId: "client_source",
    idempotencyKey: "source:file",
    state: "succeeded",
    dispatchCount: 1,
    createdAt: "2026-08-15T08:00:03.000Z",
    updatedAt: "2026-08-15T08:00:04.000Z",
    verified: {
      version: 1,
      state: "verified",
      repositoryFullName: repository,
      path: "fixture.txt",
      operation: "create_file",
      targetRef,
      defaultBranch: "main",
      expectedParentSha: initialSha,
      authorityId: "authority_fixture",
      authorityGeneration: 1,
      defaultBranchApprovalId: null,
      commitSha: candidateSha,
      nextExpectedParentSha: candidateSha,
      providerRequestId: "request-source-file",
      requestSha256: `sha256:${"c".repeat(64)}`,
      verifiedAt: "2026-08-15T08:00:04.000Z",
      authorizesRetry: false,
    },
    error: null,
  };
  return { workflow, branchReceipt, writeReceipt };
}

function deleteInput(idempotencyKey: string): GitHubBranchCompensationInput {
  return {
    project: "stensibly",
    itemId: "item_compensation",
    runId: "run_compensation",
    actorId: "actor_compensation",
    clientId: "client_compensation",
    authorityFence: {
      resource: "run:run_compensation:generation:1",
      holderId: "actor_compensation",
      generation: 1,
      expiresAt: "2026-08-16T00:00:00.000Z",
    },
    repository,
    targetRef,
    recordedSha: candidateSha,
    sourceOperationId: sourceId,
    sourceOperationIdempotencyKey: sourceKey,
    action: "delete",
    idempotencyKey,
  };
}

function restoreInput(
  idempotencyKey: string,
  deleteCompensationId: string,
  deleteCompensationIdempotencyKey: string,
): GitHubBranchCompensationInput {
  return {
    ...deleteInput(idempotencyKey),
    action: "restore",
    deleteCompensationId,
    deleteCompensationIdempotencyKey,
  };
}

function present(
  commitSha: string,
  overrides: Partial<GitHubBranchCompensationObservation> = {},
): GitHubBranchCompensationObservation {
  return {
    repositoryFullName: repository,
    targetRef,
    defaultBranchRef: "refs/heads/main",
    state: "present",
    commitSha,
    protection: "unprotected",
    sourceRevision: `github:branch:${commitSha}`,
    ...overrides,
  };
}

function absent(
  overrides: Partial<GitHubBranchCompensationObservation> = {},
): GitHubBranchCompensationObservation {
  return {
    repositoryFullName: repository,
    targetRef,
    defaultBranchRef: "refs/heads/main",
    state: "absent",
    commitSha: null,
    protection: "unprotected",
    sourceRevision: "github:branch:absent",
    ...overrides,
  };
}

class FakeRunner implements GitHubRunnerGitBranchMutator {
  readonly deleteCalls: any[] = [];
  readonly restoreCalls: any[] = [];
  readonly #results: GitHubRunnerGitMutationResult[];

  constructor(results?: GitHubRunnerGitMutationResult[]) {
    this.#results = results ? [...results] : [];
  }

  get calls() { return this.deleteCalls.length + this.restoreCalls.length; }

  async deleteBranchExact(input: any): Promise<GitHubRunnerGitMutationResult> {
    this.deleteCalls.push(structuredClone(input));
    return this.#next();
  }

  async restoreBranchExact(input: any): Promise<GitHubRunnerGitMutationResult> {
    this.restoreCalls.push(structuredClone(input));
    return this.#next();
  }

  #next(): GitHubRunnerGitMutationResult {
    return this.#results.shift() ?? {
      attemptId: `git-attempt-${this.calls}`,
      outcome: "accepted",
      code: null,
    };
  }
}

class MemoryWorkflowStore implements OperationWorkflowStore {
  readonly #rows = new Map<string, OperationWorkflow>();

  seed(workflow: OperationWorkflow) {
    this.#rows.set(this.#key(workflow.project, workflow.idempotencyKey), structuredClone(workflow));
  }

  async reserveOperationWorkflow(workflow: OperationWorkflow): Promise<OperationWorkflowReservation> {
    const key = this.#key(workflow.project, workflow.idempotencyKey);
    const current = this.#rows.get(key);
    if (!current) {
      this.#rows.set(key, structuredClone(workflow));
      return { outcome: "reserved", workflow: structuredClone(workflow) };
    }
    return {
      outcome: operationWorkflowStableRequestJson(current) === operationWorkflowStableRequestJson(workflow)
        ? "replay"
        : "conflict",
      workflow: structuredClone(current),
    };
  }

  async transitionOperationWorkflow(input: { current: OperationWorkflow; next: OperationWorkflow }) {
    const admitted = assertOperationWorkflowTransition(input.current, input.next);
    const key = this.#key(admitted.current.project, admitted.current.idempotencyKey);
    const current = this.#rows.get(key);
    if (!current || stableJson(current) !== stableJson(admitted.current)) {
      throw new Error("fixture workflow changed concurrently");
    }
    this.#rows.set(key, structuredClone(admitted.next));
    return structuredClone(admitted.next);
  }

  async getOperationWorkflow(project: string, idempotencyKey: string) {
    const current = this.#rows.get(this.#key(project, idempotencyKey));
    return current ? structuredClone(current) : null;
  }

  #key(project: string, idempotencyKey: string) {
    return `${project}\u0000${idempotencyKey}`;
  }
}

async function expectConflict(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("expected conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubBranchCompensationConflictError);
    expect((error as GitHubBranchCompensationConflictError).code).toBe(code);
  }
}

function monotonicClock() {
  let tick = 10;
  return () => `2026-08-15T08:00:${String(tick++).padStart(2, "0")}.000Z`;
}
