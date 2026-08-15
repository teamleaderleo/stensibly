import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  GitHubRepositoryFileCompensationPendingReconciliationError,
  GitHubRepositoryFileCompensationService,
  type GitHubRepositoryFileCompensationAdapter,
  type GitHubRepositoryFileCompensationInput,
  type RepositoryFileCompensationBlob,
  type RepositoryFileCompensationMutationResult,
} from "../src/github-repository-file-compensation.ts";
import {
  fingerprintGitHubRepositoryWritePayload,
  type GitHubRepositoryWriteCommand,
  type GitHubRepositoryWritePayload,
  type GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service.ts";
import { fingerprintGitHubRepositoryWriteReceipt } from "../src/github-repository-write-receipt-admission.ts";
import type {
  OperationWorkflow,
  OperationWorkflowReservation,
  OperationWorkflowStore,
} from "../src/operation-workflow-contracts.ts";
import { assertOperationWorkflowTransition } from "../src/operation-workflow-admission.ts";
import {
  prepareRepositoryWrite,
  type RepositoryWriteCommitTreeSnapshot,
  type RepositoryWriteOperation,
  type RepositoryWriteTreeEntry,
} from "../src/repository-write-fence.ts";

const repository = "teamleaderleo/stensibly";
const targetRef = "feature/file-compensation";
const path = "fixtures/compensation.bin";
const project = "default";
const parentSha = "1".repeat(40);
const sourceCommitSha = "2".repeat(40);
const compensationCommitSha = "3".repeat(40);
const otherCommitSha = "4".repeat(40);
const parentTreeSha = "5".repeat(40);
const sourceTreeSha = "6".repeat(40);
const unrelatedBlobSha = "7".repeat(40);
const oldBytes = Buffer.from([0, 1, 2, 3, 255, 10]);
const oldBlobSha = gitBlobSha(oldBytes);
const newContent = "new text\n";
const newBlobSha = gitBlobSha(Buffer.from(newContent, "utf8"));

interface SourceFixture {
  operation: RepositoryWriteOperation;
  parentMode: "100644" | "100755";
  command: GitHubRepositoryWriteCommand;
  receipt: GitHubRepositoryWriteReceipt;
  receiptFingerprint: string;
}

const otherEntry: RepositoryWriteTreeEntry = {
  path: "fixtures/other.txt",
  mode: "100644",
  type: "blob",
  sha: unrelatedBlobSha,
};

describe("GitHubRepositoryFileCompensationService", () => {
  test("create → delete and terminal replay performs zero second mutation", async () => {
    const source = sourceFixture("create_file");
    const adapter = new FakeAdapter(source);
    const service = serviceFor(source, adapter, new MemoryWorkflowStore());
    const input = compensationInput(source);

    const first = await service.execute(input);
    const replay = await service.execute(input);

    expect(first.state).toBe("succeeded");
    expect(replay).toEqual(first);
    expect(adapter.dispatches).toHaveLength(1);
    expect(adapter.dispatches[0]).toMatchObject({
      expectedParentSha: sourceCommitSha,
      expectedCurrent: { kind: "blob", mode: "100644", blobSha: newBlobSha },
      restored: { kind: "absent" },
      expectedRestoredTreeSha: parentTreeSha,
    });
  });

  test("update → restore exact immutable parent bytes/object and executable mode", async () => {
    const source = sourceFixture("update_file", "100755");
    const adapter = new FakeAdapter(source);
    const workflow = await serviceFor(source, adapter, new MemoryWorkflowStore())
      .execute(compensationInput(source));

    expect(workflow.state).toBe("succeeded");
    expect(adapter.blobReads).toEqual([oldBlobSha, oldBlobSha]);
    expect(adapter.dispatches[0]).toMatchObject({
      expectedCurrent: { kind: "blob", mode: "100755", blobSha: newBlobSha },
      restored: { kind: "blob", mode: "100755", blobSha: oldBlobSha },
    });
    expect(workflow.steps[0]?.providerReceiptRef).toContain(oldBlobSha);
    expect(workflow.steps[0]?.providerReceiptRef).toContain(sha256Bytes(oldBytes));
  });

  test("delete → recreate exact immutable parent bytes/object", async () => {
    const source = sourceFixture("delete_file");
    const adapter = new FakeAdapter(source);
    const workflow = await serviceFor(source, adapter, new MemoryWorkflowStore())
      .execute(compensationInput(source));

    expect(workflow.state).toBe("succeeded");
    expect(adapter.dispatches[0]).toMatchObject({
      expectedCurrent: { kind: "absent" },
      restored: { kind: "blob", mode: "100644", blobSha: oldBlobSha },
    });
  });

  test("source receipt or exact original request drift conflicts before provider reads", async () => {
    const source = sourceFixture("update_file");
    const adapter = new FakeAdapter(source);
    const service = serviceFor(source, adapter, new MemoryWorkflowStore());
    const input = compensationInput(source);

    await expect(service.execute({
      ...input,
      sourceReceiptSha256: `sha256:${"0".repeat(64)}`,
    })).rejects.toMatchObject({
      code: "github_repository_file_compensation_source_receipt_conflict",
    });

    const payload = source.command.payload as Extract<GitHubRepositoryWritePayload, { operation: "update_file" }>;
    await expect(service.execute({
      ...input,
      idempotencyKey: "file-comp-source-drift",
      sourceWrite: {
        ...source.command,
        payload: { ...payload, message: "Changed source message" },
      },
    })).rejects.toMatchObject({
      code: "github_repository_file_compensation_source_request_conflict",
    });
    expect(adapter.totalReads).toBe(0);
    expect(adapter.dispatches).toHaveLength(0);
  });

  test("immutable parent object mismatch fails explicitly with zero mutation", async () => {
    const source = sourceFixture("update_file");
    const adapter = new FakeAdapter(source, { parentBlobSha: "8".repeat(40) });
    const service = serviceFor(source, adapter, new MemoryWorkflowStore());

    await expect(service.execute(compensationInput(source))).rejects.toMatchObject({
      code: "github_repository_file_compensation_preimage_conflict",
    });
    expect(adapter.dispatches).toHaveLength(0);
  });

  test("unavailable immutable parent waits explicitly with zero mutation", async () => {
    const source = sourceFixture("update_file");
    const adapter = new FakeAdapter(source, { preimageUnavailable: true });
    const service = serviceFor(source, adapter, new MemoryWorkflowStore());

    await expect(service.execute(compensationInput(source))).rejects.toMatchObject({
      code: "github_repository_file_compensation_preimage_unavailable",
    });
    expect(adapter.dispatches).toHaveLength(0);
  });

  test("advanced ref and changed current path conflict before mutation", async () => {
    const source = sourceFixture("create_file");
    const advanced = new FakeAdapter(source, { currentHead: otherCommitSha });
    await expect(serviceFor(source, advanced, new MemoryWorkflowStore()).execute(compensationInput(source)))
      .rejects.toMatchObject({ code: "github_repository_file_compensation_current_state_conflict" });
    expect(advanced.dispatches).toHaveLength(0);

    const changed = new FakeAdapter(source, { sourcePathBlobSha: "9".repeat(40) });
    await expect(serviceFor(source, changed, new MemoryWorkflowStore()).execute({
      ...compensationInput(source),
      idempotencyKey: "file-comp-path-drift",
    })).rejects.toMatchObject({ code: "github_repository_file_compensation_current_state_conflict" });
    expect(changed.dispatches).toHaveLength(0);
  });

  test("ambiguous applied mutation settles only from exact provider readback and never redispatches", async () => {
    const source = sourceFixture("delete_file");
    const adapter = new FakeAdapter(source, { dispatchOutcome: "ambiguous_applied" });
    const service = serviceFor(source, adapter, new MemoryWorkflowStore());
    const input = compensationInput(source);

    await expect(service.execute(input)).rejects.toBeInstanceOf(
      GitHubRepositoryFileCompensationPendingReconciliationError,
    );
    expect(adapter.dispatches).toHaveLength(1);

    const settled = await service.execute(input);
    expect(settled.state).toBe("succeeded");
    expect(adapter.dispatches).toHaveLength(1);
    expect(await service.execute(input)).toEqual(settled);
    expect(adapter.dispatches).toHaveLength(1);
  });

  test("ambiguous unapplied mutation remains waiting and never redispatches", async () => {
    const source = sourceFixture("create_file");
    const adapter = new FakeAdapter(source, { dispatchOutcome: "ambiguous_unapplied" });
    const service = serviceFor(source, adapter, new MemoryWorkflowStore());
    const input = compensationInput(source);

    await expect(service.execute(input)).rejects.toBeInstanceOf(
      GitHubRepositoryFileCompensationPendingReconciliationError,
    );
    await expect(service.execute(input)).rejects.toBeInstanceOf(
      GitHubRepositoryFileCompensationPendingReconciliationError,
    );
    expect(adapter.dispatches).toHaveLength(1);
  });

  test("authority loss before mutation waits explicitly with zero mutation", async () => {
    const source = sourceFixture("update_file");
    const adapter = new FakeAdapter(source);
    let checks = 0;
    const service = serviceFor(source, adapter, new MemoryWorkflowStore(), async () => {
      checks += 1;
      if (checks >= 2) throw new Error("authority lost");
    });

    await expect(service.execute(compensationInput(source))).rejects.toMatchObject({
      code: "github_repository_file_compensation_authority_unavailable",
    });
    expect(adapter.dispatches).toHaveLength(0);
  });

  test("durable evidence contains bounded hashes/counts/provider request identity and no raw preimage", async () => {
    const source = sourceFixture("update_file");
    const adapter = new FakeAdapter(source);
    const workflow = await serviceFor(source, adapter, new MemoryWorkflowStore())
      .execute(compensationInput(source));
    const durable = JSON.stringify(workflow);

    expect(durable).toContain(oldBlobSha);
    expect(durable).toContain(sha256Bytes(oldBytes));
    expect(durable).toContain(String(oldBytes.byteLength));
    expect(durable).toContain(compensationCommitSha);
    expect(durable).toContain("REQ-COMP-1");
    expect(durable).toContain("file-compensation:exact");
    expect(durable).not.toContain(oldBytes.toString("base64"));
    expect(durable).not.toContain(newContent);
  });
});

function sourceFixture(
  operation: RepositoryWriteOperation,
  parentMode: "100644" | "100755" = "100644",
): SourceFixture {
  const intent = {
    version: 1 as const,
    repositoryFullName: repository,
    path,
    operation,
    targetRef,
    expectedParentSha: parentSha,
  };
  const authority = {
    version: 1 as const,
    repositoryFullName: repository,
    targetRef,
    defaultBranch: "main",
    authorityId: "source_authority",
    authorityGeneration: 1,
    defaultBranchApprovalId: null,
  };
  const prepared = prepareRepositoryWrite(intent, authority);
  const payload: GitHubRepositoryWritePayload = operation === "create_file"
    ? { operation, content: newContent, message: "Create compensation fixture" }
    : operation === "update_file"
      ? { operation, content: newContent, contentSha: oldBlobSha, message: "Update compensation fixture" }
      : { operation, contentSha: oldBlobSha, message: "Delete compensation fixture" };
  const command: GitHubRepositoryWriteCommand = {
    project,
    actorId: "source_actor",
    clientId: "source_client",
    idempotencyKey: `source-write-${operation}`,
    intent,
    payload,
  };
  const receipt: GitHubRepositoryWriteReceipt = {
    version: 1,
    id: `ghrw_source_${operation}`,
    project,
    repositoryFullName: repository,
    targetRef,
    path,
    operation,
    expectedParentSha: parentSha,
    requestSha256: prepared.requestSha256,
    payloadSha256: fingerprintGitHubRepositoryWritePayload(payload),
    actorId: command.actorId,
    clientId: command.clientId,
    idempotencyKey: command.idempotencyKey,
    state: "succeeded",
    dispatchCount: 1,
    createdAt: "2026-08-15T08:00:00.000Z",
    updatedAt: "2026-08-15T08:00:01.000Z",
    verified: {
      version: 1,
      state: "verified",
      repositoryFullName: repository,
      path,
      operation,
      targetRef,
      defaultBranch: "main",
      expectedParentSha: parentSha,
      authorityId: authority.authorityId,
      authorityGeneration: authority.authorityGeneration,
      defaultBranchApprovalId: null,
      commitSha: sourceCommitSha,
      nextExpectedParentSha: sourceCommitSha,
      providerRequestId: "REQ-SOURCE-1",
      requestSha256: prepared.requestSha256,
      verifiedAt: "2026-08-15T08:00:01.000Z",
      authorizesRetry: false,
    },
    error: null,
  };
  return {
    operation,
    parentMode,
    command,
    receipt,
    receiptFingerprint: fingerprintGitHubRepositoryWriteReceipt(receipt),
  };
}

function compensationInput(source: SourceFixture): GitHubRepositoryFileCompensationInput {
  return {
    project,
    itemId: "item_file_compensation",
    runId: "run_file_compensation",
    actorId: "vireo",
    clientId: "client_file_compensation",
    authorityFence: {
      resource: "run:run_file_compensation:generation:1",
      holderId: "vireo",
      generation: 1,
      expiresAt: "2026-08-15T12:00:00.000Z",
    },
    sourceReceiptId: source.receipt.id,
    sourceReceiptSha256: source.receiptFingerprint,
    sourceWrite: source.command,
    idempotencyKey: "file-compensation:exact",
  };
}

function serviceFor(
  source: SourceFixture,
  adapter: FakeAdapter,
  workflows: MemoryWorkflowStore,
  assertAuthority: () => Promise<void> = async () => undefined,
) {
  return new GitHubRepositoryFileCompensationService({
    workflows,
    repositoryWrites: {
      getRepositoryWriteReceipt: async (_project, key) =>
        key === source.command.idempotencyKey ? source.receipt : null,
    },
    repositoryWriteAuthority: {
      getRepositoryWriteAuthority: async (input) => ({
        version: 1,
        repositoryFullName: input.repositoryFullName,
        targetRef: input.targetRef,
        defaultBranch: "main",
        authorityId: "compensation_authority",
        authorityGeneration: 7,
        defaultBranchApprovalId: null,
      }),
    },
    assertAuthority,
    adapter,
    now: monotonicClock(),
    idFactory: () => "opw_file_comp_fixture",
  });
}

class MemoryWorkflowStore implements OperationWorkflowStore {
  readonly #rows = new Map<string, OperationWorkflow>();

  async reserveOperationWorkflow(workflow: OperationWorkflow): Promise<OperationWorkflowReservation> {
    const key = `${workflow.project}:${workflow.idempotencyKey}`;
    const current = this.#rows.get(key);
    if (!current) {
      this.#rows.set(key, workflow);
      return { outcome: "reserved", workflow };
    }
    const same = current.requestSha256 === workflow.requestSha256
      && current.kind === workflow.kind
      && current.target === workflow.target
      && current.actorId === workflow.actorId
      && current.clientId === workflow.clientId;
    return { outcome: same ? "replay" : "conflict", workflow: current };
  }

  async transitionOperationWorkflow(input: {
    current: OperationWorkflow;
    next: OperationWorkflow;
  }): Promise<OperationWorkflow> {
    assertOperationWorkflowTransition(input.current, input.next);
    const key = `${input.current.project}:${input.current.idempotencyKey}`;
    const stored = this.#rows.get(key);
    if (!stored || stored.revision !== input.current.revision) throw new Error("stale transition");
    this.#rows.set(key, input.next);
    return input.next;
  }

  async getOperationWorkflow(projectValue: string, idempotencyKey: string): Promise<OperationWorkflow | null> {
    return this.#rows.get(`${projectValue}:${idempotencyKey}`) ?? null;
  }
}

class FakeAdapter implements GitHubRepositoryFileCompensationAdapter {
  currentHead: string;
  totalReads = 0;
  readonly dispatches: Array<Parameters<GitHubRepositoryFileCompensationAdapter["dispatchRepositoryFileCompensation"]>[0]> = [];
  readonly blobReads: string[] = [];

  constructor(
    readonly source: SourceFixture,
    readonly options: {
      parentBlobSha?: string;
      sourcePathBlobSha?: string;
      currentHead?: string;
      preimageUnavailable?: boolean;
      dispatchOutcome?: "success" | "ambiguous_applied" | "ambiguous_unapplied";
    } = {},
  ) {
    this.currentHead = options.currentHead ?? sourceCommitSha;
  }

  async getRefHead(): Promise<string | null> {
    this.totalReads += 1;
    return this.currentHead;
  }

  async getCommitTreeSnapshot(input: { repositoryFullName: string; commitSha: string }): Promise<unknown> {
    this.totalReads += 1;
    if (this.options.preimageUnavailable && input.commitSha === parentSha) throw new Error("unavailable");
    if (input.repositoryFullName !== repository) throw new Error("wrong repository");
    if (input.commitSha === parentSha) return this.parentSnapshot();
    if (input.commitSha === sourceCommitSha) return this.sourceSnapshot();
    if (input.commitSha === compensationCommitSha) return this.compensationSnapshot();
    throw new Error("unknown commit");
  }

  async getBlobBytes(input: {
    repositoryFullName: string;
    blobSha: string;
    maximumBytes: number;
  }): Promise<RepositoryFileCompensationBlob> {
    this.totalReads += 1;
    this.blobReads.push(input.blobSha);
    if (input.repositoryFullName !== repository || input.blobSha !== oldBlobSha) throw new Error("missing blob");
    if (input.maximumBytes < oldBytes.byteLength) throw new Error("limit");
    const bytes = new Uint8Array(oldBytes);
    return {
      repositoryFullName: repository,
      blobSha: oldBlobSha,
      byteLength: bytes.byteLength,
      contentSha256: sha256Bytes(bytes),
      bytes,
    };
  }

  async dispatchRepositoryFileCompensation(
    input: Parameters<GitHubRepositoryFileCompensationAdapter["dispatchRepositoryFileCompensation"]>[0],
  ): Promise<RepositoryFileCompensationMutationResult> {
    this.dispatches.push(input);
    const outcome = this.options.dispatchOutcome ?? "success";
    if (outcome !== "ambiguous_unapplied") this.currentHead = compensationCommitSha;
    if (outcome !== "success") throw new Error("ambiguous");
    return {
      commitSha: compensationCommitSha,
      targetRef,
      parentSha: sourceCommitSha,
      restoredTreeSha: parentTreeSha,
      providerRequestId: "REQ-COMP-1",
    };
  }

  parentSnapshot(): RepositoryWriteCommitTreeSnapshot {
    const entries: RepositoryWriteTreeEntry[] = [{ ...otherEntry }];
    if (this.source.operation !== "create_file") {
      entries.push({
        path,
        mode: this.source.parentMode,
        type: "blob",
        sha: this.options.parentBlobSha ?? oldBlobSha,
      });
    }
    return snapshot(parentSha, [], parentTreeSha, entries, "Parent fixture");
  }

  sourceSnapshot(): RepositoryWriteCommitTreeSnapshot {
    const entries: RepositoryWriteTreeEntry[] = [{ ...otherEntry }];
    if (this.source.operation !== "delete_file") {
      const mode: "100644" | "100755" = this.source.operation === "create_file"
        ? "100644"
        : this.source.parentMode;
      entries.push({
        path,
        mode,
        type: "blob",
        sha: this.options.sourcePathBlobSha ?? newBlobSha,
      });
    }
    return snapshot(
      sourceCommitSha,
      [parentSha],
      sourceTreeSha,
      entries,
      (this.source.command.payload as { message: string }).message,
    );
  }

  compensationSnapshot(): RepositoryWriteCommitTreeSnapshot {
    return snapshot(
      compensationCommitSha,
      [sourceCommitSha],
      parentTreeSha,
      this.parentSnapshot().entries,
      "Stensibly repository-file compensation opw_file_comp_fixture",
    );
  }
}

function snapshot(
  commitSha: string,
  parentShas: string[],
  treeSha: string,
  entries: RepositoryWriteTreeEntry[],
  message: string,
): RepositoryWriteCommitTreeSnapshot {
  return {
    version: 1,
    repositoryFullName: repository,
    commitSha,
    parentShas,
    messageSha256: sha256(message),
    treeSha,
    entries,
  };
}

function monotonicClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 15, 9, 0, tick++)).toISOString();
}
function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8")).update(bytes).digest("hex");
}
function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
