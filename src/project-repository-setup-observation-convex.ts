import { randomUUID } from "node:crypto";
import type { FunctionReference } from "convex/server";
import {
  createProjectRepositorySetupObservationRecord,
  prepareProjectRepositorySetupObservation,
  type ProjectRepositorySetupObservationLedger,
  type ProjectRepositorySetupObservationRecord,
  type ProjectRepositorySetupObservationResult,
  type RecordProjectRepositorySetupObservationInput,
} from "./project-repository-setup-observation.js";
import { convexApi, type ConvexClientLike } from "../convex/refs.js";

export interface ConvexProjectRepositorySetupObservationLedgerOptions {
  client: ConvexClientLike;
  serviceSecret: string;
  workspace: string;
}

interface ConvexObservation {
  id: string;
  project: string;
  repositoryFullName: string;
  defaultBranch: string;
  sourceKind: ProjectRepositorySetupObservationRecord["sourceKind"];
  semanticFingerprint: string;
  observedAt: string;
}

interface ConvexObservationResult {
  observation: ConvexObservation;
  replayed: boolean;
  replacedObservationId: string | null;
}

export class ConvexProjectRepositorySetupObservationLedger
  implements ProjectRepositorySetupObservationLedger
{
  readonly client: ConvexClientLike;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexProjectRepositorySetupObservationLedgerOptions) {
    this.client = options.client;
    this.serviceSecret = requiredText(options.serviceSecret, "Convex service secret");
    this.workspace = requiredText(options.workspace, "Convex workspace");
  }

  async getProjectRepositorySetupObservation(
    project: string,
  ): Promise<ProjectRepositorySetupObservationRecord | null> {
    const result = await this.client.query(
      convexApi.projectRepositorySetupObservations.getCurrent as FunctionReference<"query">,
      {
        serviceSecret: this.serviceSecret,
        workspace: this.workspace,
        project,
      },
    ) as ConvexObservation | null;
    return result ? mapObservation(result) : null;
  }

  async recordProjectRepositorySetupObservation(
    input: RecordProjectRepositorySetupObservationInput,
  ): Promise<ProjectRepositorySetupObservationResult> {
    const prepared = prepareProjectRepositorySetupObservation(null, input);
    const result = await this.client.mutation(
      convexApi.projectRepositorySetupObservations.record as FunctionReference<"mutation">,
      {
        serviceSecret: this.serviceSecret,
        workspace: this.workspace,
        project: prepared.project,
        externalId: `repo_setup_${randomUUID()}`,
        repositoryFullName: prepared.repositoryFullName,
        defaultBranch: prepared.defaultBranch,
        sourceKind: prepared.sourceKind,
        semanticFingerprint: prepared.semanticFingerprint,
      },
    ) as ConvexObservationResult;
    return {
      observation: mapObservation(result.observation),
      replayed: result.replayed === true,
      replacedObservationId: result.replacedObservationId,
    };
  }
}

function mapObservation(value: ConvexObservation): ProjectRepositorySetupObservationRecord {
  return createProjectRepositorySetupObservationRecord(value);
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
