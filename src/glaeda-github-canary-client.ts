import { dirname } from "node:path";
import {
  fingerprintGlaedaWorkstationCommandV1,
  normalizeGlaedaWorkstationCommandV1,
  type GlaedaWorkstationCheckV1,
  type GlaedaWorkstationCommandV1,
  type GlaedaWorkstationReceiptV1,
} from "./glaeda-workstation-contracts.js";
import type {
  GlaedaWorkstationClientV1,
  PreparedGlaedaWorkstationCommandV1,
} from "./glaeda-workstation-adapter.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OID_PATTERN = /^[a-f0-9]{40}$/u;
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/u;

export interface GlaedaGitHubCanaryTargetV1 {
  requestId: string;
  requestCommitOid: string;
  requestSha256: string;
  transportGeneration: string;
  profileGeneration: string;
}

export interface GlaedaGitHubCanaryTerminalV1 {
  requestId: string;
  requestCommitOid: string;
  resultCommitOid: string;
  resultSha256: string;
  resultBytes: number;
  replay: boolean;
  resultRef: string;
}

export interface GlaedaCanaryProcessResultV1 {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GlaedaCanaryProcessV1 = (input: {
  scriptPath: string;
  action: "observe-one" | "consume-one" | "reconcile-one";
  requestId: string;
  requestCommitOid: string;
  timeoutSeconds: number;
}) => Promise<GlaedaCanaryProcessResultV1>;

/**
 * Dogfood-only fault boundary: allow the physical consume to finish, then hide its successful
 * response once. A fresh runner process must reconcile the immutable result and may not redispatch.
 */
export function loseFirstSuccessfulConsumeResponseV1(
  process: GlaedaCanaryProcessV1 = runGlaedaCanaryProcessV1,
): GlaedaCanaryProcessV1 {
  let lost = false;
  return async (input) => {
    const result = await process(input);
    if (!lost && input.action === "consume-one" && result.exitCode === 0) {
      lost = true;
      return {
        exitCode: 75,
        stdout: "",
        stderr: "simulated response loss after successful physical result publication",
      };
    }
    return result;
  };
}

export class GlaedaGitHubCanaryClientV1 implements GlaedaWorkstationClientV1 {
  readonly #scriptPath: string;
  readonly #target: GlaedaGitHubCanaryTargetV1;
  readonly #process: GlaedaCanaryProcessV1;
  readonly #now: () => Date;
  #observed: CanaryObservation | null = null;
  #terminal: GlaedaGitHubCanaryTerminalV1 | null = null;

  constructor(input: {
    scriptPath: string;
    target: GlaedaGitHubCanaryTargetV1;
    process?: GlaedaCanaryProcessV1;
    now?: () => Date;
  }) {
    this.#scriptPath = required(input.scriptPath, "Glaeda canary script path");
    this.#target = normalizeTarget(input.target);
    this.#process = input.process ?? runGlaedaCanaryProcessV1;
    this.#now = input.now ?? (() => new Date());
  }

  get terminal(): GlaedaGitHubCanaryTerminalV1 | null {
    return this.#terminal === null ? null : { ...this.#terminal };
  }

  async check(rawCommand: GlaedaWorkstationCommandV1): Promise<GlaedaWorkstationCheckV1> {
    const command = normalizeGlaedaWorkstationCommandV1(rawCommand);
    requireTargetMatchesCommand(this.#target, command);
    const response = await this.#invoke("observe-one", command.profile.deadlineSeconds);
    const observation = admitObservation(response, this.#target);
    requireObservationMatchesCommand(observation, command);
    this.#observed = observation;
    return {
      schema: "glaeda-workstation-check/v1",
      commandFingerprint: fingerprintGlaedaWorkstationCommandV1(command),
      node: command.node,
      source: {
        repository: command.source.repository,
        commitOid: command.source.commitOid,
        treeOid: command.source.treeOid,
      },
      profile: {
        id: command.profile.id,
        versionSha256: command.profile.versionSha256,
        class: command.profile.class,
      },
      executionIdentityClass: "read_only_repository",
      supported: true,
      rawContentEmitted: false,
      authorizesWork: false,
      authorizesEffects: false,
    };
  }

  async execute(
    prepared: PreparedGlaedaWorkstationCommandV1,
  ): Promise<GlaedaWorkstationReceiptV1> {
    const command = normalizeGlaedaWorkstationCommandV1(prepared.command);
    requireTargetMatchesCommand(this.#target, command);
    if (this.#observed === null) throw new Error("Glaeda request was not checked before execution");
    requireObservationMatchesCommand(this.#observed, command);
    const startedAt = timestamp(this.#now(), "Glaeda canary start time");
    const response = await this.#invoke("consume-one", command.profile.deadlineSeconds);
    const terminal = admitTerminal(response, this.#target, "consume-one");
    const settledAt = timestamp(this.#now(), "Glaeda canary settlement time");
    this.#terminal = terminal;
    return receiptFor(prepared, terminal, startedAt, settledAt);
  }

  async reconcile(
    prepared: PreparedGlaedaWorkstationCommandV1,
  ): Promise<GlaedaWorkstationReceiptV1 | null> {
    const command = normalizeGlaedaWorkstationCommandV1(prepared.command);
    requireTargetMatchesCommand(this.#target, command);
    if (this.#observed === null) throw new Error("Glaeda request was not checked before reconciliation");
    requireObservationMatchesCommand(this.#observed, command);
    const reconciledAt = timestamp(this.#now(), "Glaeda canary reconciliation time");
    const response = await this.#invoke("reconcile-one", command.profile.deadlineSeconds);
    const terminal = admitOptionalTerminal(response, this.#target, "reconcile-one");
    if (terminal === null) return null;
    if (!terminal.replay) throw new Error("Glaeda reconciliation cannot authorize new execution");
    this.#terminal = terminal;
    return receiptFor(prepared, terminal, reconciledAt, reconciledAt);
  }

  async #invoke(
    action: "observe-one" | "consume-one" | "reconcile-one",
    timeoutSeconds: number,
  ): Promise<unknown> {
    const completed = await this.#process({
      scriptPath: this.#scriptPath,
      action,
      requestId: this.#target.requestId,
      requestCommitOid: this.#target.requestCommitOid,
      timeoutSeconds,
    });
    if (completed.exitCode !== 0) {
      throw new Error(`Glaeda canary ${action} failed with status ${completed.exitCode}: ${clip(completed.stderr, 500)}`);
    }
    if (new TextEncoder().encode(completed.stdout).byteLength > 65_536) {
      throw new Error("Glaeda canary control receipt exceeds the fixed byte ceiling");
    }
    try {
      return JSON.parse(completed.stdout);
    } catch {
      throw new Error("Glaeda canary returned invalid JSON");
    }
  }
}

function receiptFor(
  prepared: PreparedGlaedaWorkstationCommandV1,
  terminal: GlaedaGitHubCanaryTerminalV1,
  startedAt: string,
  settledAt: string,
): GlaedaWorkstationReceiptV1 {
  return {
      schema: "glaeda-workstation-receipt/v1",
      commandFingerprint: prepared.check.commandFingerprint,
      node: prepared.check.node,
      source: prepared.check.source,
      profile: prepared.check.profile,
      executionIdentityClass: prepared.check.executionIdentityClass,
      terminalClass: "succeeded",
      resultSha256: terminal.resultSha256,
      resultBytes: terminal.resultBytes,
      startedAt,
      settledAt,
      rawContentEmitted: false,
      containsPrivateContent: false,
      containsCredentials: false,
      authorizesWork: false,
      authorizesEffects: false,
      authorizesRedispatch: false,
  };
}

export async function runGlaedaCanaryProcessV1(
  input: Parameters<GlaedaCanaryProcessV1>[0],
): Promise<GlaedaCanaryProcessResultV1> {
  const environment: Record<string, string> = {
    HOME: required(process.env.HOME, "HOME"),
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
  for (const name of ["SSH_AUTH_SOCK", "XDG_STATE_HOME"] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  const child = Bun.spawn([
    "/usr/bin/python3",
    input.scriptPath,
    input.action,
    "--request-id",
    input.requestId,
    "--request-commit-oid",
    input.requestCommitOid,
  ], {
    cwd: dirname(input.scriptPath),
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), (input.timeoutSeconds + 30) * 1_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

interface CanaryObservation {
  baseCommitOid: string;
  maxPatchBytes: number;
  profileId: string;
  projectId: string;
  queryBinarySha256: string;
  requestCommitOid: string;
  requestBytes: number;
  requestSha256: string;
  requestId: string;
  requestTreeOid: string;
  sourceCommitOid: string;
  sourceTreeOid: string;
  transportGeneration: string;
}

function admitObservation(value: unknown, target: GlaedaGitHubCanaryTargetV1): CanaryObservation {
  const receipt = controlReceipt(value, "observe-one");
  const raw = exactRecord(receipt, [
    "base_commit_oid", "max_patch_bytes", "profile_id", "project_id",
    "query_binary_sha256", "request_bytes", "request_commit_oid", "request_digest",
    "request_id", "request_tree_oid", "schema", "source_commit_oid", "source_tree_oid",
    "transport_generation",
  ], "Glaeda observation");
  if (raw.schema !== "glaeda-github-request-observation-v0") {
    throw new Error("Glaeda observation schema changed");
  }
  const admitted = {
    baseCommitOid: oid(raw.base_commit_oid, "base commit"),
    maxPatchBytes: integer(raw.max_patch_bytes, 0, 8192, "max patch bytes"),
    profileId: text(raw.profile_id, "profile ID"),
    projectId: text(raw.project_id, "project ID"),
    queryBinarySha256: sha256(raw.query_binary_sha256, "query binary"),
    requestBytes: integer(raw.request_bytes, 1, 4096, "request bytes"),
    requestCommitOid: oid(raw.request_commit_oid, "request commit"),
    requestSha256: sha256(raw.request_digest, "request"),
    requestId: requestId(raw.request_id),
    requestTreeOid: oid(raw.request_tree_oid, "request tree"),
    sourceCommitOid: oid(raw.source_commit_oid, "source commit"),
    sourceTreeOid: oid(raw.source_tree_oid, "source tree"),
    transportGeneration: sha256(raw.transport_generation, "transport generation"),
  };
  if (
    admitted.requestId !== target.requestId
    || admitted.requestCommitOid !== target.requestCommitOid
    || admitted.requestSha256 !== target.requestSha256
    || admitted.transportGeneration !== target.transportGeneration
  ) throw new Error("Glaeda observation changed exact request identity");
  return admitted;
}

function admitTerminal(
  value: unknown,
  target: GlaedaGitHubCanaryTargetV1,
  action: "consume-one" | "reconcile-one",
): GlaedaGitHubCanaryTerminalV1 {
  const receipt = controlReceipt(value, action);
  if (receipt === null) throw new Error(`Glaeda ${action} returned no terminal receipt`);
  const raw = exactRecord(receipt, [
    "replay", "request_commit_oid", "request_id", "result_bytes",
    "result_commit_oid", "result_digest", "schema",
  ], "Glaeda terminal receipt");
  if (raw.schema !== "glaeda-github-terminal-replay-v0") {
    throw new Error("Glaeda terminal receipt schema changed");
  }
  const requestIdValue = requestId(raw.request_id);
  const requestCommitOid = oid(raw.request_commit_oid, "request commit");
  if (requestIdValue !== target.requestId || requestCommitOid !== target.requestCommitOid) {
    throw new Error("Glaeda terminal receipt changed exact request identity");
  }
  if (typeof raw.replay !== "boolean") throw new Error("Glaeda terminal replay marker is invalid");
  const resultCommitOid = oid(raw.result_commit_oid, "result commit");
  return Object.freeze({
    requestId: requestIdValue,
    requestCommitOid,
    resultCommitOid,
    resultSha256: sha256(raw.result_digest, "result"),
    resultBytes: integer(raw.result_bytes, 1, 32_768, "result bytes"),
    replay: raw.replay,
    resultRef: `https://github.com/teamleaderleo/glaeda-dispatch/commit/${resultCommitOid}`,
  });
}

function admitOptionalTerminal(
  value: unknown,
  target: GlaedaGitHubCanaryTargetV1,
  action: "reconcile-one",
): GlaedaGitHubCanaryTerminalV1 | null {
  const control = exactRecord(value, ["action", "elapsed_us", "outcome", "receipt"], "Glaeda control receipt");
  if (control.action !== action) throw new Error(`Glaeda ${action} action identity changed`);
  integer(control.elapsed_us, 0, Number.MAX_SAFE_INTEGER, "elapsed microseconds");
  if (control.outcome === "idle" && control.receipt === null) return null;
  return admitTerminal(value, target, action);
}

function controlReceipt(value: unknown, action: string): unknown | null {
  const raw = exactRecord(value, ["action", "elapsed_us", "outcome", "receipt"], "Glaeda control receipt");
  if (raw.action !== action || raw.outcome !== "complete" || raw.receipt === null) {
    throw new Error(`Glaeda ${action} did not return a complete receipt`);
  }
  integer(raw.elapsed_us, 0, Number.MAX_SAFE_INTEGER, "elapsed microseconds");
  return raw.receipt;
}

function requireTargetMatchesCommand(
  target: GlaedaGitHubCanaryTargetV1,
  command: GlaedaWorkstationCommandV1,
): void {
  if (
    command.profile.id !== "repo-query/v1"
    || command.profile.class !== "repo_query"
    || command.profileRequestSha256 !== target.requestSha256
    || command.profile.versionSha256 !== target.profileGeneration
    || command.source.logicalChangeRef !== `glaeda-dispatch:${target.requestCommitOid}`
  ) throw new Error("Glaeda command does not bind the exact canary request/profile");
}

function requireObservationMatchesCommand(
  observation: CanaryObservation,
  command: GlaedaWorkstationCommandV1,
): void {
  if (
    observation.projectId !== `github.com/${command.source.repository}`
    || observation.sourceCommitOid !== command.source.commitOid
    || observation.sourceTreeOid !== command.source.treeOid
    || observation.profileId !== command.profile.id
    || observation.queryBinarySha256 !== command.node.glaedaRuntimeSha256
  ) throw new Error("Glaeda observation does not match the exact workstation command");
}

function normalizeTarget(value: GlaedaGitHubCanaryTargetV1): GlaedaGitHubCanaryTargetV1 {
  return Object.freeze({
    requestId: requestId(value.requestId),
    requestCommitOid: oid(value.requestCommitOid, "request commit"),
    requestSha256: sha256(value.requestSha256, "request"),
    transportGeneration: sha256(value.transportGeneration, "transport generation"),
    profileGeneration: sha256(value.profileGeneration, "profile generation"),
  });
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} fields changed`);
  }
  return record;
}

function requestId(value: unknown): string {
  const admitted = text(value, "request ID");
  if (!REQUEST_ID_PATTERN.test(admitted)) throw new Error("Glaeda request ID is invalid");
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

function required(value: unknown, label: string): string {
  return text(value, label);
}

function timestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${label} is invalid`);
  return value.toISOString();
}

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
