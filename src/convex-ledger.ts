import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { convexApi } from "../convex/refs.ts";
import type {
  ActorActionInput,
  AttachWorkArtifactInput,
  BlockWorkInput,
  ClaimWorkInput,
  CompleteWorkInput,
  CreateWorkInput,
  HandoffWorkInput,
  ListWorkInput,
  RecordWorkEventInput,
  UnblockWorkInput,
  WorkLedger,
} from "./ledger.ts";

export interface ConvexCaller {
  query(reference: FunctionReference<"query">, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
}

export interface ConvexWorkLedgerOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class ConvexWorkLedger implements WorkLedger {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexWorkLedgerOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = normalizeWorkspace(options.workspace ?? "default");
  }

  async getBrief(project: string, limit: number) {
    return await this.client.query(convexApi.projects.brief, this.args({ project, limit }));
  }

  async listWork(input: ListWorkInput = {}) {
    return await this.client.query(convexApi.items.list, this.args(input)) as Awaited<ReturnType<WorkLedger["listWork"]>>;
  }

  async getItem(id: string) {
    return await this.client.query(convexApi.items.get, this.args({ id })) as Awaited<ReturnType<WorkLedger["getItem"]>>;
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

  async renewClaim(input: ClaimWorkInput) {
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

  async releaseWork(input: ActorActionInput) {
    return await this.client.mutation(convexApi.claims.release, this.args(input)) as Awaited<ReturnType<WorkLedger["releaseWork"]>>;
  }

  async recordEvent(input: RecordWorkEventInput) {
    return await this.client.mutation(convexApi.events.record, this.args(input)) as Awaited<ReturnType<WorkLedger["recordEvent"]>>;
  }

  async completeWork(input: CompleteWorkInput) {
    return await this.client.mutation(convexApi.items.complete, this.args(input)) as Awaited<ReturnType<WorkLedger["completeWork"]>>;
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
