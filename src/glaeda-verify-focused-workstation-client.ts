import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import {
  fingerprintGlaedaWorkstationCommandV1,
  type GlaedaWorkstationCheckV1,
  type GlaedaWorkstationCommandV1,
  type GlaedaWorkstationNodeV1,
  type GlaedaWorkstationReceiptV1,
} from "./glaeda-workstation-contracts.js";
import type {
  GlaedaWorkstationClientV1,
  PreparedGlaedaWorkstationCommandV1,
} from "./glaeda-workstation-adapter.js";
import { canonicalJsonString } from "./idempotency-request-fingerprint.js";

export interface GlaedaVerificationProfileContractV1 {
  id: "verify-focused/v1" | "verify-required/v1";
  class: "verify_focused" | "verify_required";
  resourceClass: "big-red-focused" | "big-red-required";
  deadlineSeconds: 600 | 1200;
  requestArtifactSchema: "glaeda-verify-focused-request/v1" | "glaeda-verify-required-request/v1";
  receiptDocumentType: "glaeda-verify-focused-receipt" | "glaeda-verify-required-receipt";
}

export const GLAEDA_VERIFY_FOCUSED_PROFILE_V1 = Object.freeze({
  id: "verify-focused/v1",
  class: "verify_focused",
  resourceClass: "big-red-focused",
  deadlineSeconds: 600,
  requestArtifactSchema: "glaeda-verify-focused-request/v1",
  receiptDocumentType: "glaeda-verify-focused-receipt",
} as const satisfies GlaedaVerificationProfileContractV1);

export const GLAEDA_VERIFY_REQUIRED_PROFILE_V1 = Object.freeze({
  id: "verify-required/v1",
  class: "verify_required",
  resourceClass: "big-red-required",
  deadlineSeconds: 1200,
  requestArtifactSchema: "glaeda-verify-required-request/v1",
  receiptDocumentType: "glaeda-verify-required-receipt",
} as const satisfies GlaedaVerificationProfileContractV1);
const MAX_RESULT_BYTES = 32 * 1024;
const GIT_OID = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export interface GlaedaVerificationRequestV1 {
  version: 1;
  repository: string;
  commitOid: string;
  treeOid: string;
  profileVersionSha256: string;
  resourceClass: GlaedaVerificationProfileContractV1["resourceClass"];
  deadlineSeconds: GlaedaVerificationProfileContractV1["deadlineSeconds"];
  executionIdentityClass: "credentialless_project";
}

export type GlaedaVerifyFocusedRequestV1 = GlaedaVerificationRequestV1 & {
  resourceClass: "big-red-focused";
  deadlineSeconds: 600;
};

export type GlaedaVerifyRequiredRequestV1 = GlaedaVerificationRequestV1 & {
  resourceClass: "big-red-required";
  deadlineSeconds: 1200;
};

export interface GlaedaVerifyFocusedResultV1 {
  requestSha256: string;
  resultSha256: string;
  resultBytes: number;
  terminalClass: GlaedaWorkstationReceiptV1["terminalClass"];
  report: Record<string, unknown>;
}

export type GlaedaVerifyFocusedProcessV1 = (input: {
  python: string;
  script: string;
  arguments: string[];
  timeoutMilliseconds: number;
}) => { status: number | null; stdout: Uint8Array; stderr: Uint8Array };

export class GlaedaVerifyFocusedWorkstationClientV1 implements GlaedaWorkstationClientV1 {
  readonly #python: string;
  readonly #script: string;
  readonly #implementation: string;
  readonly #repositoryRoot: string;
  readonly #stateRoot: string;
  readonly #cargoRoot: string;
  readonly #rustupRoot: string;
  readonly #node: GlaedaWorkstationNodeV1;
  readonly #profile: GlaedaVerificationProfileContractV1;
  readonly #request: GlaedaVerificationRequestV1;
  readonly #requestSha256: string;
  readonly #process: GlaedaVerifyFocusedProcessV1;
  #lastResult: GlaedaVerifyFocusedResultV1 | null = null;

  constructor(input: {
    pythonInterpreter: string;
    script: string;
    implementation: string;
    repositoryRoot: string;
    stateRoot: string;
    cargoRoot: string;
    rustupRoot: string;
    node: GlaedaWorkstationNodeV1;
    request: GlaedaVerificationRequestV1;
    profile?: GlaedaVerificationProfileContractV1;
    process?: GlaedaVerifyFocusedProcessV1;
  }) {
    this.#profile = Object.freeze({ ...(input.profile ?? GLAEDA_VERIFY_FOCUSED_PROFILE_V1) });
    this.#python = canonicalRegularFile(input.pythonInterpreter, "Python interpreter");
    this.#script = canonicalRegularFile(input.script, "Glaeda verification script");
    this.#implementation = canonicalRegularFile(
      input.implementation,
      "Glaeda verification implementation",
    );
    this.#repositoryRoot = canonicalDirectory(input.repositoryRoot, "resident repository");
    this.#stateRoot = canonicalOrCreatableDirectory(input.stateRoot, "Glaeda state root");
    this.#cargoRoot = canonicalDirectory(input.cargoRoot, "Cargo root");
    this.#rustupRoot = canonicalDirectory(input.rustupRoot, "rustup root");
    this.#node = Object.freeze({ ...input.node });
    this.#request = normalizeRequest(input.request, this.#profile);
    this.#requestSha256 = fingerprintGlaedaVerificationRequestV1(this.#request, this.#profile);
    this.#process = input.process ?? runVerifyFocused;
    if (
      fingerprintGlaedaVerifyFocusedRuntimeV1(this.#script, this.#implementation)
      !== this.#node.glaedaRuntimeSha256
    ) throw new RangeError("Glaeda verification runtime digest changed");
  }

  async check(command: GlaedaWorkstationCommandV1): Promise<GlaedaWorkstationCheckV1> {
    this.#assertCommand(command);
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
      executionIdentityClass: "credentialless_project",
      supported: true,
      rawContentEmitted: false,
      authorizesWork: false,
      authorizesEffects: false,
    };
  }

  async execute(input: PreparedGlaedaWorkstationCommandV1): Promise<GlaedaWorkstationReceiptV1> {
    return this.#invoke(input, false);
  }

  async reconcile(
    input: PreparedGlaedaWorkstationCommandV1,
  ): Promise<GlaedaWorkstationReceiptV1 | null> {
    try {
      return await this.#invoke(input, true);
    } catch (error) {
      if (error instanceof MissingVerificationReceiptError) return null;
      throw error;
    }
  }

  lastResult(): GlaedaVerifyFocusedResultV1 | null {
    return this.#lastResult;
  }

  async #invoke(
    input: PreparedGlaedaWorkstationCommandV1,
    reconcileOnly: boolean,
  ): Promise<GlaedaWorkstationReceiptV1> {
    this.#assertCommand(input.command);
    const commandFingerprint = fingerprintGlaedaWorkstationCommandV1(input.command);
    const result = this.#process({
      python: this.#python,
      script: this.#script,
      timeoutMilliseconds: (input.command.profile.deadlineSeconds + 45) * 1_000,
      arguments: [
        "run",
        "--repository-root",
        this.#repositoryRoot,
        "--state-root",
        this.#stateRoot,
        "--cargo-root",
        this.#cargoRoot,
        "--rustup-root",
        this.#rustupRoot,
        "--repository",
        this.#request.repository,
        "--commit",
        this.#request.commitOid,
        "--tree",
        this.#request.treeOid,
        "--profile-generation",
        this.#request.profileVersionSha256,
        "--command-fingerprint",
        commandFingerprint,
        ...(reconcileOnly ? ["--reconcile-only"] : []),
      ],
    });
    if (result.status === 75 && reconcileOnly) throw new MissingVerificationReceiptError();
    if (result.status !== 0) {
      throw new Error(`Glaeda verification refused with status ${result.status ?? "signal"}`);
    }
    if (result.stdout.byteLength > MAX_RESULT_BYTES) {
      throw new RangeError("Glaeda verification receipt exceeds the fixed byte ceiling");
    }
    const report = admitPhysicalReport(
      result.stdout,
      input.command,
      commandFingerprint,
      this.#profile,
    );
    const resultSha256 = sha256(result.stdout);
    const terminalClass = report.result.terminal_class;
    this.#lastResult = Object.freeze({
      requestSha256: this.#requestSha256,
      resultSha256,
      resultBytes: result.stdout.byteLength,
      terminalClass,
      report: Object.freeze(report.raw),
    });
    return {
      schema: "glaeda-workstation-receipt/v1",
      commandFingerprint,
      node: input.check.node,
      source: input.check.source,
      profile: input.check.profile,
      executionIdentityClass: "credentialless_project",
      terminalClass,
      resultSha256,
      resultBytes: result.stdout.byteLength,
      startedAt: new Date(report.result.started_at_unix_millis).toISOString(),
      settledAt: new Date(report.result.settled_at_unix_millis).toISOString(),
      rawContentEmitted: false,
      containsPrivateContent: false,
      containsCredentials: false,
      authorizesWork: false,
      authorizesEffects: false,
      authorizesRedispatch: false,
    };
  }

  #assertCommand(command: GlaedaWorkstationCommandV1): void {
    if (
      command.profile.id !== this.#profile.id
      || command.profile.class !== this.#profile.class
      || command.profile.resourceClass !== this.#profile.resourceClass
      || command.profile.deadlineSeconds !== this.#profile.deadlineSeconds
      || command.profile.versionSha256 !== this.#request.profileVersionSha256
      || command.profileRequestSha256 !== this.#requestSha256
      || command.source.repository !== this.#request.repository
      || command.source.commitOid !== this.#request.commitOid
      || command.source.treeOid !== this.#request.treeOid
      || canonicalJsonString(command.node) !== canonicalJsonString(this.#node)
    ) throw new RangeError("Glaeda verification client does not match the exact command");
  }
}

export function fingerprintGlaedaVerifyFocusedRequestV1(
  raw: GlaedaVerifyFocusedRequestV1,
): string {
  return fingerprintGlaedaVerificationRequestV1(raw, GLAEDA_VERIFY_FOCUSED_PROFILE_V1);
}

export function fingerprintGlaedaVerifyRequiredRequestV1(
  raw: GlaedaVerifyRequiredRequestV1,
): string {
  return fingerprintGlaedaVerificationRequestV1(raw, GLAEDA_VERIFY_REQUIRED_PROFILE_V1);
}

export function fingerprintGlaedaVerificationRequestV1(
  raw: GlaedaVerificationRequestV1,
  profile: GlaedaVerificationProfileContractV1,
): string {
  return sha256(new TextEncoder().encode(`${canonicalJsonString(normalizeRequest(raw, profile))}\n`));
}

export function fingerprintGlaedaVerifyFocusedRuntimeV1(
  scriptPath: string,
  implementationPath: string,
): string {
  const hash = createHash("sha256");
  for (const path of [scriptPath, implementationPath]) {
    const bytes = readFileSync(canonicalRegularFile(path, "Glaeda runtime file"));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalizeRequest(
  value: GlaedaVerificationRequestV1,
  profile: GlaedaVerificationProfileContractV1,
): GlaedaVerificationRequestV1 {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [
      "commitOid", "deadlineSeconds", "executionIdentityClass", "profileVersionSha256",
      "repository", "resourceClass", "treeOid", "version",
    ].sort().join("\0")
    || value.version !== 1
    || !REPOSITORY.test(value.repository)
    || !GIT_OID.test(value.commitOid)
    || !GIT_OID.test(value.treeOid)
    || !SHA256.test(value.profileVersionSha256)
    || value.resourceClass !== profile.resourceClass
    || value.deadlineSeconds !== profile.deadlineSeconds
    || value.executionIdentityClass !== "credentialless_project"
  ) throw new RangeError("Glaeda verification request is invalid");
  return Object.freeze({ ...value });
}

function admitPhysicalReport(
  bytes: Uint8Array,
  command: GlaedaWorkstationCommandV1,
  fingerprint: string,
  verificationProfile: GlaedaVerificationProfileContractV1,
) {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) throw new Error();
    raw = parsed;
  } catch {
    throw new RangeError("Glaeda verification returned invalid bounded JSON");
  }
  const source = record(raw.source);
  const profile = record(raw.profile);
  const isolation = record(raw.isolation);
  const result = record(raw.result);
  const terminal = result.terminal_class;
  if (
    !exactKeys(raw, [
      "authority", "authorizes_effects", "authorizes_redispatch", "authorizes_work",
      "command_fingerprint", "contains_credentials", "contains_private_content", "document_type",
      "execution_identity_class", "isolation", "profile", "result", "schema_version", "source",
    ])
    || !exactKeys(source, ["commit", "repository", "tree"])
    || !exactKeys(profile, ["class", "deadline_seconds", "generation", "id", "resource_class"])
    || !exactKeys(isolation, [
      "ambient_environment", "build_state", "control_credentials", "filesystem", "network",
      "package_cache", "publisher_credentials", "ssh_agent", "sudo_admin",
      "unrelated_writable_projects",
    ])
    || !exactKeys(result, [
      "cpu_seconds", "elapsed_seconds", "exit_code", "max_rss_kib", "output_bytes",
      "output_sha256", "process_tree_settled", "raw_output", "resource_accounting",
      "settled_at_unix_millis", "started_at_unix_millis", "task_cleanup_complete",
      "terminal_class",
    ])
    || raw.document_type !== verificationProfile.receiptDocumentType
    || raw.schema_version !== 1
    || raw.command_fingerprint !== fingerprint
    || raw.execution_identity_class !== "credentialless_project"
    || source.repository !== command.source.repository
    || source.commit !== command.source.commitOid
    || source.tree !== command.source.treeOid
    || profile.id !== command.profile.id
    || profile.class !== command.profile.class
    || profile.generation !== command.profile.versionSha256
    || profile.resource_class !== command.profile.resourceClass
    || profile.deadline_seconds !== command.profile.deadlineSeconds
    || isolation.network !== "none"
    || isolation.publisher_credentials !== "absent"
    || isolation.control_credentials !== "absent"
    || isolation.ssh_agent !== "absent"
    || isolation.sudo_admin !== "absent"
    || isolation.ambient_environment !== "cleared"
    || isolation.build_state !== "task_private_tmpfs"
    || isolation.filesystem !== "read_only_source_task_private_tmpfs"
    || isolation.package_cache !== "host_public_crates_io_read_only"
    || !["succeeded", "failed", "timed_out", "cleanup_incomplete"].includes(String(terminal))
    || result.process_tree_settled !== true
    || (terminal === "cleanup_incomplete"
      ? result.task_cleanup_complete !== false
      : result.task_cleanup_complete !== true)
    || result.raw_output !== "not_published"
    || !Number.isSafeInteger(result.output_bytes)
    || Number(result.output_bytes) < 0
    || Number(result.output_bytes) > 1_048_576
    || !SHA256.test(String(result.output_sha256))
    || typeof result.elapsed_seconds !== "number"
    || !Number.isFinite(result.elapsed_seconds)
    || result.elapsed_seconds < 0
    || !Number.isSafeInteger(result.started_at_unix_millis)
    || !Number.isSafeInteger(result.settled_at_unix_millis)
    || Number(result.settled_at_unix_millis) < Number(result.started_at_unix_millis)
    || raw.contains_private_content !== false
    || raw.contains_credentials !== false
    || raw.authorizes_work !== false
    || raw.authorizes_effects !== false
    || raw.authorizes_redispatch !== false
  ) throw new RangeError("Glaeda verification receipt changed exact command or isolation identity");
  return {
    raw,
    result: {
      terminal_class: terminal as GlaedaWorkstationReceiptV1["terminalClass"],
      started_at_unix_millis: Number(result.started_at_unix_millis),
      settled_at_unix_millis: Number(result.settled_at_unix_millis),
    },
  };
}

function runVerifyFocused(input: {
  python: string;
  script: string;
  arguments: string[];
  timeoutMilliseconds: number;
}) {
  const completed = spawnSync(input.python, [input.script, ...input.arguments], {
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_RESULT_BYTES + 1,
    timeout: input.timeoutMilliseconds,
  });
  return { status: completed.status, stdout: completed.stdout, stderr: completed.stderr };
}

function canonicalRegularFile(value: string, label: string): string {
  try {
    if (isAbsolute(value) && realpathSync(value) === value && statSync(value).isFile()) return value;
  } catch {
    // Collapse path-bearing errors.
  }
  throw new RangeError(`${label} must be a canonical absolute regular file`);
}

function canonicalDirectory(value: string, label: string): string {
  try {
    if (isAbsolute(value) && realpathSync(value) === value && statSync(value).isDirectory()) {
      return value;
    }
  } catch {
    // Collapse path-bearing errors.
  }
  throw new RangeError(`${label} must be a canonical absolute directory`);
}

function canonicalOrCreatableDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new RangeError(`${label} must be absolute`);
  try {
    const parent = value.slice(0, value.lastIndexOf("/")) || "/";
    if (realpathSync(parent) === parent && statSync(parent).isDirectory()) return value;
  } catch {
    // Collapse path-bearing errors.
  }
  throw new RangeError(`${label} must have one canonical existing parent`);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

class MissingVerificationReceiptError extends Error {}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
