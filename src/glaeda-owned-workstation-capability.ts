import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import { sha256Hex } from "./sha256.js";

export const GLAEDA_CAPABILITY_ARTIFACT_SCHEMA =
  "glaeda-owned-workstation-capability-artifact/v1";
export const GLAEDA_CAPABILITY_SNAPSHOT_SCHEMA =
  "glaeda-owned-workstation-capability/v1";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OID_PATTERN = /^[a-f0-9]{40}$/u;
const NODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const MAX_SNAPSHOT_BYTES = 4_096;
const DEFAULT_MAX_VALIDITY_MS = 300_000;
const VERIFY_REQUIRED_MAX_VALIDITY_MS = 1_800_000;
const MAX_FUTURE_SKEW_MS = 30_000;

export interface GlaedaPythonRuntimeEvidenceV1 {
  executableSha256: string;
  version: string;
}

export interface GlaedaCapabilityTargetV1 {
  node: {
    id: string;
    generation: number;
    osClass: "linux" | "macos";
    architectureClass: "x86_64" | "arm64";
    glaedaRuntimeSha256: string;
  };
  profile: {
    id: "repo-query/v1" | "verify-focused/v1" | "verify-required/v1";
    class: "repo_query" | "verify_focused" | "verify_required";
    versionSha256: string;
  };
  source: {
    repository: string;
    commitOid: string;
    treeOid: string;
  };
  python: GlaedaPythonRuntimeEvidenceV1;
  now: Date;
}

export interface AdmittedGlaedaCapabilityV1 {
  snapshotSha256: string;
  observedAt: string;
  expiresAt: string;
  heatClass: "resident_cold" | "resident_hot";
}

export function fingerprintGlaedaCapabilitySnapshotV1(snapshot: unknown): string {
  const bytes = `${canonicalJsonString(snapshot)}\n`;
  if (new TextEncoder().encode(bytes).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("Glaeda capability snapshot exceeds the fixed byte ceiling");
  }
  return `sha256:${sha256Hex(bytes)}`;
}

export function admitGlaedaCapabilityArtifactV1(
  artifacts: unknown[],
  target: GlaedaCapabilityTargetV1,
): AdmittedGlaedaCapabilityV1 {
  if (
    !(
      (target.profile.id === "repo-query/v1" && target.profile.class === "repo_query")
      || (target.profile.id === "verify-focused/v1" && target.profile.class === "verify_focused")
      || (target.profile.id === "verify-required/v1" && target.profile.class === "verify_required")
    )
    || !SHA256_PATTERN.test(target.profile.versionSha256)
  ) throw new Error("Glaeda capability target profile is invalid");
  const candidates = artifacts.map((value) => capabilityArtifact(value)).filter(
    (value): value is { snapshot: Record<string, unknown>; snapshotSha256: string } => value !== null,
  );
  if (candidates.length !== 1) {
    throw new Error("Runner context must contain exactly one Glaeda capability artifact");
  }
  const candidate = candidates[0]!;
  const expectedDigest = fingerprintGlaedaCapabilitySnapshotV1(candidate.snapshot);
  if (candidate.snapshotSha256 !== expectedDigest) {
    throw new Error("Glaeda capability artifact digest changed");
  }
  const uri = `urn:stensibly:glaeda-capability:${expectedDigest}`;
  const original = artifacts.find((value) => {
    if (!record(value)) return false;
    const metadata = record(value.metadata) ? value.metadata : null;
    return metadata?.schema === GLAEDA_CAPABILITY_ARTIFACT_SCHEMA;
  }) as Record<string, unknown>;
  if (original.uri !== uri || original.kind !== "other") {
    throw new Error("Glaeda capability artifact URI or kind changed");
  }

  const snapshot = exactRecord(candidate.snapshot, [
    "admission", "advisoryOnly", "authorizesDispatch", "authorizesExecution",
    "expiresAt", "node", "observedAt", "producer", "profiles", "projects", "schema",
  ], "Glaeda capability snapshot");
  if (
    snapshot.schema !== GLAEDA_CAPABILITY_SNAPSHOT_SCHEMA
    || snapshot.advisoryOnly !== true
    || snapshot.authorizesDispatch !== false
    || snapshot.authorizesExecution !== false
  ) throw new Error("Glaeda capability snapshot authority contract changed");

  const node = exactRecord(snapshot.node, [
    "architectureClass", "generation", "id", "osClass",
  ], "Glaeda capability node");
  if (
    node.id !== target.node.id
    || node.generation !== target.node.generation
    || node.osClass !== target.node.osClass
    || node.architectureClass !== target.node.architectureClass
    || !NODE_PATTERN.test(text(node.id, "node ID"))
  ) throw new Error("Glaeda capability node does not match this physical target");

  const observedAt = timestamp(snapshot.observedAt, "capability observation");
  const expiresAt = timestamp(snapshot.expiresAt, "capability expiry");
  const now = target.now.getTime();
  const maxValidity = target.profile.id === "verify-required/v1"
    ? VERIFY_REQUIRED_MAX_VALIDITY_MS
    : DEFAULT_MAX_VALIDITY_MS;
  if (!Number.isFinite(now)) throw new Error("Glaeda capability admission time is invalid");
  if (
    observedAt.ms > now + MAX_FUTURE_SKEW_MS
    || expiresAt.ms <= now
    || expiresAt.ms <= observedAt.ms
    || expiresAt.ms - observedAt.ms > maxValidity
  ) throw new Error("Glaeda capability snapshot is stale or has an invalid validity window");

  const admission = exactRecord(snapshot.admission, [
    "activeWorkloadsClass", "availabilityClass", "pressureClass",
  ], "Glaeda capability admission");
  if (
    !["available", "blocked"].includes(text(admission.availabilityClass, "availability class"))
    || admission.availabilityClass !== "available"
    || admission.activeWorkloadsClass !== "unobserved"
    || admission.pressureClass !== "unobserved"
  ) throw new Error("Glaeda capability snapshot does not currently admit this node");

  const producer = exactRecord(snapshot.producer, [
    "glaedaRuntimeSha256", "python", "workspaceCapabilitySha256",
  ], "Glaeda capability producer");
  if (
    sha256(producer.glaedaRuntimeSha256, "Glaeda runtime") !== target.node.glaedaRuntimeSha256
    || !SHA256_PATTERN.test(text(producer.workspaceCapabilitySha256, "workspace capability"))
  ) throw new Error("Glaeda capability producer generation changed");
  const python = exactRecord(producer.python, ["executableSha256", "version"], "Python capability");
  if (
    python.executableSha256 !== target.python.executableSha256
    || python.version !== target.python.version
    || !/^3\.14\.\d+(?:[+a-z0-9.-]*)?$/iu.test(text(python.version, "Python version"))
    || !SHA256_PATTERN.test(text(python.executableSha256, "Python executable"))
  ) throw new Error("Glaeda capability Python runtime changed");

  const profiles = boundedArray(snapshot.profiles, 1, 8, "Glaeda capability profiles");
  const matchingProfiles = profiles.filter((value) => {
    const profile = exactRecord(value, ["class", "id", "versionSha256"], "Glaeda capability profile");
    return profile.id === target.profile.id
      && profile.class === target.profile.class
      && profile.versionSha256 === target.profile.versionSha256;
  });
  if (matchingProfiles.length !== 1) {
    throw new Error("Glaeda capability does not support the exact requested profile");
  }

  const projects = boundedArray(snapshot.projects, 1, 8, "Glaeda capability projects");
  const matchingProjects = projects.filter((value) => {
    const project = exactRecord(value, [
      "heatClass", "repository", "source", "sourceObjectClass", "verificationProfiles",
    ], "Glaeda capability project");
    const source = exactRecord(project.source, ["commitOid", "treeOid"], "Glaeda capability source");
    const verificationProfiles = boundedStrings(
      project.verificationProfiles,
      1,
      8,
      "verification profiles",
    );
    return project.repository === target.source.repository
      && source.commitOid === target.source.commitOid
      && source.treeOid === target.source.treeOid
      && project.sourceObjectClass === "exact_commit_and_tree_present"
      && (
        target.profile.id === "repo-query/v1"
        || verificationProfiles.includes(target.profile.id)
      )
      && ["resident_cold", "resident_hot"].includes(text(project.heatClass, "heat class"));
  });
  if (matchingProjects.length !== 1) {
    throw new Error("Glaeda capability does not contain the exact resident source");
  }
  const heatClass = (matchingProjects[0] as Record<string, unknown>).heatClass as
    "resident_cold" | "resident_hot";
  return Object.freeze({
    snapshotSha256: expectedDigest,
    observedAt: observedAt.value,
    expiresAt: expiresAt.value,
    heatClass,
  });
}

function capabilityArtifact(
  value: unknown,
): { snapshot: Record<string, unknown>; snapshotSha256: string } | null {
  if (!record(value) || !record(value.metadata)) return null;
  if (value.metadata.schema !== GLAEDA_CAPABILITY_ARTIFACT_SCHEMA) return null;
  const metadata = exactRecord(value.metadata, [
    "schema", "snapshot", "snapshotSha256",
  ], "Glaeda capability artifact metadata");
  if (!record(metadata.snapshot)) throw new Error("Glaeda capability snapshot must be an object");
  return {
    snapshot: metadata.snapshot,
    snapshotSha256: sha256(metadata.snapshotSha256, "capability snapshot"),
  };
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!record(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} fields changed`);
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedArray(value: unknown, minimum: number, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedStrings(value: unknown, minimum: number, maximum: number, label: string): string[] {
  const values = boundedArray(value, minimum, maximum, label);
  if (values.some((entry) => typeof entry !== "string" || !entry || entry.length > 80)) {
    throw new Error(`${label} is invalid`);
  }
  return values as string[];
}

function sha256(value: unknown, label: string): string {
  const admitted = text(value, label);
  if (!SHA256_PATTERN.test(admitted)) throw new Error(`${label} digest is invalid`);
  return admitted;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid`);
  return value.trim();
}

function timestamp(value: unknown, label: string): { value: string; ms: number } {
  const admitted = text(value, label);
  const ms = Date.parse(admitted);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== admitted) {
    throw new Error(`${label} must be a canonical millisecond timestamp`);
  }
  return { value: admitted, ms };
}

export function assertGlaedaCapabilitySourceIdentityV1(value: {
  commitOid: string;
  treeOid: string;
}): void {
  if (!OID_PATTERN.test(value.commitOid) || !OID_PATTERN.test(value.treeOid)) {
    throw new Error("Glaeda capability source identity is invalid");
  }
}
