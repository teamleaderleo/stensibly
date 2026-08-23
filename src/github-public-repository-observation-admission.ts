import {
  admitGitHubRepositoryObservationEnvelope,
  MAXIMUM_GITHUB_REPOSITORY_OBSERVATION_BYTES,
  snapshotBoundedJson,
  type AdmittedGitHubRepositoryObservation,
  type BoundedJsonValue,
} from "./github-repository-observation-admission.js";
import type { PublicGitHubRepositoryObservation } from "./github-public-repository-observation.js";
import {
  canonicalJsonString,
  fingerprintCanonicalRequest,
} from "./idempotency-request-fingerprint.js";

const envelopeKeys = [
  "deliveryId",
  "eventType",
  "observationJson",
  "payloadDigest",
  "receivedAt",
] as const;
const hostedInputKeys = [
  "deliveryId",
  "eventType",
  "observation",
  "payloadDigest",
  "receivedAt",
] as const;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const deliveryPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface AdmittedPublicGitHubRepositoryObservation
  extends Omit<AdmittedGitHubRepositoryObservation, "observation"> {
  readonly observation: PublicGitHubRepositoryObservation;
}

export function admitHostedPublicGitHubRepositoryObservationInput(
  value: unknown,
): AdmittedPublicGitHubRepositoryObservation {
  const snapshot = closedRecord(
    snapshotBoundedJson(value, "GitHub public repository observation input"),
    hostedInputKeys,
    "GitHub public repository observation input",
  );
  const receivedAt = exactString(
    snapshot.receivedAt,
    "GitHub public repository observation receipt time",
    64,
  );
  const parsedReceivedAt = new Date(receivedAt);
  if (Number.isNaN(parsedReceivedAt.getTime()) || parsedReceivedAt.toISOString() !== receivedAt) {
    throw new RangeError("GitHub public repository observation receipt time must be canonical ISO UTC");
  }
  return admitPublicGitHubRepositoryObservationEnvelope({
    deliveryId: exactString(snapshot.deliveryId, "GitHub public event delivery ID", 128),
    eventType: exactString(snapshot.eventType, "GitHub public event type", 64),
    payloadDigest: exactString(snapshot.payloadDigest, "GitHub public event payload digest", 71),
    receivedAt: parsedReceivedAt.getTime(),
    observationJson: canonicalJsonString(snapshot.observation),
  });
}

export function admitPublicGitHubRepositoryObservationEnvelope(
  value: unknown,
): AdmittedPublicGitHubRepositoryObservation {
  const snapshot = closedRecord(
    snapshotBoundedJson(value, "GitHub public repository observation envelope"),
    envelopeKeys,
    "GitHub public repository observation envelope",
  );
  const deliveryId = exactPattern(
    snapshot.deliveryId,
    "GitHub public event delivery ID",
    deliveryPattern,
  );
  const eventType = exactString(snapshot.eventType, "GitHub public event type", 64);
  if (eventType !== "pull_request" && eventType !== "pull_request_review") {
    throw new RangeError("GitHub public event type is unsupported");
  }
  const payloadDigest = exactPattern(
    snapshot.payloadDigest,
    "GitHub public event payload digest",
    digestPattern,
  );
  if (
    typeof snapshot.receivedAt !== "number"
    || !Number.isSafeInteger(snapshot.receivedAt)
    || snapshot.receivedAt < 0
  ) {
    throw new RangeError("GitHub public event receipt time is invalid");
  }
  const receivedAt = snapshot.receivedAt;
  const observationJson = exactString(
    snapshot.observationJson,
    "GitHub public repository observation JSON",
    MAXIMUM_GITHUB_REPOSITORY_OBSERVATION_BYTES,
    true,
  );
  if (new TextEncoder().encode(observationJson).byteLength > MAXIMUM_GITHUB_REPOSITORY_OBSERVATION_BYTES) {
    throw new RangeError("GitHub public repository observation JSON is oversized");
  }

  let decodedValue: unknown;
  try {
    decodedValue = JSON.parse(observationJson);
  } catch {
    throw new RangeError("GitHub public repository observation must be valid JSON");
  }
  const decoded = record(
    snapshotBoundedJson(decodedValue, "GitHub public repository observation"),
    "GitHub public repository observation",
  );
  if (canonicalJsonString(decoded) !== observationJson) {
    throw new RangeError("GitHub public repository observation JSON must be canonical");
  }
  if (
    decoded.version !== 1
    || decoded.provider !== "github"
    || decoded.sourceSchema !== "github-public-events"
    || decoded.sourceSchemaVersion !== "2022-11-28"
    || decoded.containsRawContent !== false
    || decoded.deliveryId !== deliveryId
    || decoded.eventType !== eventType
    || decoded.payloadDigest !== payloadDigest
    || decoded.receivedAt !== new Date(receivedAt).toISOString()
  ) {
    throw new RangeError("GitHub public repository observation identity is inconsistent");
  }
  const observationId = exactString(
    decoded.observationId,
    "GitHub public observation ID",
    256,
  );
  if (observationId !== `github-public:${eventType}:${deliveryId}`) {
    throw new RangeError("GitHub public repository observation ID is inconsistent");
  }
  const semanticFingerprint = exactPattern(
    decoded.semanticFingerprint,
    "GitHub public semantic fingerprint",
    digestPattern,
  );
  const publicSemantics = withoutEnvelopeIdentity(decoded);
  if (fingerprintCanonicalRequest(publicSemantics) !== semanticFingerprint) {
    throw new RangeError("GitHub public repository observation semantic fingerprint is invalid");
  }

  const translatedSemantics = {
    ...publicSemantics,
    sourceSchema: "github-webhook",
  };
  const translated = {
    ...decoded,
    sourceSchema: "github-webhook",
    observationId: `github:${eventType}:${deliveryId}`,
    semanticFingerprint: fingerprintCanonicalRequest(translatedSemantics),
  };
  const admitted = admitGitHubRepositoryObservationEnvelope({
    deliveryId,
    eventType,
    payloadDigest,
    receivedAt,
    observationJson: canonicalJsonString(translated),
  });

  return Object.freeze({
    ...admitted,
    observation: decoded as unknown as PublicGitHubRepositoryObservation,
    observationJson,
    observationId,
    semanticFingerprint,
  });
}

function withoutEnvelopeIdentity(
  decoded: Record<string, BoundedJsonValue>,
): Record<string, BoundedJsonValue> {
  const {
    observationId: _observationId,
    deliveryId: _deliveryId,
    payloadDigest: _payloadDigest,
    semanticFingerprint: _semanticFingerprint,
    receivedAt: _receivedAt,
    ...semantics
  } = decoded;
  return semantics;
}

function closedRecord(
  value: BoundedJsonValue,
  keys: readonly string[],
  label: string,
): Record<string, BoundedJsonValue> {
  const object = record(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new RangeError(`${label} has noncanonical fields`);
  }
  return object;
}

function record(
  value: BoundedJsonValue,
  label: string,
): Record<string, BoundedJsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a record`);
  }
  return value as Record<string, BoundedJsonValue>;
}

function exactString(
  value: unknown,
  label: string,
  maximum: number,
  allowLargeCodeUnits = false,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || (!allowLargeCodeUnits && value.length > maximum)
    || value !== value.trim()
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactPattern(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  const text = exactString(value, label, 256);
  if (!pattern.test(text)) throw new RangeError(`${label} is invalid`);
  return text;
}
