import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import {
  fingerprintGlaedaWorkstationCommandV1,
  type GlaedaWorkstationCommandV1,
  type GlaedaWorkstationNodeV1,
  type GlaedaWorkstationReceiptV1,
} from "./glaeda-workstation-contracts.js";
import type {
  GlaedaWorkstationClientV1,
  PreparedGlaedaWorkstationCommandV1,
} from "./glaeda-workstation-adapter.js";
import { canonicalJsonString } from "./idempotency-request-fingerprint.js";

const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_PATCH_BYTES = 64 * 1024;
const DEFAULT_BLOB_BYTES = 16 * 1024;
const DEFAULT_HISTORY_COMMITS = 32;

export interface GlaedaRepoQueryRequestV1 {
  version: 1;
  repository: string;
  baseCommitOid: string;
  headCommitOid: string;
  headTreeOid: string;
  maxPatchBytes: number;
  profileVersionSha256: string;
}

export interface GlaedaRepoQueryResultV1 {
  requestSha256: string;
  resultSha256: string;
  resultBytes: number;
  report: Record<string, unknown>;
}

export type GlaedaRepoQueryProcess = (input: {
  binary: string;
  checkout: string;
  arguments: string[];
  timeoutMilliseconds: number;
}) => { status: number | null; stdout: Uint8Array; stderr: Uint8Array };

export class GlaedaRepoQueryWorkstationClientV1 implements GlaedaWorkstationClientV1 {
  readonly #binary: string;
  readonly #checkout: string;
  readonly #node: GlaedaWorkstationNodeV1;
  readonly #request: GlaedaRepoQueryRequestV1;
  readonly #requestSha256: string;
  readonly #process: GlaedaRepoQueryProcess;
  #lastResult: GlaedaRepoQueryResultV1 | null = null;

  constructor(input: {
    binary: string;
    checkout: string;
    node: GlaedaWorkstationNodeV1;
    request: GlaedaRepoQueryRequestV1;
    process?: GlaedaRepoQueryProcess;
  }) {
    this.#binary = canonicalRegularFile(input.binary, "Glaeda repo-query binary");
    this.#checkout = canonicalDirectory(input.checkout, "Glaeda checkout");
    this.#node = Object.freeze({ ...input.node });
    this.#request = normalizeRequest(input.request);
    this.#requestSha256 = fingerprintGlaedaRepoQueryRequestV1(this.#request);
    this.#process = input.process ?? runRepoQuery;
    if (sha256(readFileSync(this.#binary)) !== this.#node.glaedaRuntimeSha256) {
      throw new RangeError("Glaeda runtime digest does not match the configured binary");
    }
  }

  async check(command: GlaedaWorkstationCommandV1) {
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
      executionIdentityClass: "read_only_repository",
      supported: true,
      rawContentEmitted: false,
      authorizesWork: false,
      authorizesEffects: false,
    };
  }

  async execute(input: PreparedGlaedaWorkstationCommandV1): Promise<GlaedaWorkstationReceiptV1> {
    this.#assertCommand(input.command);
    const startedAt = new Date().toISOString();
    const result = this.#process({
      binary: this.#binary,
      checkout: this.#checkout,
      timeoutMilliseconds: input.command.profile.deadlineSeconds * 1_000,
      arguments: [
        "--checkout",
        this.#checkout,
        "--project",
        `github.com/${this.#request.repository}`,
        "--base",
        this.#request.baseCommitOid,
        "--head",
        this.#request.headCommitOid,
        "--tree",
        this.#request.headTreeOid,
        "--max-patch-bytes",
        String(this.#request.maxPatchBytes),
        "--output",
        "json",
      ],
    });
    if (result.status !== 0) {
      throw new Error(`Glaeda repo-query refused with status ${result.status ?? "signal"}`);
    }
    if (result.stdout.byteLength > MAX_RESULT_BYTES) {
      throw new RangeError("Glaeda repo-query result exceeds the aggregate byte ceiling");
    }
    const report = parseReport(result.stdout);
    if (
      report.document_type !== "glaeda-resident-repo-query"
      || report.authority !== "observation_only"
      || report.profile_id !== input.command.profile.id
      || report.profile_generation !== input.command.profile.versionSha256
      || report.request_digest !== input.command.profileRequestSha256
      || report.repository !== `github.com/${input.command.source.repository}`
      || report.head !== input.command.source.commitOid
      || report.head_tree !== input.command.source.treeOid
    ) {
      throw new RangeError("Glaeda repo-query result changed exact command identity");
    }
    const resultSha256 = sha256(result.stdout);
    this.#lastResult = Object.freeze({
      requestSha256: this.#requestSha256,
      resultSha256,
      resultBytes: result.stdout.byteLength,
      report: Object.freeze(report),
    });
    return {
      schema: "glaeda-workstation-receipt/v1",
      commandFingerprint: input.check.commandFingerprint,
      node: input.check.node,
      source: input.check.source,
      profile: input.check.profile,
      executionIdentityClass: "read_only_repository",
      terminalClass: "succeeded",
      resultSha256,
      resultBytes: result.stdout.byteLength,
      startedAt,
      settledAt: new Date().toISOString(),
      rawContentEmitted: false,
      containsPrivateContent: false,
      containsCredentials: false,
      authorizesWork: false,
      authorizesEffects: false,
      authorizesRedispatch: false,
    };
  }

  lastResult(): GlaedaRepoQueryResultV1 | null {
    return this.#lastResult;
  }

  #assertCommand(command: GlaedaWorkstationCommandV1): void {
    if (
      command.profile.id !== "repo-query/v1"
      || command.profile.class !== "repo_query"
      || command.profile.versionSha256 !== this.#request.profileVersionSha256
      || command.profileRequestSha256 !== this.#requestSha256
      || command.source.repository !== this.#request.repository
      || command.source.commitOid !== this.#request.headCommitOid
      || command.source.treeOid !== this.#request.headTreeOid
      || canonicalJsonString(command.node) !== canonicalJsonString(this.#node)
    ) {
      throw new RangeError("Glaeda repo-query client does not match the exact workstation command");
    }
  }
}

export function fingerprintGlaedaRepoQueryRequestV1(raw: GlaedaRepoQueryRequestV1): string {
  const request = normalizeRequest(raw);
  const fields = [
    `github.com/${request.repository}`,
    request.baseCommitOid,
    request.headCommitOid,
    request.headTreeOid,
    String(request.maxPatchBytes),
    "grep",
    "blobs",
    String(DEFAULT_BLOB_BYTES),
    "history",
    String(DEFAULT_HISTORY_COMMITS),
    "objects",
    request.profileVersionSha256,
  ];
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalizeRequest(value: GlaedaRepoQueryRequestV1): GlaedaRepoQueryRequestV1 {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [
      "baseCommitOid",
      "headCommitOid",
      "headTreeOid",
      "maxPatchBytes",
      "profileVersionSha256",
      "repository",
      "version",
    ].sort().join("\0")
    || value.version !== 1
    || !REPOSITORY.test(value.repository)
    || !GIT_OID.test(value.baseCommitOid)
    || !GIT_OID.test(value.headCommitOid)
    || !GIT_OID.test(value.headTreeOid)
    || value.baseCommitOid.length !== value.headCommitOid.length
    || value.headCommitOid.length !== value.headTreeOid.length
    || !Number.isSafeInteger(value.maxPatchBytes)
    || value.maxPatchBytes < 0
    || value.maxPatchBytes > MAX_PATCH_BYTES
    || !SHA256.test(value.profileVersionSha256)
  ) {
    throw new RangeError("Glaeda repo-query request is invalid");
  }
  return Object.freeze({ ...value });
}

function parseReport(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RangeError("Glaeda repo-query returned invalid bounded JSON");
  }
}

function canonicalRegularFile(value: string, label: string): string {
  try {
    if (isAbsolute(value) && realpathSync(value) === value && statSync(value).isFile()) return value;
  } catch {
    // Collapse path-bearing host errors into the content-minimised contract failure below.
  }
  throw new RangeError(`${label} must be a canonical absolute regular file`);
}

function canonicalDirectory(value: string, label: string): string {
  try {
    if (isAbsolute(value) && realpathSync(value) === value && statSync(value).isDirectory()) {
      return value;
    }
  } catch {
    // Collapse path-bearing host errors into the content-minimised contract failure below.
  }
  throw new RangeError(`${label} must be a canonical absolute directory`);
}

function runRepoQuery(input: {
  binary: string;
  checkout: string;
  arguments: string[];
  timeoutMilliseconds: number;
}) {
  const completed = spawnSync(input.binary, input.arguments, {
    cwd: input.checkout,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
    maxBuffer: MAX_RESULT_BYTES + 1,
    timeout: input.timeoutMilliseconds,
  });
  return {
    status: completed.status,
    stdout: completed.stdout,
    stderr: completed.stderr,
  };
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
