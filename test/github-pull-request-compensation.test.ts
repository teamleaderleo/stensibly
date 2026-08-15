import { describe, expect, test } from "bun:test";
import { stableJson } from "../src/canonical-json.ts";
import type { GitHubProviderReceipt, GitHubPullRequestResult } from "../src/github-provider-contracts.ts";
import {
  GitHubPullRequestCompensationAuthorityUnavailableError,
  GitHubPullRequestCompensationConflictError,
  GitHubPullRequestCompensationPendingReconciliationError,
  GitHubPullRequestCompensationService,
  type GitHubPullRequestCompensationInput,
} from "../src/github-pull-request-compensation.ts";
import type {
  GitHubPullRequestCompensationAdapter,
  GitHubPullRequestCompensationObservation,
} from "../src/github-pull-request-compensation-contracts.ts";
import { githubPullRequestSourceRevision } from "../src/github-provider-validation.ts";
import {
  assertOperationWorkflowTransition,
  operationWorkflowStableRequestJson,
} from "../src/operation-workflow-admission.ts";
import type {
  OperationWorkflow,
  OperationWorkflowReservation,
  OperationWorkflowStore,
} from "../src/operation-workflow-contracts.ts";
import {
  buildOperationWorkflow,
  reserveOperationWorkflowStep,
  settleOperationWorkflowStep,
} from "../src/operation-workflow-machine.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const branch = "sol/pr-close-fixture";
const base = "main";
const initialSha = "1".repeat(40);
const headSha = "2".repeat(40);
const baseSha = "3".repeat(40);
const sourceId = "opw_publish_pr_close_source";
const sourceKey = "publish:pr-close-source";
const sourcePrKey = "publish:pr-close-source:step:3";

describe("durable GitHub pull-request close compensation", () => {
  test("closes one exact retained PR and exact replay performs no second mutation", async () => {
    const fixture = setup([observation("open"), observation("closed")]);
    const input = compensationInput("close:exact");
    const beforeSource = stableJson(fixture.source.workflow);
    const beforeReceipt = stableJson(fixture.source.receipt);

    const first = await fixture.service.execute(input);
    const replay = await fixture.service.execute(input);

    expect(first.state).toBe("succeeded");
    expect(replay).toEqual(first);
    expect(fixture.adapter.closeCalls).toHaveLength(1);
    expect(fixture.adapter.closeCalls[0]).toMatchObject({
      repositoryFullName: repository,
      pullRequestNumber: 42,
    });
    expect(stableJson(fixture.source.workflow)).toBe(beforeSource);
    expect(stableJson(fixture.source.receipt)).toBe(beforeReceipt);
  });

  test("identity drift fails before close dispatch", async () => {
    const fixture = setup([observation("open", { title: "Changed elsewhere" })]);
    await expectConflict(
      fixture.service.execute(compensationInput("close:drift")),
      "github_pull_request_compensation_identity_drift",
    );
    expect(fixture.adapter.closeCalls).toHaveLength(0);
  });

  test("ambiguous close settles only from exact closed readback", async () => {
    const fixture = setup(
      [observation("open"), observation("closed")],
      ["ambiguous"],
    );
    const input = compensationInput("close:ambiguous-readback");
    const settled = await fixture.service.execute(input);
    expect(settled.state).toBe("succeeded");
    expect(settled.steps[0]?.verificationSha256).not.toBeNull();
    expect(fixture.adapter.closeCalls).toHaveLength(1);
    expect(await fixture.service.execute(input)).toEqual(settled);
    expect(fixture.adapter.closeCalls).toHaveLength(1);
  });

  test("ambiguous close waits while exact PR remains open and later reconciles without redispatch", async () => {
    const fixture = setup(
      [observation("open"), observation("open"), observation("closed")],
      ["ambiguous"],
    );
    const input = compensationInput("close:wait");
    let pending: OperationWorkflow | null = null;
    try {
      await fixture.service.execute(input);
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubPullRequestCompensationPendingReconciliationError);
      pending = (error as GitHubPullRequestCompensationPendingReconciliationError).workflow;
    }
    expect(pending?.state).toBe("waiting_reconciliation");
    expect(pending?.recovery.nextAction).toBe("reconcile_current_step");
    expect(fixture.adapter.closeCalls).toHaveLength(1);

    const reconciled = await fixture.service.execute(input);
    expect(reconciled.state).toBe("succeeded");
    expect(fixture.adapter.closeCalls).toHaveLength(1);
  });

  test("authority loss before dispatch settles an explicit failure with zero close mutation", async () => {
    const fixture = setup([observation("open")], [], { failAuthorityCall: 3 });
    await expectConflict(
      fixture.service.execute(compensationInput("close:authority-before")),
      "github_pull_request_compensation_authority_lost_before_dispatch",
    );
    expect(fixture.adapter.closeCalls).toHaveLength(0);
  });

  test("authority loss after dispatch leaves the reserved effect unresolved until exact readback can settle", async () => {
    const fixture = setup(
      [observation("open"), observation("closed")],
      [],
      { failAuthorityCall: 4 },
    );
    const input = compensationInput("close:authority-after");
    await expect(fixture.service.execute(input)).rejects.toBeInstanceOf(
      GitHubPullRequestCompensationAuthorityUnavailableError,
    );
    expect(fixture.adapter.closeCalls).toHaveLength(1);
    const reserved = await fixture.workflows.getOperationWorkflow(project, input.idempotencyKey);
    expect(reserved?.steps[0]?.state).toBe("dispatch_reserved");

    fixture.authority.enabled = true;
    fixture.authority.failCall = null;
    const reconciled = await fixture.service.execute(input);
    expect(reconciled.state).toBe("succeeded");
    expect(fixture.adapter.closeCalls).toHaveLength(1);
  });

  test("changed compensation request cannot reuse an idempotency identity", async () => {
    const fixture = setup([observation("open"), observation("closed")]);
    const input = compensationInput("close:request-conflict");
    await fixture.service.execute(input);
    await expect(fixture.service.execute({ ...input, itemId: "item_other" }))
      .rejects.toThrow("idempotency key was reused");
    expect(fixture.adapter.closeCalls).toHaveLength(1);
  });

  test("source workflow and source PR receipt must be exact verified publication evidence", async () => {
    const wrongSource = setup([]);
    wrongSource.workflows.replace(sourceKey, {
      ...wrongSource.source.workflow,
      state: "waiting_reconciliation",
      terminalAt: null,
    });
    await expectConflict(
      wrongSource.service.execute(compensationInput("close:source-unsettled")),
      "github_pull_request_compensation_source_conflict",
    );
    expect(wrongSource.adapter.closeCalls).toHaveLength(0);

    const wrongReceipt = setup([]);
    wrongReceipt.source.receipt.result = {
      ...wrongReceipt.source.receipt.result as GitHubPullRequestResult,
      providerNodeId: "PR_other_identity",
    };
    await expectConflict(
      wrongReceipt.service.execute(compensationInput("close:receipt-drift")),
      "github_pull_request_compensation_source_receipt_conflict",
    );
    expect(wrongReceipt.adapter.closeCalls).toHaveLength(0);
  });
});

function setup(
  observations: GitHubPullRequestCompensationObservation[],
  closeResults: Array<"accepted" | "ambiguous" | "rejected"> = [],
  options: { failAuthorityCall?: number } = {},
) {
  const source = sourceEvidence();
  const workflows = new MemoryWorkflowStore();
  workflows.seed(source.workflow);
  const adapter = new FakeAdapter(observations, closeResults);
  const authority = {
    enabled: true,
    calls: 0,
    failCall: options.failAuthorityCall ?? null as number | null,
  };
  const service = new GitHubPullRequestCompensationService({
    workflows,
    assertAuthority: async () => {
      authority.calls += 1;
      if (!authority.enabled || authority.calls === authority.failCall) {
        throw new Error("fixture authority unavailable");
      }
    },
    getGitHubProviderReceipt: async (_project, key) =>
      key === sourcePrKey ? structuredClone(source.receipt) : null,
    adapter,
    now: monotonicClock(),
    idFactory: (() => {
      let next = 0;
      return () => `opw_pr_close_${++next}`;
    })(),
  });
  return { service, workflows, adapter, authority, source };
}

function sourceEvidence() {
  const authorityFence = {
    resource: "run:run_source:generation:1",
    holderId: "actor_source",
    generation: 1,
    expiresAt: "2026-08-16T00:00:00.000Z",
  };
  let workflow = buildOperationWorkflow({
    id: sourceId,
    project,
    itemId: "item_source",
    runId: "run_source",
    actorId: "actor_source",
    clientId: "client_source",
    kind: "github_publish_change",
    target: `${repository}:refs/heads/${branch}`,
    request: { fixture: "publish-pr-close" },
    idempotencyKey: sourceKey,
    authorityFence,
    steps: [
      {
        kind: "github_create_branch",
        providerIdempotencyKey: "publish:pr-close-source:step:1",
        command: { repository, branch, fromCommitSha: initialSha },
        compensation: {
          disposition: "conditionally_reversible",
          kind: "github_delete_created_branch_if_owned",
          command: { repository, branch, operationId: sourceId },
        },
      },
      {
        kind: "github_create_file",
        providerIdempotencyKey: "publish:pr-close-source:step:2",
        command: { repository, branch, path: "fixture.txt", expectedParentSha: initialSha },
        compensation: {
          disposition: "compensatable",
          kind: "github_restore_file_preimage",
          command: { repository, branch, path: "fixture.txt", operationId: sourceId },
        },
      },
      {
        kind: "github_create_pull_request",
        providerIdempotencyKey: sourcePrKey,
        command: {
          repository,
          title: "PR close fixture",
          bodySha256: `sha256:${"4".repeat(64)}`,
          head: branch,
          base,
          expectedBaseSha: baseSha,
          draft: true,
        },
        compensation: {
          disposition: "conditionally_reversible",
          kind: "github_close_created_pull_request_if_open",
          command: { repository, head: branch, base, operationId: sourceId },
        },
      },
    ],
    now: "2026-08-15T08:00:00.000Z",
  });
  for (let index = 0; index < 3; index += 1) {
    const step = workflow.steps[index]!;
    workflow = reserveOperationWorkflowStep(
      workflow,
      step.id,
      `2026-08-15T08:00:0${index * 2 + 1}.000Z`,
    );
    workflow = settleOperationWorkflowStep(workflow, {
      stepId: step.id,
      outcome: "verified",
      settledAt: `2026-08-15T08:00:0${index * 2 + 2}.000Z`,
      providerReceiptRef: index === 1
        ? "github_repository_write_receipt:source-file"
        : `github_provider_receipt:source-${index + 1}`,
      before: { step: index, state: "before" },
      after: { step: index, state: "after" },
      verification: { exact: true },
    });
  }

  const withoutRevision = {
    kind: "pull_request" as const,
    number: 42,
    providerNodeId: "PR_kwDO_pr_close_fixture",
    title: "PR close fixture",
    head: branch,
    headSha,
    base,
    baseSha,
    draft: true,
    state: "open" as const,
    canonicalUrl: `https://github.com/${repository}/pull/42`,
    createdAt: "2026-08-15T08:00:05.000Z",
    updatedAt: "2026-08-15T08:00:06.000Z",
    bodyRevision: {
      byteLength: 19,
      sha256: `sha256:${"5".repeat(64)}`,
    },
    containsBody: false as const,
  };
  const pullRequest: GitHubPullRequestResult = {
    ...withoutRevision,
    sourceRevision: githubPullRequestSourceRevision(withoutRevision),
  };
  const receipt: GitHubProviderReceipt = {
    version: 1,
    id: "ghop_pr_close_source",
    project,
    provider: "github",
    repositoryFullName: repository,
    operation: "github_create_pull_request",
    target: `${repository}:pull:new:${branch}->${base}`,
    actorId: "actor_source",
    clientId: "client_source",
    connectionId: "connection_fixture",
    installationId: "installation_fixture",
    bindingId: "binding_fixture",
    attachmentId: "attachment_fixture",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: sourcePrKey,
    parametersSha256: `sha256:${"b".repeat(64)}`,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-15T08:00:05.000Z",
    updatedAt: "2026-08-15T08:00:06.000Z",
    providerRequestId: "PR:SOURCE",
    result: pullRequest,
    verification: {
      state: "passed",
      checkedAt: "2026-08-15T08:00:06.000Z",
      sourceRevision: pullRequest.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
  return { workflow, receipt };
}

function compensationInput(idempotencyKey: string): GitHubPullRequestCompensationInput {
  return {
    project,
    itemId: "item_pr_close",
    runId: "run_pr_close",
    actorId: "actor_compensation",
    clientId: "client_compensation",
    authorityFence: {
      resource: "run:run_pr_close:generation:1",
      holderId: "actor_compensation",
      generation: 1,
      expiresAt: "2026-08-16T00:00:00.000Z",
    },
    repository,
    sourceOperationId: sourceId,
    sourceOperationIdempotencyKey: sourceKey,
    idempotencyKey,
  };
}

function observation(
  state: "open" | "closed",
  overrides: Partial<GitHubPullRequestCompensationObservation> = {},
): GitHubPullRequestCompensationObservation {
  const retained = sourceEvidence().receipt.result as GitHubPullRequestResult;
  const value = {
    ...retained,
    state,
    updatedAt: state === "closed"
      ? "2026-08-15T08:10:00.000Z"
      : retained.updatedAt,
    ...overrides,
  };
  const withoutRevision = { ...value } as any;
  delete withoutRevision.sourceRevision;
  return {
    ...value,
    sourceRevision: githubPullRequestSourceRevision(withoutRevision),
  };
}

class FakeAdapter implements GitHubPullRequestCompensationAdapter {
  readonly closeCalls: Array<{
    repositoryFullName: string;
    pullRequestNumber: number;
    idempotencyKey: string;
  }> = [];
  readonly #observations: GitHubPullRequestCompensationObservation[];
  readonly #closeResults: Array<"accepted" | "ambiguous" | "rejected">;

  constructor(
    observations: GitHubPullRequestCompensationObservation[],
    closeResults: Array<"accepted" | "ambiguous" | "rejected">,
  ) {
    this.#observations = observations.map((value) => structuredClone(value));
    this.#closeResults = [...closeResults];
  }

  async getPullRequestForCompensation() {
    const next = this.#observations.shift();
    if (!next) throw new Error("fixture readback unavailable");
    return structuredClone(next);
  }

  async closePullRequest(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    idempotencyKey: string;
  }) {
    this.closeCalls.push(structuredClone(input));
    const outcome = this.#closeResults.shift() ?? "accepted";
    if (outcome === "ambiguous") throw new Error("fixture response lost");
    if (outcome === "rejected") {
      const { GitHubPullRequestCompensationProviderRejectedError } =
        await import("../src/github-pull-request-compensation-contracts.ts");
      throw new GitHubPullRequestCompensationProviderRejectedError();
    }
    return {
      pullRequest: observation("closed"),
      providerRequestId: `PR:CLOSE:${this.closeCalls.length}`,
    };
  }
}

class MemoryWorkflowStore implements OperationWorkflowStore {
  readonly #rows = new Map<string, OperationWorkflow>();

  seed(workflow: OperationWorkflow) {
    this.#rows.set(this.#key(workflow.project, workflow.idempotencyKey), structuredClone(workflow));
  }

  replace(idempotencyKey: string, workflow: OperationWorkflow) {
    this.#rows.set(this.#key(workflow.project, idempotencyKey), structuredClone(workflow));
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

  async getOperationWorkflow(projectName: string, idempotencyKey: string) {
    const current = this.#rows.get(this.#key(projectName, idempotencyKey));
    return current ? structuredClone(current) : null;
  }

  #key(projectName: string, idempotencyKey: string) {
    return `${projectName}\u0000${idempotencyKey}`;
  }
}

async function expectConflict(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("expected conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubPullRequestCompensationConflictError);
    expect((error as GitHubPullRequestCompensationConflictError).code).toBe(code);
  }
}

function monotonicClock() {
  let tick = 20;
  return () => `2026-08-15T08:00:${String(tick++).padStart(2, "0")}.000Z`;
}
