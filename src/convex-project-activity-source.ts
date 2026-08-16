import { makeFunctionReference, type FunctionReference } from "convex/server";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import {
  admitDurableProjectActivityOrchestratorV1,
  type DurableProjectActivityOrchestratorV1,
} from "./project-activity-durable-orchestrator.js";

export interface ProjectActivityOrchestratorSourceRequestV1 {
  readonly project: string;
  readonly limit: number;
}

export interface ProjectActivityOrchestratorSourceV1 {
  listRecent(
    request: ProjectActivityOrchestratorSourceRequestV1,
  ): Promise<DurableProjectActivityOrchestratorV1>;
}

export interface ProjectActivityConvexCaller {
  query(reference: FunctionReference<"query">, args: Record<string, unknown>): Promise<unknown>;
}

export interface ConvexProjectActivitySourceOptions {
  readonly client: ProjectActivityConvexCaller;
  readonly serviceSecret: string;
  readonly workspace?: string;
}

const recentListRef = makeFunctionReference<"query">(
  "orchestratorActivity:listRecentObservations",
);
const slugPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/u;

export class ConvexProjectActivityOrchestratorSource
implements ProjectActivityOrchestratorSourceV1 {
  readonly #client: ProjectActivityConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: ConvexProjectActivitySourceOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Project Activity Convex options are required");
    }
    if (!options.client || typeof options.client.query !== "function") {
      throw new TypeError("Project Activity Convex client is required");
    }
    this.#client = options.client;
    this.#serviceSecret = serviceSecret(options.serviceSecret);
    this.#workspace = slug(options.workspace ?? "default", "workspace");
  }

  async listRecent(
    request: ProjectActivityOrchestratorSourceRequestV1,
  ): Promise<DurableProjectActivityOrchestratorV1> {
    if (!request || typeof request !== "object") {
      throw new TypeError("Project Activity source request is required");
    }
    const project = slug(request.project, "project");
    const limit = activityLimit(request.limit);
    const admitted = admitDurableProjectActivityOrchestratorV1(
      await this.#client.query(recentListRef, {
        serviceSecret: this.#serviceSecret,
        workspace: this.#workspace,
        project,
        limit,
      }),
    );
    for (const observation of admitted.orchestrator) {
      if (
        observation.workspace !== this.#workspace
        || observation.project !== project
      ) {
        throw new Error("Hosted Project Activity observation escaped source scope");
      }
    }
    return admitted;
  }
}

function activityLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 50) {
    throw new RangeError("Project Activity source limit must be an integer from 1 to 50");
  }
  return value as number;
}

function slug(value: unknown, label: string): string {
  if (typeof value !== "string" || !slugPattern.test(value)) {
    throw new TypeError(`Project Activity ${label} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new TypeError(`Project Activity ${label} cannot contain credential material`);
  }
  return value;
}

function serviceSecret(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 64 * 1024
    || value !== value.trim()
  ) {
    throw new TypeError("Project Activity service secret is required");
  }
  return value;
}
