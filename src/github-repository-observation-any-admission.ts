import type { GitHubRepositoryObservation } from "./github-repository-observation.js";
import {
  admitGitHubRepositoryObservationEnvelope,
  admitHostedGitHubRepositoryObservationInput,
  MAXIMUM_GITHUB_REPOSITORY_OBSERVATION_BYTES,
  snapshotBoundedJson,
  type AdmittedGitHubRepositoryObservation,
  type BoundedJsonValue,
} from "./github-repository-observation-admission.js";
import {
  admitHostedPublicGitHubRepositoryObservationInput,
  admitPublicGitHubRepositoryObservationEnvelope,
} from "./github-public-repository-observation-admission.js";
import type { PublicGitHubRepositoryObservation } from "./github-public-repository-observation.js";

export type AnyGitHubRepositoryObservation =
  | GitHubRepositoryObservation
  | PublicGitHubRepositoryObservation;

export interface AdmittedAnyGitHubRepositoryObservation
  extends Omit<AdmittedGitHubRepositoryObservation, "observation"> {
  readonly observation: AnyGitHubRepositoryObservation;
}

export function admitAnyHostedGitHubRepositoryObservationInput(
  value: unknown,
): AdmittedAnyGitHubRepositoryObservation {
  const sourceSchema = hostedSourceSchema(value);
  return sourceSchema === "github-public-events"
    ? admitHostedPublicGitHubRepositoryObservationInput(value)
    : admitHostedGitHubRepositoryObservationInput(value);
}

export function admitAnyGitHubRepositoryObservationEnvelope(
  value: unknown,
): AdmittedAnyGitHubRepositoryObservation {
  const sourceSchema = envelopeSourceSchema(value);
  return sourceSchema === "github-public-events"
    ? admitPublicGitHubRepositoryObservationEnvelope(value)
    : admitGitHubRepositoryObservationEnvelope(value);
}

function hostedSourceSchema(value: unknown): string | null {
  const detached = snapshotBoundedJson(value, "GitHub repository observation input");
  const input = record(detached, "GitHub repository observation input");
  const observation = record(
    input.observation,
    "GitHub repository observation input observation",
  );
  return typeof observation.sourceSchema === "string"
    ? observation.sourceSchema
    : null;
}

function envelopeSourceSchema(value: unknown): string | null {
  const detached = snapshotBoundedJson(value, "GitHub repository observation envelope");
  const envelope = record(detached, "GitHub repository observation envelope");
  const observationJson = envelope.observationJson;
  if (typeof observationJson !== "string") return null;
  if (
    observationJson.length > MAXIMUM_GITHUB_REPOSITORY_OBSERVATION_BYTES
    || new TextEncoder().encode(observationJson).byteLength
      > MAXIMUM_GITHUB_REPOSITORY_OBSERVATION_BYTES
  ) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(observationJson);
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(decoded, "sourceSchema");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

function record(
  value: BoundedJsonValue | undefined,
  label: string,
): Record<string, BoundedJsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a record`);
  }
  return value as Record<string, BoundedJsonValue>;
}
