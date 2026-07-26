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
  projectItemControl,
  type ItemControlEventInput,
  type ItemControlRunInput,
} from "./item-control.js";
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

export interface ConvexCaller {
  query(reference: FunctionReference<"query">, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
}

export interface ConvexWorkLedgerOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

type HostedItemDetail = Omit<ItemDetail, "reservations">;
type LegacyHostedItemDetail = Omit<ItemDetail, "control" | "reservations">;

export class ConvexWorkLedger implements
  WorkLedger,
  ContinuationLedger,
  CompletionContinuationLedger,
  ContinuationSupervisorLedger
{
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexWorkLedgerOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = normalizeWorkspace(options.workspace ?? "default");
  }

  async getBrief(project: string, limit: number) {
    return await this.client.query(
      convexApi.projects.brief,
      this.args({ project, limit, now: Date.now() }),
    );
  }

  async listWork(input: ListWorkInput = {}) {
    return await this.client.query(convexApi.items.list, this.args(input)) as Awaited<ReturnType<WorkLedger["listWork"]>>;
  }

  async getItem(id: string): Promise<ItemDetail> {
    const now = Date.now();
    const detailPromise = this.getHostedItemDetail(id, now);
    const reservationsPromise = this.client.query(
      convexApi.itemReservations.list,
      this.args({ itemId: id, now }),
    ) as Promise<ItemReservation[]>;
    const [detail, reservations] = await Promise.all([
      detailPromise,
      reservationsPromise,
    ]);
    return { ...detail, reservations };
  }

  async listArtifacts(id: string) {
    return await this.client.query(convexApi.artifacts.list, this.args({ id })) as Awaited<ReturnType<WorkLedger["listArtifacts"]>>;
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
      return await this.client.query(
        convexApi.itemControl.get,
        this.args({ id, now }),
      ) as HostedItemDetail;
    } catch (error) {
      if (!isMissingItemControlFunction(error)) throw error;
      const legacy = await this.client.query(
        convexApi.items.get,
        this.args({ id }),
      ) as LegacyHostedItemDetail;
      return {
        ...legacy,
        control: projectItemControl({
          item: legacy.item,
          events: latestLegacyControlEvents(legacy.events),
          runs: legacyControlRuns(legacy.runs),
          now,
        }),
      };
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

function latestLegacyControlEvents(events: unknown): ItemControlEventInput[] {
  if (!Array.isArray(events)) return [];
  const latest = new Map<string, { event: ItemControlEventInput; millis: number; index: number }>();
  for (const [index, value] of events.entries()) {
    const event = record(value);
    const type = typeof event?.type === "string" ? event.type : "";
    if (type !== "claim.created" && type !== "work.handed_off") continue;
    const createdAt = event?.createdAt;
    const millis = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    const candidate = {
      event: {
        actorId: event?.actorId ?? null,
        type,
        payload: event?.payload ?? {},
        createdAt,
      },
      millis: Number.isFinite(millis) ? millis : Number.NEGATIVE_INFINITY,
      index,
    };
    const previous = latest.get(type);
    if (
      !previous
      || candidate.millis > previous.millis
      || (candidate.millis === previous.millis && candidate.index > previous.index)
    ) {
      latest.set(type, candidate);
    }
  }
  return ["claim.created", "work.handed_off"].flatMap((type) => {
    const candidate = latest.get(type);
    return candidate ? [candidate.event] : [];
  });
}

function legacyControlRuns(runs: unknown): ItemControlRunInput[] {
  if (!Array.isArray(runs)) return [];
  return runs.slice(0, 16).flatMap((value) => {
    const run = record(value);
    if (!run) return [];
    return [{
      actorId: run.actorId ?? null,
      leaseOwnerId: run.leaseOwnerId ?? null,
      status: run.status ?? "",
      leaseExpiresAt: run.leaseExpiresAt ?? null,
      lastHeartbeatAt: run.lastHeartbeatAt ?? null,
    }];
  });
}

function isMissingItemControlFunction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Could not find public function for ['"`]itemControl:get['"`]/i.test(message);
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
