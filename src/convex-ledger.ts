import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { convexApi } from "../convex/refs.js";
import type {
  CompleteWithContinuationsInput,
  CompletionContinuationLedger,
} from "./completion-continuation-contracts.js";
import type { ContinuationLedger } from "./continuation-contracts.js";
import type { EditContinuationInput } from "./continuation-edit.js";
import type { ContinuationSupervisorLedger } from "./continuation-supervisor-contracts.js";
import type {
  QueueContinuationForSupervisorInput,
  RunContinuationSupervisorPolicyInput,
} from "./continuation-supervisor.js";
import type {
  ListContinuationsInput,
  ProposeContinuationInput,
  ResolveContinuationInput,
} from "./continuations.js";
import {
  ConvexGitHubProjectContextService,
  type AcceptHostedGitHubIssueContextInput,
  type HostedGitHubIssueContextAcceptance,
} from "./github-project-context-convex-ledger.js";
import type {
  GetGitHubProjectContextInput,
  GitHubProjectContextLedger,
} from "./github-project-context.js";
import type {
  AttachWorkArtifactInput,
  BlockWorkInput,
  ClaimActionInput,
  ClaimWorkInput,
  CompleteWorkInput,
  CreateWorkInput,
  HandoffWorkInput,
  ItemDetail,
  ItemReservation,
  ListWorkInput,
  RecordWorkEventInput,
  RenewClaimInput,
  UnblockWorkInput,
  WorkLedger,
} from "./ledger.js";
import type {
  OperationReceiptInput,
  OperationReceiptLedger,
} from "./operation-receipt-contracts.js";

const HISTORY_CONTRACT_VERSION = 1;
const ITEM_DETAIL_EVENT_LIMIT = 100;
const DIRECT_EVENT_LIMIT = 1_000;
const PHYSICAL_EVENT_ROW_LIMIT = 5_000;
const PHYSICAL_EVENT_BYTE_LIMIT = 8 * 1024 * 1024;
const ARTIFACT_LIMIT = 100;
const ARTIFACT_OVERFLOW_CODE = "history_window_overflow:artifacts";

export interface ConvexCaller {
  query(reference: FunctionReference<"query">, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
}

export interface ConvexWorkLedgerOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

type HostedItemDetail = Omit<ItemDetail, "reservations"> & {
  historyContractVersion: 1;
  eventsTruncated: boolean;
};

export class HostedBackendUpgradeRequiredError extends Error {
  readonly code = "hosted_backend_upgrade_required";

  constructor() {
    super("hosted_backend_upgrade_required: Hosted backend must be upgraded before bounded history can be read");
    this.name = "HostedBackendUpgradeRequiredError";
  }
}

export class HistoryWindowOverflowError extends Error {
  readonly code = "history_window_overflow";
  readonly resource: "artifacts";

  constructor(resource: "artifacts") {
    super(`history_window_overflow: Hosted ${resource} history exceeds the bounded complete window`);
    this.name = "HistoryWindowOverflowError";
    this.resource = resource;
  }
}

export class ConvexWorkLedger implements
  WorkLedger,
  ContinuationLedger,
  CompletionContinuationLedger,
  ContinuationSupervisorLedger,
  OperationReceiptLedger,
  GitHubProjectContextLedger
{
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;
  private historyCapabilityPromise: Promise<void> | null = null;
  private readonly githubProjectContextService: ConvexGitHubProjectContextService;

  constructor(options: ConvexWorkLedgerOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = normalizeWorkspace(options.workspace ?? "default");
    this.githubProjectContextService = new ConvexGitHubProjectContextService({
      client: this.client,
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
    });
  }

  async getBrief(project: string, limit: number) {
    return await this.client.query(
      convexApi.projects.brief,
      this.args({ project, limit, now: Date.now() }),
    );
  }

  async getOperationReceipt(input: OperationReceiptInput) {
    return await this.client.query(
      convexApi.operationReceipts.get,
      this.args(input),
    ) as Awaited<ReturnType<OperationReceiptLedger["getOperationReceipt"]>>;
  }

  async acceptGitHubIssueContext(
    input: AcceptHostedGitHubIssueContextInput,
  ): Promise<HostedGitHubIssueContextAcceptance> {
    return await this.githubProjectContextService.acceptGitHubIssueContext(input);
  }

  async getGitHubProjectContext(input: GetGitHubProjectContextInput) {
    return await this.githubProjectContextService.getGitHubProjectContext(input);
  }

  async listWork(input: ListWorkInput = {}) {
    return await this.client.query(convexApi.items.list, this.args(input)) as Awaited<ReturnType<WorkLedger["listWork"]>>;
  }

  async getItem(id: string): Promise<ItemDetail> {
    await this.ensureBoundedHistoryCapability();
    const now = Date.now();
    const detail = await this.getHostedItemDetail(id, now);
    const reservations = await this.client.query(
      convexApi.itemReservations.list,
      this.args({ itemId: id, now }),
    ) as ItemReservation[];
    return { ...detail, reservations };
  }

  async listArtifacts(id: string) {
    await this.ensureBoundedHistoryCapability();
    try {
      return await this.client.query(
        convexApi.artifacts.list,
        this.args({ id }),
      ) as Awaited<ReturnType<WorkLedger["listArtifacts"]>>;
    } catch (error) {
      if (isArtifactHistoryOverflow(error)) throw new HistoryWindowOverflowError("artifacts");
      if (isMissingArtifactsFunction(error)) throw new HostedBackendUpgradeRequiredError();
      throw error;
    }
  }

  async attachArtifact(input: AttachWorkArtifactInput) {
    return await this.client.mutation(convexApi.artifacts.attach, this.args(input)) as Awaited<ReturnType<WorkLedger["attachArtifact"]>>;
  }

  async createItem(input: CreateWorkInput) {
    return await this.client.mutation(convexApi.items.create, this.args(input)) as Awaited<ReturnType<WorkLedger["createItem"]>>;
  }

  async claimWork(input: ClaimWorkInput) {
    return await this.client.mutation(convexApi.claims.acquire, this.args(input)) as Awaited<ReturnType<WorkLedger["claimWork"]>>;
  }

  async renewClaim(input: RenewClaimInput) {
    return await this.client.mutation(convexApi.claims.renew, this.args(input)) as Awaited<ReturnType<WorkLedger["renewClaim"]>>;
  }

  async handoffWork(input: HandoffWorkInput) {
    return await this.client.mutation(convexApi.items.handoff, this.args(input)) as Awaited<ReturnType<WorkLedger["handoffWork"]>>;
  }

  async blockWork(input: BlockWorkInput) {
    return await this.client.mutation(convexApi.items.block, this.args(input)) as Awaited<ReturnType<WorkLedger["blockWork"]>>;
  }

  async unblockWork(input: UnblockWorkInput) {
    return await this.client.mutation(convexApi.items.unblock, this.args(input)) as Awaited<ReturnType<WorkLedger["unblockWork"]>>;
  }

  async releaseWork(input: ClaimActionInput) {
    return await this.client.mutation(convexApi.claims.release, this.args(input)) as Awaited<ReturnType<WorkLedger["releaseWork"]>>;
  }

  async recordEvent(input: RecordWorkEventInput) {
    return await this.client.mutation(convexApi.events.record, this.args(input)) as Awaited<ReturnType<WorkLedger["recordEvent"]>>;
  }

  async completeWork(input: CompleteWorkInput) {
    return await this.client.mutation(convexApi.items.complete, this.args(input)) as Awaited<ReturnType<WorkLedger["completeWork"]>>;
  }

  async completeWorkWithContinuations(input: CompleteWithContinuationsInput) {
    return await this.client.mutation(
      convexApi.completionContinuations.complete,
      this.args(input),
    ) as Awaited<ReturnType<CompletionContinuationLedger["completeWorkWithContinuations"]>>;
  }

  async proposeContinuation(input: ProposeContinuationInput) {
    return await this.client.mutation(
      convexApi.continuations.propose,
      this.args(input),
    ) as Awaited<ReturnType<ContinuationLedger["proposeContinuation"]>>;
  }

  async getContinuation(id: string) {
    return await this.client.mutation(
      convexApi.continuations.get,
      this.args({ id }),
    ) as Awaited<ReturnType<ContinuationLedger["getContinuation"]>>;
  }

  async listContinuations(input: ListContinuationsInput = {}) {
    return await this.client.mutation(
      convexApi.continuations.list,
      this.args(input),
    ) as Awaited<ReturnType<ContinuationLedger["listContinuations"]>>;
  }

  async resolveContinuation(input: ResolveContinuationInput) {
    return await this.client.mutation(
      convexApi.continuations.resolve,
      this.args(input),
    ) as Awaited<ReturnType<ContinuationLedger["resolveContinuation"]>>;
  }

  async editContinuation(input: EditContinuationInput) {
    await this.getContinuation(input.id);
    return await this.client.mutation(
      convexApi.continuations.edit,
      this.args(input),
    ) as Awaited<ReturnType<ContinuationLedger["editContinuation"]>>;
  }

  async queueContinuationForSupervisor(input: QueueContinuationForSupervisorInput) {
    await this.getContinuation(input.id);
    return await this.client.mutation(
      convexApi.continuationSupervisor.queue,
      this.args(input),
    ) as Awaited<ReturnType<ContinuationSupervisorLedger["queueContinuationForSupervisor"]>>;
  }

  async runContinuationSupervisorPolicy(input: RunContinuationSupervisorPolicyInput) {
    await Promise.all([
      this.listContinuations({ status: "proposed", deliveryMode: "supervisor" }),
      this.listContinuations({ status: "deferred", deliveryMode: "supervisor" }),
    ]);
    return await this.client.mutation(
      convexApi.continuationSupervisor.runPolicy,
      this.args(input),
    ) as Awaited<ReturnType<ContinuationSupervisorLedger["runContinuationSupervisorPolicy"]>>;
  }

  private async getHostedItemDetail(id: string, now: number): Promise<HostedItemDetail> {
    try {
      const value = await this.client.query(
        convexApi.itemControl.get,
        this.args({ id, now }),
      );
      const detail = record(value);
      if (
        detail?.historyContractVersion !== HISTORY_CONTRACT_VERSION
        || typeof detail.eventsTruncated !== "boolean"
      ) {
        throw new HostedBackendUpgradeRequiredError();
      }
      return value as HostedItemDetail;
    } catch (error) {
      if (error instanceof HostedBackendUpgradeRequiredError) throw error;
      if (isArtifactHistoryOverflow(error)) throw new HistoryWindowOverflowError("artifacts");
      if (isMissingItemControlFunction(error)) throw new HostedBackendUpgradeRequiredError();
      throw error;
    }
  }

  private async ensureBoundedHistoryCapability(): Promise<void> {
    if (!this.historyCapabilityPromise) {
      this.historyCapabilityPromise = this.loadBoundedHistoryCapability();
    }
    const capability = this.historyCapabilityPromise;
    try {
      await capability;
    } finally {
      if (this.historyCapabilityPromise === capability) {
        this.historyCapabilityPromise = null;
      }
    }
  }

  private async loadBoundedHistoryCapability(): Promise<void> {
    let value: unknown;
    try {
      value = await this.client.query(
        convexApi.historyCapabilities.get,
        this.args({}),
      );
    } catch (error) {
      if (isMissingHistoryCapabilityFunction(error)) {
        throw new HostedBackendUpgradeRequiredError();
      }
      throw error;
    }
    const capability = record(value);
    if (
      capability?.version !== HISTORY_CONTRACT_VERSION
      || capability.itemDetailVisibleEventLimit !== ITEM_DETAIL_EVENT_LIMIT
      || capability.directVisibleEventLimit !== DIRECT_EVENT_LIMIT
      || capability.physicalEventRowLimit !== PHYSICAL_EVENT_ROW_LIMIT
      || capability.physicalEventByteLimit !== PHYSICAL_EVENT_BYTE_LIMIT
      || capability.artifactLimit !== ARTIFACT_LIMIT
      || capability.artifactOverflowCode !== ARTIFACT_OVERFLOW_CODE
      || capability.boundedItemControl !== true
      || capability.boundedDirectEvents !== true
      || capability.boundedArtifacts !== true
    ) {
      throw new HostedBackendUpgradeRequiredError();
    }
  }

  private args(input: object): Record<string, unknown> {
    return {
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
      ...input,
    };
  }
}

export function createConvexWorkLedgerFromEnv(
  env: Record<string, string | undefined> = Bun.env,
): ConvexWorkLedger {
  const url = required(env.CONVEX_URL, "CONVEX_URL");
  const serviceSecret = required(
    env.STENSIBLY_SERVICE_SECRET,
    "STENSIBLY_SERVICE_SECRET",
  );
  const client = new ConvexHttpClient(url);
  return new ConvexWorkLedger({
    client,
    serviceSecret,
    workspace: env.STENSIBLY_WORKSPACE ?? "default",
  });
}

function isMissingHistoryCapabilityFunction(error: unknown): boolean {
  return missingFunction(error, "historyCapabilities:get");
}

function isMissingItemControlFunction(error: unknown): boolean {
  return missingFunction(error, "itemControl:get");
}

function isMissingArtifactsFunction(error: unknown): boolean {
  return missingFunction(error, "artifacts:list");
}

function missingFunction(error: unknown, name: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`Could not find public function for ['\"\\x60]${escaped}['\"\\x60]`, "i")
    .test(message);
}

function isArtifactHistoryOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(ARTIFACT_OVERFLOW_CODE);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeWorkspace(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(normalized) || normalized.length > 80) {
    throw new Error("Workspace must be a lowercase slug up to 80 characters");
  }
  return normalized;
}
