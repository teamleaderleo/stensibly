import { makeFunctionReference, type FunctionReference } from "convex/server";
import { admitMailboxSubscriptionStateJson } from "./mailbox-intake-admission.js";
import {
  exactMailThreadIdentifier,
  freezeMailThreadRecord,
} from "./mail-thread-contract.js";
import { freezeMailProviderProjection } from "./mail-provider.js";
import type {
  ProjectCorrespondenceEffectState,
  ProjectCorrespondenceObservationV1,
  ProjectCorrespondenceSourceResultV1,
  ProjectCorrespondenceSourceV1,
} from "./project-correspondence.js";

export interface ProjectCorrespondenceConvexCaller {
  query(reference: FunctionReference<"query">, args: Record<string, unknown>): Promise<unknown>;
}

export interface ConvexProjectCorrespondenceSourceOptions {
  client: ProjectCorrespondenceConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

const listProjectSourcesRef = makeFunctionReference<"query">(
  "mailCorrespondence:listProjectSources",
);
const effectStates = new Set<ProjectCorrespondenceEffectState>([
  "reserved",
  "sent",
  "ambiguous",
  "failed",
  "reconciled",
]);

export class ConvexProjectCorrespondenceSource implements ProjectCorrespondenceSourceV1 {
  readonly #client: ProjectCorrespondenceConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: ConvexProjectCorrespondenceSourceOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Project correspondence Convex options are required");
    }
    if (!options.client || typeof options.client.query !== "function") {
      throw new TypeError("Project correspondence Convex client is required");
    }
    this.#client = options.client;
    this.#serviceSecret = secret(options.serviceSecret);
    this.#workspace = workspaceSlug(options.workspace ?? "default");
  }

  async listProject(request: {
    project: string;
    limit: number;
    asOf: string;
  }): Promise<ProjectCorrespondenceSourceResultV1> {
    const project = exactMailThreadIdentifier(request.project, "Correspondence project", 120);
    const value = responseRecord(await this.#client.query(
      listProjectSourcesRef,
      {
        serviceSecret: this.#serviceSecret,
        workspace: this.#workspace,
        project,
        limit: request.limit,
      },
    ), "Project correspondence source");
    const rows = boundedArray(value.rows, 200, "Project correspondence source rows");
    const candidates = rows.map((raw) => {
      const row = responseRecord(raw, "Project correspondence source row");
      const thread = freezeMailThreadRecord(json(row.threadJson, "Project correspondence thread"));
      if (thread.workspace !== this.#workspace || thread.project !== project) {
        throw new Error("Hosted project correspondence thread escaped scope");
      }
      const providerProjection = freezeMailProviderProjection(
        json(row.projectionJson, "Project correspondence provider projection"),
      );
      const mailboxState = admitMailboxSubscriptionStateJson(row.mailboxStateJson);
      const effects = boundedArray(row.effects, 16, "Project correspondence effects").map((rawEffect) => {
        const effect = responseRecord(rawEffect, "Project correspondence effect");
        const state = effectState(effect.state);
        const reservedAt = epochTimestamp(effect.reservedAt, "Project correspondence reservation time");
        const settledAt = effect.settledAt === null
          ? null
          : epochTimestamp(effect.settledAt, "Project correspondence settlement time");
        return Object.freeze({
          outboundEffectId: exactMailThreadIdentifier(
            effect.outboundEffectId,
            "Project correspondence outbound effect ID",
            240,
          ),
          state,
          reservedAt,
          settledAt,
        });
      });
      const observations = boundedArray(
        row.observations,
        16,
        "Project correspondence observations",
      ).map((rawObservation) => {
        const observation = responseRecord(rawObservation, "Project correspondence observation");
        return Object.freeze({
          observationId: exactMailThreadIdentifier(
            observation.observationId,
            "Project correspondence observation ID",
            240,
          ),
          eventType: mailboxEventType(observation.eventType),
          providerMessageId: optionalIdentifier(
            observation.providerMessageId,
            "Project correspondence provider message ID",
            320,
          ),
          providerThreadId: optionalIdentifier(
            observation.providerThreadId,
            "Project correspondence provider thread ID",
            320,
          ),
          observedAt: canonicalTimestamp(
            observation.observedAt,
            "Project correspondence observation time",
          ),
        } satisfies ProjectCorrespondenceObservationV1);
      });
      return Object.freeze({
        thread,
        providerProjection,
        mailboxState,
        effects: Object.freeze(effects),
        observations: Object.freeze(observations),
        truncated: boolean(row.truncated, "Project correspondence row truncation"),
      });
    });

    return Object.freeze({
      candidates: Object.freeze(candidates),
      threadsWithoutProviderProjection: nonNegativeCount(
        value.threadsWithoutProviderProjection,
        "Project correspondence missing provider projection",
      ),
      providerViewsWithoutMailboxState: nonNegativeCount(
        value.providerViewsWithoutMailboxState,
        "Project correspondence missing mailbox state",
      ),
      truncated: boolean(value.truncated, "Project correspondence source truncation"),
    });
  }
}

function json(value: unknown, label: string): any {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 * 1024) {
    throw new TypeError(`${label} JSON is invalid`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`${label} JSON is invalid`);
  }
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} response is invalid`);
  }
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function effectState(value: unknown): ProjectCorrespondenceEffectState {
  if (typeof value !== "string" || !effectStates.has(value as ProjectCorrespondenceEffectState)) {
    throw new TypeError("Project correspondence effect state is invalid");
  }
  return value as ProjectCorrespondenceEffectState;
}

function mailboxEventType(value: unknown): ProjectCorrespondenceObservationV1["eventType"] {
  if (
    value === "mail.message.created"
    || value === "mail.message.updated"
    || value === "mail.message.deleted"
    || value === "mail.scope.added"
    || value === "mail.scope.removed"
    || value === "mail.subscription.degraded"
    || value === "mail.subscription.recovered"
  ) return value;
  throw new TypeError("Project correspondence observation event type is invalid");
}

function epochTimestamp(value: unknown, label: string): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return new Date(value as number).toISOString();
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  if (canonical !== value) throw new TypeError(`${label} is invalid`);
  return value;
}

function optionalIdentifier(value: unknown, label: string, max: number): string | null {
  return value === null ? null : exactMailThreadIdentifier(value, label, max);
}

function nonNegativeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new RangeError(`${label} count is invalid`);
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function workspaceSlug(value: string): string {
  if (typeof value !== "string") throw new TypeError("Project correspondence workspace is invalid");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/u.test(normalized) || normalized.length > 80) {
    throw new TypeError("Project correspondence workspace is invalid");
  }
  return normalized;
}

function secret(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 64 * 1024) {
    throw new TypeError("Project correspondence service secret is required");
  }
  return value;
}
