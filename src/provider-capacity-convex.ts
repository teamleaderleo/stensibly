import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  ProviderCapacityConflictError,
  ProviderCapacityStorageError,
  projectCodeRabbitCapacityObservation,
  type CodeRabbitCapacityObservation,
  type CodeRabbitCapacitySnapshot,
  type IngestCodeRabbitCapacityInput,
} from "./provider-capacity.js";

const ingestRef = makeFunctionReference<"mutation">("providerCapacities:ingestCodeRabbit");
const latestRef = makeFunctionReference<"query">("providerCapacities:latestCodeRabbit");

export interface ProviderCapacityService {
  ingestCodeRabbit(input: IngestCodeRabbitCapacityInput): Promise<{
    observation: CodeRabbitCapacityObservation;
    duplicate: boolean;
  }>;
  snapshot(repository: string, subjectLogin: string, now?: number): Promise<CodeRabbitCapacitySnapshot>;
}

export interface ConvexProviderCapacityServiceOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
  availableFreshnessMs?: number;
}

interface ConvexObservation {
  id: string;
  provider: "coderabbit";
  sourceCommentId: string;
  repository: string;
  pullRequestNumber: number;
  subjectLogin: string;
  subjectBasis: "pull_request_author_proxy";
  state: "available" | "unavailable";
  remaining: number | null;
  limit: number | null;
  refillAt: number | null;
  observedAt: number;
  receivedAt: number;
}

export class ConvexProviderCapacityService implements ProviderCapacityService {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;
  readonly availableFreshnessMs: number | undefined;

  constructor(options: ConvexProviderCapacityServiceOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = normalizeWorkspace(options.workspace ?? "default");
    this.availableFreshnessMs = options.availableFreshnessMs;
  }

  async ingestCodeRabbit(input: IngestCodeRabbitCapacityInput) {
    try {
      const result = await this.client.mutation(ingestRef, this.args({
        deliveryId: input.deliveryId,
        payloadDigest: input.payloadDigest,
        sourceCommentId: input.sourceCommentId,
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        subjectLogin: input.subjectLogin,
        providerState: input.state,
        remaining: input.remaining,
        quotaLimit: input.limit,
        refillAt: input.refillAt === null ? null : Date.parse(input.refillAt),
        observedAt: Date.parse(input.observedAt),
        receivedAt: Date.parse(input.receivedAt),
      })) as { duplicate: boolean; observation: ConvexObservation };
      return {
        duplicate: result.duplicate,
        observation: mapObservation(result.observation, input.deliveryId),
      };
    } catch (error) {
      throw mapProviderCapacityError(error);
    }
  }

  async snapshot(repository: string, subjectLogin: string, now = Date.now()) {
    const raw = await this.client.query(latestRef, this.args({
      repository,
      subjectLogin,
    })) as ConvexObservation | null;
    return projectCodeRabbitCapacityObservation(
      raw ? mapObservation(raw, "") : null,
      repository,
      subjectLogin,
      now,
      this.availableFreshnessMs,
    );
  }

  private args(input: Record<string, unknown>): Record<string, unknown> {
    return { ...input, serviceSecret: this.serviceSecret, workspace: this.workspace };
  }
}

function mapObservation(input: ConvexObservation, deliveryId: string): CodeRabbitCapacityObservation {
  return {
    id: input.id,
    provider: "coderabbit",
    deliveryId,
    sourceCommentId: input.sourceCommentId,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    subjectLogin: input.subjectLogin,
    subjectBasis: "pull_request_author_proxy",
    state: input.state,
    remaining: input.remaining,
    limit: input.limit,
    refillAt: input.refillAt === null ? null : new Date(input.refillAt).toISOString(),
    observedAt: new Date(input.observedAt).toISOString(),
    receivedAt: new Date(input.receivedAt).toISOString(),
  };
}

function mapProviderCapacityError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PROVIDER_CAPACITY_DELIVERY_CONFLICT")) {
    return new ProviderCapacityConflictError(
      "GitHub delivery identity was reused with different provider capacity content",
    );
  }
  if (message.includes("PROVIDER_CAPACITY_DELIVERY_LIMIT") || message.includes("PROVIDER_CAPACITY_STORAGE_LIMIT")) {
    return new ProviderCapacityStorageError();
  }
  return error instanceof Error ? error : new Error("Provider capacity backend failed");
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeWorkspace(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]{0,79}$/.test(normalized)) {
    throw new Error("Workspace must be a lowercase slug up to 80 characters");
  }
  return normalized;
}
