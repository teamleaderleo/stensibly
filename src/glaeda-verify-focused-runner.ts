import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import { inspectPython314InterpreterV1, type Python314InterpreterEvidenceV1 } from
  "./glaeda-github-canary-client.js";
import {
  admitGlaedaCapabilityArtifactV1,
  assertGlaedaCapabilitySourceIdentityV1,
} from "./glaeda-owned-workstation-capability.js";
import {
  GLAEDA_VERIFY_FOCUSED_PROFILE_V1,
  GLAEDA_VERIFY_REQUIRED_PROFILE_V1,
  GlaedaVerifyFocusedWorkstationClientV1,
  fingerprintGlaedaVerificationRequestV1,
  type GlaedaVerificationProfileContractV1,
  type GlaedaVerificationRequestV1,
  type GlaedaVerifyFocusedProcessV1,
} from "./glaeda-verify-focused-workstation-client.js";
import {
  GlaedaWorkstationAdapterV1,
  type GlaedaWorkstationAdapterResultV1,
} from "./glaeda-workstation-adapter.js";
import type { GlaedaWorkstationCommandV1 } from "./glaeda-workstation-contracts.js";
import { RunnerMcpHttpClient } from "./runner-mcp-http-client.js";
import type { ActorInput } from "./schemas.js";
import { sha256Hex } from "./sha256.js";
import { HttpWorkstationCommandLedgerV1 } from "./workstation-command-adapter-http.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OID_PATTERN = /^[a-f0-9]{40}$/u;
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/u;

export interface GlaedaVerifyFocusedNodeV1 {
  id: string;
  generation: number;
  osClass: "linux";
  architectureClass: "x86_64";
  glaedaRuntimeSha256: string;
}

export interface ExecuteGlaedaVerifyFocusedInputV1 {
  runner: RunnerMcpHttpClient;
  project: string;
  runId: string;
  profileGeneration: string;
  pythonInterpreterPath: string;
  verifyScriptPath: string;
  verifyImplementationPath: string;
  repositoryRoot: string;
  stateRoot: string;
  cargoRoot: string;
  rustupRoot: string;
  node: GlaedaVerifyFocusedNodeV1;
  actor?: ActorInput;
  leaseSeconds?: number;
  process?: GlaedaVerifyFocusedProcessV1;
  inspectPythonInterpreter?: (path: string) => Promise<Python314InterpreterEvidenceV1>;
  now?: () => Date;
}

export type ExecuteGlaedaVerifyFocusedResultV1 =
  | { outcome: "idle" }
  | {
    outcome: "waiting_reconciliation";
    runId: string;
    itemId: string;
    commandId: string;
    commandFingerprint: string;
  }
  | {
    outcome: "succeeded" | "failed";
    runId: string;
    itemId: string;
    commandId: string;
    commandFingerprint: string;
    resultSha256: string;
    resultBytes: number;
    terminalClass: string;
    runStatus: string;
  };

export type ExecuteGlaedaVerifyRequiredInputV1 = ExecuteGlaedaVerifyFocusedInputV1;
export type ExecuteGlaedaVerifyRequiredResultV1 = ExecuteGlaedaVerifyFocusedResultV1;

export async function executeGlaedaVerifyFocusedRunV1(
  raw: ExecuteGlaedaVerifyFocusedInputV1,
): Promise<ExecuteGlaedaVerifyFocusedResultV1> {
  return executeGlaedaVerificationRunV1(raw, GLAEDA_VERIFY_FOCUSED_PROFILE_V1);
}

export async function executeGlaedaVerifyRequiredRunV1(
  raw: ExecuteGlaedaVerifyRequiredInputV1,
): Promise<ExecuteGlaedaVerifyRequiredResultV1> {
  return executeGlaedaVerificationRunV1(raw, GLAEDA_VERIFY_REQUIRED_PROFILE_V1);
}

async function executeGlaedaVerificationRunV1(
  raw: ExecuteGlaedaVerifyFocusedInputV1,
  profile: GlaedaVerificationProfileContractV1,
): Promise<ExecuteGlaedaVerifyFocusedResultV1> {
  const input = normalizeInput(raw);
  const actor = input.actor;
  const claimed = await input.runner.call<ClaimedRunEnvelope | null>("claim_runner_work", {
    actor,
    runnerType: "glaeda-workstation",
    runnerProfile: profile.id,
    runnerProfileVersion: input.profileGeneration,
    project: input.project,
    runId: input.runId,
    externalRunId: `glaeda:${input.node.id}:${shortDigest(input.runId)}`,
    leaseSeconds: input.leaseSeconds,
    maxContextCharacters: 12_000,
    idempotencyKey: `claim-glaeda:${input.node.id}:${shortDigest(input.runId)}`,
  });
  if (claimed === null) return { outcome: "idle" };
  admitClaimedRun(claimed, input, actor, profile);
  const { request, capability } = await admitBeforePhysicalDispatch(input, claimed, profile).catch(
    async (error: unknown) => {
      try {
        await input.runner.call("transition_runner_run", {
          id: claimed.run.id,
          actor,
          command: "block",
          expectedGeneration: claimed.run.generation,
          expectedLeaseGeneration: claimed.run.leaseGeneration,
          checkpoint: `Credentialless ${profile.id} admission refused before physical dispatch.`,
          idempotencyKey: `block-glaeda-verification-admission:${shortDigest(claimed.run.id)}`,
        });
      } catch {
        throw new Error("Glaeda verification admission refused and its claim could not be released");
      }
      throw error;
    },
  );

  const running = await input.runner.call<RunnerRecord>("transition_runner_run", {
    id: claimed.run.id,
    actor,
    command: "run",
    expectedGeneration: claimed.run.generation,
    expectedLeaseGeneration: claimed.run.leaseGeneration,
    leaseSeconds: input.leaseSeconds,
    checkpoint: `Admitted exact credentialless ${profile.id} request ${request.requestId}.`,
    usage: { toolCalls: 2 },
    idempotencyKey: `run-glaeda:${shortDigest(claimed.run.id)}`,
  });
  admitRunningRun(running, claimed.run.id, actor.id);

  const client = new GlaedaVerifyFocusedWorkstationClientV1({
    pythonInterpreter: input.pythonInterpreterPath,
    script: input.verifyScriptPath,
    implementation: input.verifyImplementationPath,
    repositoryRoot: input.repositoryRoot,
    stateRoot: input.stateRoot,
    cargoRoot: input.cargoRoot,
    rustupRoot: input.rustupRoot,
    node: { ...input.node, capabilitySnapshotSha256: capability.snapshotSha256 },
    request: profileRequest(request),
    profile,
    ...(input.process ? { process: input.process } : {}),
  });
  const ledger = new HttpWorkstationCommandLedgerV1(input.runner);
  const adapter = new GlaedaWorkstationAdapterV1({ ledger, client, actor });
  const command = commandFor(
    input,
    claimed,
    running,
    request,
    capability.snapshotSha256,
    actor,
    profile,
  );
  const prepared = await adapter.prepare(command);
  let dispatched = await adapter.dispatch(prepared);

  if (dispatched.disposition === "ambiguous_reserved" || dispatched.disposition === "settled_replay") {
    const receipt = await client.reconcile(prepared);
    if (receipt !== null) dispatched = await adapter.reconcile(prepared, receipt);
  }
  if (dispatched.disposition === "ambiguous_reserved") {
    await input.runner.call("transition_runner_run", {
      id: running.id,
      actor,
      command: "wait",
      expectedGeneration: running.generation,
      expectedLeaseGeneration: running.leaseGeneration,
      leaseSeconds: input.leaseSeconds,
      checkpoint: `Reserved ${command.commandId}; physical outcome requires reconciliation.`,
      usage: { toolCalls: 5 },
      idempotencyKey: `wait-glaeda:${shortDigest(running.id)}`,
    });
    return {
      outcome: "waiting_reconciliation",
      runId: running.id,
      itemId: command.itemId,
      commandId: command.commandId,
      commandFingerprint: dispatched.commandFingerprint,
    };
  }
  return finish(input.runner, actor, running, command, dispatched, client, profile);
}

async function admitBeforePhysicalDispatch(
  input: NormalizedInput,
  claimed: ClaimedRunEnvelope,
  profile: GlaedaVerificationProfileContractV1,
) {
  const request = admitRequestArtifact(claimed.context.artifacts, profile);
  if (request.profileVersionSha256 !== input.profileGeneration) {
    throw new Error("Glaeda verification artifact profile generation changed");
  }
  assertGlaedaCapabilitySourceIdentityV1({
    commitOid: request.commitOid,
    treeOid: request.treeOid,
  });
  const python = await input.inspectPythonInterpreter(input.pythonInterpreterPath);
  const capability = admitGlaedaCapabilityArtifactV1(claimed.context.artifacts, {
    node: input.node,
    profile: {
      id: profile.id,
      class: profile.class,
      versionSha256: request.profileVersionSha256,
    },
    source: {
      repository: request.repository,
      commitOid: request.commitOid,
      treeOid: request.treeOid,
    },
    python,
    now: input.now(),
  });
  return { request, capability };
}

async function finish(
  runner: RunnerMcpHttpClient,
  actor: ActorInput,
  running: RunnerRecord,
  command: GlaedaWorkstationCommandV1,
  dispatched: GlaedaWorkstationAdapterResultV1,
  client: GlaedaVerifyFocusedWorkstationClientV1,
  profile: GlaedaVerificationProfileContractV1,
): Promise<ExecuteGlaedaVerifyFocusedResultV1> {
  if (!dispatched.receipt) throw new Error("Settled Glaeda verification run has no local receipt");
  const terminal = client.lastResult();
  if (!terminal) throw new Error("Glaeda verification returned no bounded terminal receipt");
  const succeeded = dispatched.receipt.terminalClass === "succeeded";
  const transitioned = await runner.call<RunnerRecord>("transition_runner_run", {
    id: running.id,
    actor,
    command: succeeded ? "succeed" : "fail",
    expectedGeneration: running.generation,
    expectedLeaseGeneration: running.leaseGeneration,
    outcome: `Glaeda ${profile.id} ${dispatched.receipt.terminalClass} with receipt ${terminal.resultSha256}.`,
    usage: { toolCalls: 5 },
    executionActual: { toolCalls: 5, filesChanged: 0 },
    idempotencyKey: `terminal-glaeda:${shortDigest(running.id)}`,
  });
  return {
    outcome: succeeded ? "succeeded" : "failed",
    runId: running.id,
    itemId: command.itemId,
    commandId: command.commandId,
    commandFingerprint: dispatched.commandFingerprint,
    resultSha256: terminal.resultSha256,
    resultBytes: terminal.resultBytes,
    terminalClass: dispatched.receipt.terminalClass,
    runStatus: text(transitioned.status, "terminal run status"),
  };
}

interface ClaimedRunEnvelope {
  run: RunnerRecord & {
    itemId: string;
    runnerType: string;
    runnerProfile: string;
    runnerProfileVersion?: string | null;
  };
  authorityFence: { holderId: string; generation: number; expiresAt: string };
  item: {
    id: string;
    project: string;
    claimGeneration: number;
    claimedBy: string | null;
  };
  context: { artifacts: unknown[] };
}

interface RunnerRecord {
  id: string;
  status: string;
  generation: number;
  leaseGeneration: number;
  leaseOwnerId?: string | null;
  leaseExpiresAt?: string | null;
}

interface ExactRequest extends GlaedaVerificationRequestV1 { requestId: string }

interface NormalizedInput extends Omit<ExecuteGlaedaVerifyFocusedInputV1,
  "actor" | "inspectPythonInterpreter" | "leaseSeconds" | "now"
> {
  actor: ActorInput;
  inspectPythonInterpreter: (path: string) => Promise<Python314InterpreterEvidenceV1>;
  leaseSeconds: number;
  now: () => Date;
}

function normalizeInput(input: ExecuteGlaedaVerifyFocusedInputV1): NormalizedInput {
  const actor = input.actor ?? {
    id: `service:${text(input.node.id, "node ID")}-glaeda`,
    name: `${text(input.node.id, "node ID")} Glaeda workstation`,
    kind: "service" as const,
  };
  return {
    ...input,
    project: slug(input.project),
    runId: text(input.runId, "run ID"),
    profileGeneration: sha256(input.profileGeneration, "profile generation"),
    node: {
      id: text(input.node.id, "node ID"),
      generation: integer(input.node.generation, "node generation"),
      osClass: "linux",
      architectureClass: "x86_64",
      glaedaRuntimeSha256: sha256(input.node.glaedaRuntimeSha256, "Glaeda runtime"),
    },
    actor,
    inspectPythonInterpreter: input.inspectPythonInterpreter ?? inspectPython314InterpreterV1,
    leaseSeconds: integer(input.leaseSeconds ?? 900, "lease seconds"),
    now: input.now ?? (() => new Date()),
  };
}

function admitClaimedRun(
  claimed: ClaimedRunEnvelope,
  input: NormalizedInput,
  actor: ActorInput,
  profile: GlaedaVerificationProfileContractV1,
) {
  if (
    claimed.run.id !== input.runId
    || claimed.run.itemId !== claimed.item.id
    || claimed.item.project !== input.project
    || claimed.run.runnerType !== "glaeda-workstation"
    || claimed.run.runnerProfile !== profile.id
    || claimed.run.runnerProfileVersion !== input.profileGeneration
    || claimed.authorityFence.holderId !== actor.id
    || claimed.item.claimedBy !== actor.id
    || claimed.item.claimGeneration < 1
  ) throw new Error("Claimed run does not match exact Glaeda verification target");
}

function admitRunningRun(run: RunnerRecord, runId: string, actorId: string) {
  if (
    run.id !== runId || run.status !== "running" || run.leaseOwnerId !== actorId
    || !run.leaseExpiresAt
  ) throw new Error("Glaeda verification run did not enter exact running authority");
}

function admitRequestArtifact(
  artifacts: unknown[],
  profile: GlaedaVerificationProfileContractV1,
): ExactRequest {
  const admitted = artifacts.map((value) => {
    if (!isRecord(value) || value.kind !== "commit" || !isRecord(value.metadata)) return null;
    const artifact = value;
    const metadata = value.metadata;
    if (metadata.schema !== profile.requestArtifactSchema) return null;
    if (Object.keys(metadata).sort().join("\0") !== [
      "commitOid", "deadlineSeconds", "executionIdentityClass", "profileVersionSha256",
      "repository", "requestId", "requestSha256", "resourceClass", "schema", "treeOid",
    ].sort().join("\0")) throw new Error("Glaeda verification request metadata has unexpected fields");
    const request: ExactRequest = {
      version: 1,
      requestId: requestId(metadata.requestId),
      repository: repository(metadata.repository),
      commitOid: oid(metadata.commitOid, "commit"),
      treeOid: oid(metadata.treeOid, "tree"),
      profileVersionSha256: sha256(metadata.profileVersionSha256, "profile generation"),
      resourceClass: profile.resourceClass,
      deadlineSeconds: profile.deadlineSeconds,
      executionIdentityClass: "credentialless_project",
    };
    if (
      metadata.resourceClass !== profile.resourceClass
      || metadata.deadlineSeconds !== profile.deadlineSeconds
      || metadata.executionIdentityClass !== "credentialless_project"
      || metadata.requestSha256 !== fingerprintGlaedaVerificationRequestV1(
        profileRequest(request),
        profile,
      )
      || artifact.uri !== `https://github.com/${request.repository}/commit/${request.commitOid}`
    ) throw new Error("Glaeda verification request artifact changed exact identity");
    return request;
  }).filter((value): value is ExactRequest => value !== null);
  if (admitted.length !== 1) {
    throw new Error("Runner context must contain exactly one Glaeda verification request artifact");
  }
  return admitted[0]!;
}

function commandFor(
  input: NormalizedInput,
  claimed: ClaimedRunEnvelope,
  running: RunnerRecord,
  request: ExactRequest,
  capabilitySnapshotSha256: string,
  actor: ActorInput,
  profile: GlaedaVerificationProfileContractV1,
): GlaedaWorkstationCommandV1 {
  const requestSha256 = fingerprintGlaedaVerificationRequestV1(
    profileRequest(request),
    profile,
  );
  const identity = shortDigest(canonicalJsonString({
    runId: running.id,
    runGeneration: running.generation,
    leaseGeneration: running.leaseGeneration,
    requestSha256,
    node: input.node,
    capabilitySnapshotSha256,
  }));
  return {
    version: 1,
    project: input.project,
    itemId: claimed.item.id,
    itemClaimGeneration: claimed.item.claimGeneration,
    runId: running.id,
    runGeneration: running.generation,
    leaseGeneration: running.leaseGeneration,
    authority: { holderId: actor.id, expiresAt: text(running.leaseExpiresAt, "lease expiry") },
    commandId: `glaeda-${identity}`,
    idempotencyKey: `glaeda-workstation:${identity}`,
    node: { ...input.node, capabilitySnapshotSha256 },
    source: {
      repository: request.repository,
      commitOid: request.commitOid,
      treeOid: request.treeOid,
      logicalChangeRef: `github:${request.commitOid}`,
    },
    profile: {
      id: profile.id,
      versionSha256: request.profileVersionSha256,
      class: profile.class,
      resourceClass: profile.resourceClass,
      deadlineSeconds: profile.deadlineSeconds,
    },
    profileRequestSha256: requestSha256,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function profileRequest(request: ExactRequest): GlaedaVerificationRequestV1 {
  return {
    version: 1,
    repository: request.repository,
    commitOid: request.commitOid,
    treeOid: request.treeOid,
    profileVersionSha256: request.profileVersionSha256,
    resourceClass: request.resourceClass,
    deadlineSeconds: request.deadlineSeconds,
    executionIdentityClass: "credentialless_project",
  };
}
function shortDigest(value: string): string { return sha256Hex(value).slice(0, 48); }
function requestId(value: unknown): string {
  const result = text(value, "request ID");
  if (!REQUEST_ID_PATTERN.test(result)) throw new Error("Verify-focused request ID is invalid");
  return result;
}
function repository(value: unknown): string {
  const result = text(value, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(result)) throw new Error("Repository is invalid");
  return result;
}
function oid(value: unknown, label: string): string {
  const result = text(value, label);
  if (!OID_PATTERN.test(result)) throw new Error(`Verify-focused ${label} is invalid`);
  return result;
}
function sha256(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256_PATTERN.test(result)) throw new Error(`Verify-focused ${label} is invalid`);
  return result;
}
function slug(value: unknown): string {
  const result = text(value, "project");
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(result)) throw new Error("Project is invalid");
  return result;
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} is invalid`);
  return Number(value);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid`);
  return value.trim();
}
