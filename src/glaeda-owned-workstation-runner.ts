import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  GlaedaGitHubCanaryClientV1,
  inspectPython314InterpreterV1,
  type GlaedaCanaryProcessV1,
  type Python314InterpreterEvidenceV1,
} from "./glaeda-github-canary-client.js";
import {
  admitGlaedaCapabilityArtifactV1,
  assertGlaedaCapabilitySourceIdentityV1,
} from "./glaeda-owned-workstation-capability.js";
import {
  GlaedaWorkstationAdapterV1,
  type GlaedaWorkstationAdapterResultV1,
} from "./glaeda-workstation-adapter.js";
import type { GlaedaWorkstationCommandV1 } from "./glaeda-workstation-contracts.js";
import { RunnerMcpHttpClient } from "./runner-mcp-http-client.js";
import type { ActorInput } from "./schemas.js";
import { sha256Hex } from "./sha256.js";
import { HttpWorkstationCommandLedgerV1 } from "./workstation-command-adapter-http.js";

const ARTIFACT_SCHEMA = "glaeda-repo-query-request/v1";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OID_PATTERN = /^[a-f0-9]{40}$/u;
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/u;

export interface GlaedaOwnedWorkstationNodeV1 {
  id: string;
  generation: number;
  osClass: "linux" | "macos";
  architectureClass: "x86_64" | "arm64";
  glaedaRuntimeSha256: string;
}

export interface ExecuteGlaedaOwnedWorkstationInputV1 {
  runner: RunnerMcpHttpClient;
  project: string;
  runId: string;
  profileGeneration: string;
  pythonInterpreterPath: string;
  canaryScriptPath: string;
  node: GlaedaOwnedWorkstationNodeV1;
  actor?: ActorInput;
  leaseSeconds?: number;
  canaryProcess?: GlaedaCanaryProcessV1;
  inspectPythonInterpreter?: (path: string) => Promise<Python314InterpreterEvidenceV1>;
  now?: () => Date;
}

export type ExecuteGlaedaOwnedWorkstationResultV1 =
  | { outcome: "idle" }
  | {
    outcome: "waiting_reconciliation";
    runId: string;
    itemId: string;
    commandId: string;
    commandFingerprint: string;
  }
  | {
    outcome: "succeeded";
    runId: string;
    itemId: string;
    commandId: string;
    commandFingerprint: string;
    resultSha256: string;
    resultBytes: number;
    resultRef: string;
    runStatus: string;
  };

export async function executeGlaedaOwnedWorkstationRunV1(
  raw: ExecuteGlaedaOwnedWorkstationInputV1,
): Promise<ExecuteGlaedaOwnedWorkstationResultV1> {
  const input = normalizeInput(raw);
  const actor = input.actor;
  const claimed = await input.runner.call<ClaimedRunEnvelope | null>("claim_runner_work", {
    actor,
    runnerType: "glaeda-workstation",
    runnerProfile: "repo-query/v1",
    runnerProfileVersion: input.profileGeneration,
    project: input.project,
    runId: input.runId,
    externalRunId: `glaeda:${input.node.id}:${shortDigest(input.runId)}`,
    leaseSeconds: input.leaseSeconds,
    maxContextCharacters: 12_000,
    idempotencyKey: `claim-glaeda:${input.node.id}:${shortDigest(input.runId)}`,
  });
  if (claimed === null) return { outcome: "idle" };
  admitClaimedRun(claimed, input, actor);
  const { request, capability } = await admitBeforePhysicalDispatch(input, claimed).catch(
    async (error: unknown) => {
      try {
        await input.runner.call("transition_runner_run", {
          id: claimed.run.id,
          actor,
          command: "block",
          expectedGeneration: claimed.run.generation,
          expectedLeaseGeneration: claimed.run.leaseGeneration,
          checkpoint: "Owned workstation admission refused before physical dispatch.",
          idempotencyKey: `block-glaeda-admission:${shortDigest(claimed.run.id)}`,
        });
      } catch {
        throw new Error("Owned workstation admission refused and its claim could not be released");
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
    checkpoint: `Admitted exact Glaeda request ${request.requestId}.`,
    usage: { toolCalls: 2 },
    idempotencyKey: `run-glaeda:${shortDigest(claimed.run.id)}`,
  });
  admitRunningRun(running, claimed.run.id, actor.id);

  const canary = new GlaedaGitHubCanaryClientV1({
    pythonInterpreterPath: input.pythonInterpreterPath,
    scriptPath: input.canaryScriptPath,
    target: {
      requestId: request.requestId,
      requestCommitOid: request.requestCommitOid,
      requestSha256: request.requestDigest,
      transportGeneration: request.transportGeneration,
      profileGeneration: request.profileGeneration,
    },
    now: input.now,
    ...(input.canaryProcess ? { process: input.canaryProcess } : {}),
  });
  const ledger = new HttpWorkstationCommandLedgerV1(input.runner);
  const adapter = new GlaedaWorkstationAdapterV1({ ledger, client: canary, actor });
  const command = commandFor(
    input,
    claimed,
    running,
    request,
    capability.snapshotSha256,
    actor,
  );
  const prepared = await adapter.prepare(command);
  let dispatched = await adapter.dispatch(prepared);

  if (
    dispatched.disposition === "ambiguous_reserved"
    || dispatched.disposition === "settled_replay"
  ) {
    const receipt = await canary.reconcile(prepared);
    if (receipt !== null) {
      dispatched = await adapter.reconcile(prepared, receipt);
      return finishSucceeded(input.runner, input, actor, running, command, dispatched, canary);
    }
  }

  if (dispatched.disposition === "ambiguous_reserved") {
    await input.runner.call("transition_runner_run", {
      id: running.id,
      actor,
      command: "wait",
      expectedGeneration: running.generation,
      expectedLeaseGeneration: running.leaseGeneration,
      leaseSeconds: input.leaseSeconds,
      checkpoint: `Reserved ${command.commandId}; physical outcome requires reconciliation before redispatch.`,
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

  return finishSucceeded(input.runner, input, actor, running, command, dispatched, canary);
}

async function admitBeforePhysicalDispatch(
  input: NormalizedInput,
  claimed: ClaimedRunEnvelope,
) {
  const request = admitRequestArtifact(claimed.context.artifacts);
  if (request.profileGeneration !== input.profileGeneration) {
    throw new Error("Glaeda artifact profile generation does not match the claimed run");
  }
  assertGlaedaCapabilitySourceIdentityV1({
    commitOid: request.sourceCommitOid,
    treeOid: request.sourceTreeOid,
  });
  const python = await input.inspectPythonInterpreter(input.pythonInterpreterPath);
  const capability = admitGlaedaCapabilityArtifactV1(claimed.context.artifacts, {
    node: input.node,
    profileGeneration: request.profileGeneration,
    source: {
      repository: request.sourceRepository,
      commitOid: request.sourceCommitOid,
      treeOid: request.sourceTreeOid,
    },
    python,
    now: input.now(),
  });
  return { request, capability };
}

async function finishSucceeded(
  runner: RunnerMcpHttpClient,
  input: NormalizedInput,
  actor: ActorInput,
  running: RunnerRecord,
  command: GlaedaWorkstationCommandV1,
  dispatched: GlaedaWorkstationAdapterResultV1,
  canary: GlaedaGitHubCanaryClientV1,
): Promise<ExecuteGlaedaOwnedWorkstationResultV1> {
  if (!dispatched.receipt) {
    throw new Error("Settled Glaeda replay has no local result reference; reconcile the durable run");
  }
  const terminal = canary.terminal;
  if (!terminal) throw new Error("Executed Glaeda command returned no terminal transport reference");
  const succeeded = await runner.call<RunnerRecord>("transition_runner_run", {
    id: running.id,
    actor,
    command: "succeed",
    expectedGeneration: running.generation,
    expectedLeaseGeneration: running.leaseGeneration,
    outcome: `Glaeda repo-query/v1 succeeded with bounded result ${terminal.resultSha256}.`,
    continuationRef: terminal.resultRef,
    usage: { toolCalls: 7 },
    executionActual: { toolCalls: 7, filesChanged: 0 },
    idempotencyKey: `succeed-glaeda:${shortDigest(running.id)}`,
  });
  return {
    outcome: "succeeded",
    runId: running.id,
    itemId: command.itemId,
    commandId: command.commandId,
    commandFingerprint: dispatched.commandFingerprint,
    resultSha256: terminal.resultSha256,
    resultBytes: terminal.resultBytes,
    resultRef: terminal.resultRef,
    runStatus: text(succeeded.status, "succeeded run status"),
  };
}

interface ClaimedRunEnvelope {
  run: RunnerRecord & {
    itemId: string;
    runnerType: string;
    runnerProfile: string;
    runnerProfileVersion?: string | null;
  };
  authorityFence: {
    holderId: string;
    generation: number;
    expiresAt: string;
  };
  item: {
    id: string;
    project: string;
    claimGeneration: number;
    claimedBy: string | null;
  };
  context: {
    artifacts: unknown[];
  };
}

interface RunnerRecord {
  id: string;
  status: string;
  generation: number;
  leaseGeneration: number;
  leaseOwnerId?: string | null;
  leaseExpiresAt?: string | null;
}

interface ExactRequestArtifact {
  requestId: string;
  requestCommitOid: string;
  requestDigest: string;
  transportGeneration: string;
  profileGeneration: string;
  sourceRepository: string;
  sourceCommitOid: string;
  sourceTreeOid: string;
}

interface NormalizedInput extends Omit<ExecuteGlaedaOwnedWorkstationInputV1,
  "actor" | "inspectPythonInterpreter" | "leaseSeconds" | "now"
> {
  actor: ActorInput;
  inspectPythonInterpreter: (path: string) => Promise<Python314InterpreterEvidenceV1>;
  leaseSeconds: number;
  now: () => Date;
}

function normalizeInput(input: ExecuteGlaedaOwnedWorkstationInputV1): NormalizedInput {
  const node = input.node;
  const actor = input.actor ?? {
    id: `service:${text(node.id, "node ID")}-glaeda`,
    name: `${text(node.id, "node ID")} Glaeda workstation`,
    kind: "service" as const,
  };
  return {
    runner: input.runner,
    project: slug(input.project, "project"),
    runId: text(input.runId, "run ID"),
    profileGeneration: sha256(input.profileGeneration, "profile generation"),
    pythonInterpreterPath: text(input.pythonInterpreterPath, "Python interpreter path"),
    canaryScriptPath: text(input.canaryScriptPath, "canary script path"),
    node: {
      id: text(node.id, "node ID"),
      generation: integer(node.generation, 1, Number.MAX_SAFE_INTEGER, "node generation"),
      osClass: node.osClass,
      architectureClass: node.architectureClass,
      glaedaRuntimeSha256: sha256(node.glaedaRuntimeSha256, "Glaeda runtime"),
    },
    actor,
    inspectPythonInterpreter: input.inspectPythonInterpreter ?? inspectPython314InterpreterV1,
    leaseSeconds: integer(input.leaseSeconds ?? 900, 30, 86_400, "lease seconds"),
    now: input.now ?? (() => new Date()),
    ...(input.canaryProcess ? { canaryProcess: input.canaryProcess } : {}),
  };
}

function admitClaimedRun(
  claimed: ClaimedRunEnvelope,
  input: NormalizedInput,
  actor: ActorInput,
): void {
  if (
    claimed.run.id !== input.runId
    || claimed.run.itemId !== claimed.item.id
    || claimed.item.project !== input.project
    || claimed.run.runnerType !== "glaeda-workstation"
    || claimed.run.runnerProfile !== "repo-query/v1"
    || claimed.run.runnerProfileVersion !== input.profileGeneration
    || claimed.authorityFence.holderId !== actor.id
    || claimed.item.claimedBy !== actor.id
    || claimed.item.claimGeneration < 1
  ) throw new Error("Claimed run does not match the exact Glaeda workstation target");
}

function admitRunningRun(run: RunnerRecord, runId: string, actorId: string): void {
  if (
    run.id !== runId
    || run.status !== "running"
    || run.leaseOwnerId !== actorId
    || !run.leaseExpiresAt
  ) throw new Error("Glaeda run did not enter exact running authority");
}

function admitRequestArtifact(artifacts: unknown[]): ExactRequestArtifact {
  const admitted = artifacts.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const artifact = value as Record<string, unknown>;
    if (artifact.kind !== "commit" || !artifact.metadata || typeof artifact.metadata !== "object") {
      return null;
    }
    const metadata = artifact.metadata as Record<string, unknown>;
    if (metadata.schema !== ARTIFACT_SCHEMA) return null;
    const requestCommitOid = oid(metadata.requestCommitOid, "request commit");
    const uri = text(artifact.uri, "artifact URI");
    if (uri !== `https://github.com/teamleaderleo/glaeda-dispatch/commit/${requestCommitOid}`) {
      throw new Error("Glaeda request artifact URI does not match its immutable commit");
    }
    return {
      requestId: requestId(metadata.requestId),
      requestCommitOid,
      requestDigest: sha256(metadata.requestDigest, "request"),
      transportGeneration: sha256(metadata.transportGeneration, "transport generation"),
      profileGeneration: sha256(metadata.profileGeneration, "profile generation"),
      sourceRepository: repository(metadata.sourceRepository),
      sourceCommitOid: oid(metadata.sourceCommitOid, "source commit"),
      sourceTreeOid: oid(metadata.sourceTreeOid, "source tree"),
    };
  }).filter((value): value is ExactRequestArtifact => value !== null);
  if (admitted.length !== 1) {
    throw new Error("Runner context must contain exactly one Glaeda repo-query request artifact");
  }
  return admitted[0]!;
}

function commandFor(
  input: NormalizedInput,
  claimed: ClaimedRunEnvelope,
  running: RunnerRecord,
  request: ExactRequestArtifact,
  capabilitySnapshotSha256: string,
  actor: ActorInput,
): GlaedaWorkstationCommandV1 {
  const identity = shortDigest(canonicalJsonString({
    runId: running.id,
    runGeneration: running.generation,
    leaseGeneration: running.leaseGeneration,
    requestCommitOid: request.requestCommitOid,
    requestDigest: request.requestDigest,
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
    authority: {
      holderId: actor.id,
      expiresAt: text(running.leaseExpiresAt, "run lease expiry"),
    },
    commandId: `glaeda-${identity}`,
    idempotencyKey: `glaeda-workstation:${identity}`,
    node: {
      ...input.node,
      capabilitySnapshotSha256,
    },
    source: {
      repository: request.sourceRepository,
      commitOid: request.sourceCommitOid,
      treeOid: request.sourceTreeOid,
      logicalChangeRef: `glaeda-dispatch:${request.requestCommitOid}`,
    },
    profile: {
      id: "repo-query/v1",
      versionSha256: request.profileGeneration,
      class: "repo_query",
      resourceClass: "interactive-small",
      deadlineSeconds: 60,
    },
    profileRequestSha256: request.requestDigest,
  };
}

function shortDigest(value: string): string {
  return sha256Hex(value).slice(0, 48);
}

function requestId(value: unknown): string {
  const admitted = text(value, "request ID");
  if (!REQUEST_ID_PATTERN.test(admitted)) throw new Error("Glaeda request ID is invalid");
  return admitted;
}

function repository(value: unknown): string {
  const admitted = text(value, "source repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(admitted)) {
    throw new Error("Glaeda source repository is invalid");
  }
  return admitted;
}

function oid(value: unknown, label: string): string {
  const admitted = text(value, label);
  if (!OID_PATTERN.test(admitted)) throw new Error(`Glaeda ${label} is invalid`);
  return admitted;
}

function sha256(value: unknown, label: string): string {
  const admitted = text(value, label);
  if (!SHA256_PATTERN.test(admitted)) throw new Error(`Glaeda ${label} digest is invalid`);
  return admitted;
}

function slug(value: unknown, label: string): string {
  const admitted = text(value, label);
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(admitted)) throw new Error(`Glaeda ${label} is invalid`);
  return admitted;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Glaeda ${label} is invalid`);
  }
  return value as number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Glaeda ${label} is invalid`);
  return value.trim();
}
