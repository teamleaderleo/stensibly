import { createHash } from "node:crypto";
import { sha256, stableJson } from "./canonical-json.js";
import {
  admitGitHubBranchRef,
  admitGitHubRepositoryFullName,
  admitGitHubRepositoryPath,
  admitGitObjectId,
  sameGitObjectFormat,
} from "./github-repository-write-admission.js";

export const repositoryWriteOperations = [
  "create_file",
  "update_file",
  "delete_file",
] as const;

export type RepositoryWriteOperation = typeof repositoryWriteOperations[number];

export interface RepositoryWriteIntent {
  version: 1;
  repositoryFullName: string;
  path: string;
  operation: RepositoryWriteOperation;
  targetRef: string;
  expectedParentSha: string;
}

export interface RepositoryWriteAuthority {
  version: 1;
  repositoryFullName: string;
  targetRef: string;
  defaultBranch: string;
  authorityId: string;
  authorityGeneration: number;
  defaultBranchApprovalId: string | null;
}

export interface PreparedRepositoryWrite extends RepositoryWriteIntent {
  state: "prepared";
  defaultBranch: string;
  authorityId: string;
  authorityGeneration: number;
  defaultBranchApprovalId: string | null;
  requestSha256: string;
  authorizesProviderDispatch: false;
}

export interface RepositoryWriteProviderResult {
  commitSha?: string;
  providerRequestId?: string;
  targetRef?: string;
  parentSha?: string;
}

export interface RepositoryWriteRefReader {
  getRefHead(input: {
    repositoryFullName: string;
    targetRef: string;
  }): Promise<string | null>;
  getCommitParents(input: {
    repositoryFullName: string;
    commitSha: string;
  }): Promise<readonly string[]>;
}

export interface RepositoryWriteTreeEntry {
  path: string;
  mode: "100644" | "100755" | "120000" | "160000";
  type: "blob" | "commit";
  sha: string;
}

export interface RepositoryWriteCommitTreeSnapshot {
  version: 1;
  repositoryFullName: string;
  commitSha: string;
  parentShas: readonly string[];
  messageSha256: string;
  treeSha: string;
  entries: readonly RepositoryWriteTreeEntry[];
}

export interface RepositoryWriteReadbackReader extends RepositoryWriteRefReader {
  getCommitTreeSnapshot(input: {
    repositoryFullName: string;
    commitSha: string;
  }): Promise<unknown>;
}

export type RepositoryWriteReadbackPayload =
  | { operation: "create_file"; content: string; message: string }
  | { operation: "update_file"; content: string; contentSha: string; message: string }
  | { operation: "delete_file"; contentSha: string; message: string };

export interface VerifiedRepositoryWrite {
  version: 1;
  state: "verified";
  repositoryFullName: string;
  path: string;
  operation: RepositoryWriteOperation;
  targetRef: string;
  defaultBranch: string;
  expectedParentSha: string;
  authorityId: string;
  authorityGeneration: number;
  defaultBranchApprovalId: string | null;
  commitSha: string;
  nextExpectedParentSha: string;
  providerRequestId: string | null;
  requestSha256: string;
  verifiedAt: string;
  authorizesRetry: false;
}

export type RepositoryWriteFenceDisposition =
  | "rejected"
  | "pending_reconciliation";

export class RepositoryWriteFenceError extends Error {
  readonly code: string;
  readonly disposition: RepositoryWriteFenceDisposition;
  readonly retry: "do_not_retry" | "reconcile_before_retry";
  readonly evidence: Readonly<Record<string, string | null>>;

  constructor(input: {
    code: string;
    message: string;
    disposition: RepositoryWriteFenceDisposition;
    retry: "do_not_retry" | "reconcile_before_retry";
    evidence?: Record<string, string | null>;
  }) {
    super(input.message);
    this.name = "RepositoryWriteFenceError";
    this.code = input.code;
    this.disposition = input.disposition;
    this.retry = input.retry;
    this.evidence = Object.freeze({ ...(input.evidence ?? {}) });
  }
}

const intentKeys = [
  "version",
  "repositoryFullName",
  "path",
  "operation",
  "targetRef",
  "expectedParentSha",
] as const;

const authorityKeys = [
  "version",
  "repositoryFullName",
  "targetRef",
  "defaultBranch",
  "authorityId",
  "authorityGeneration",
  "defaultBranchApprovalId",
] as const;

const preparedKeys = [
  ...intentKeys,
  "state",
  "defaultBranch",
  "authorityId",
  "authorityGeneration",
  "defaultBranchApprovalId",
  "requestSha256",
  "authorizesProviderDispatch",
] as const;

const providerResultKeys = [
  "commitSha",
  "providerRequestId",
  "targetRef",
  "parentSha",
] as const;

const credentialShapedPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{24,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}|bearer\s+[A-Za-z0-9._~+\/-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

/**
 * Admits caller intent beside one already-authoritative server decision.
 * The returned record is evidence only and cannot authorize provider dispatch.
 */
export function prepareRepositoryWrite(
  intentInput: unknown,
  authorityInput: unknown,
): PreparedRepositoryWrite {
  const intentRecord = exactRecord(
    intentInput,
    intentKeys,
    [],
    () => {
      throw rejected(
        "invalid_repository_write_intent",
        "Repository write intent is invalid",
      );
    },
  );
  const authorityRecord = exactRecord(
    authorityInput,
    authorityKeys,
    [],
    () => {
      throw rejected(
        "invalid_repository_write_authority",
        "Repository write authority is invalid",
      );
    },
  );

  const intent = admitIntent(intentRecord);
  const authority = admitAuthority(authorityRecord);
  return buildPrepared(intent, authority);
}

/**
 * Verifies that the provider-reported write became the exact target-ref head and
 * produced one direct child commit. A local verification result never authorizes retry.
 */
export async function verifyRepositoryWriteResult(input: {
  prepared: unknown;
  providerResult: unknown;
  refs: RepositoryWriteRefReader;
  now?: () => string;
}): Promise<VerifiedRepositoryWrite> {
  const prepared = admitPrepared(input.prepared);
  const providerResult = admitProviderResult(input.providerResult, prepared);

  if (providerResult.targetRef !== null && providerResult.targetRef !== prepared.targetRef) {
    throw pending(
      "provider_target_ref_mismatch",
      "Provider write evidence names another target ref",
      prepared,
      providerResult,
    );
  }
  if (providerResult.parentSha !== null && providerResult.parentSha !== prepared.expectedParentSha) {
    throw pending(
      "provider_parent_mismatch",
      "Provider write evidence names another parent commit",
      prepared,
      providerResult,
    );
  }
  if (providerResult.commitSha === null) {
    throw pending(
      "provider_commit_identity_missing",
      "Provider write evidence omitted the commit identity",
      prepared,
      providerResult,
    );
  }
  if (!sameGitObjectFormat(providerResult.commitSha, prepared.expectedParentSha)) {
    throw pending(
      "provider_write_evidence_invalid",
      "Provider write evidence is invalid",
      prepared,
      providerResult,
    );
  }

  let refHeadValue: string | null;
  let parentValues: readonly string[];
  try {
    [refHeadValue, parentValues] = await Promise.all([
      input.refs.getRefHead({
        repositoryFullName: prepared.repositoryFullName,
        targetRef: prepared.targetRef,
      }),
      input.refs.getCommitParents({
        repositoryFullName: prepared.repositoryFullName,
        commitSha: providerResult.commitSha,
      }),
    ]);
  } catch {
    throw pending(
      "repository_write_verification_unavailable",
      "Repository write verification could not read canonical provider state",
      prepared,
      providerResult,
    );
  }

  let refHead: string | null;
  let parents: readonly string[];
  try {
    refHead = refHeadValue === null
      ? null
      : exactCommitSha(refHeadValue, "Target ref head");
    parents = exactCommitParents(parentValues);
  } catch {
    throw pending(
      "repository_write_verification_invalid",
      "Repository write verification returned invalid canonical evidence",
      prepared,
      providerResult,
    );
  }

  if (refHead !== providerResult.commitSha) {
    throw pending(
      "target_ref_did_not_land_on_returned_commit",
      "Target ref does not point to the returned commit",
      prepared,
      providerResult,
      { observedRefHead: refHead },
    );
  }
  if (parents.length !== 1 || parents[0] !== prepared.expectedParentSha) {
    throw pending(
      "returned_commit_is_not_exact_direct_child",
      "Returned commit is not the exact single-parent child promised by the write",
      prepared,
      providerResult,
      { observedParentCount: String(parents.length) },
    );
  }

  const now = input.now ?? (() => new Date().toISOString());
  let verifiedAt: string;
  try {
    const clockValue = now();
    verifiedAt = exactUtcTimestamp(clockValue, "Repository write verification time");
  } catch {
    throw pending(
      "repository_write_verification_clock_invalid",
      "Repository write verification clock is invalid",
      prepared,
      providerResult,
    );
  }

  return Object.freeze({
    version: 1,
    state: "verified",
    repositoryFullName: prepared.repositoryFullName,
    path: prepared.path,
    operation: prepared.operation,
    targetRef: prepared.targetRef,
    defaultBranch: prepared.defaultBranch,
    expectedParentSha: prepared.expectedParentSha,
    authorityId: prepared.authorityId,
    authorityGeneration: prepared.authorityGeneration,
    defaultBranchApprovalId: prepared.defaultBranchApprovalId,
    commitSha: providerResult.commitSha,
    nextExpectedParentSha: providerResult.commitSha,
    providerRequestId: providerResult.providerRequestId,
    requestSha256: prepared.requestSha256,
    verifiedAt,
    authorizesRetry: false,
  });
}

/**
 * Proves an ambiguous exact-CAS write from complete canonical Git trees. The
 * candidate must be the current direct-child head and its complete non-tree
 * entry set must differ from the expected parent at exactly the requested path.
 */
export async function verifyRepositoryWriteReadback(input: {
  prepared: unknown;
  payload: unknown;
  refs: RepositoryWriteReadbackReader;
  now?: () => string;
}): Promise<VerifiedRepositoryWrite> {
  const prepared = admitPrepared(input.prepared);
  const payload = admitReadbackPayload(input.payload, prepared);

  let headValue: string | null;
  try {
    headValue = await input.refs.getRefHead({
      repositoryFullName: prepared.repositoryFullName,
      targetRef: prepared.targetRef,
    });
  } catch {
    throw readbackPending(prepared, "repository_write_readback_unavailable");
  }
  if (headValue === null) {
    throw readbackPending(prepared, "repository_write_readback_effect_not_proven");
  }

  let head: string;
  try {
    head = exactCommitSha(headValue, "Repository write readback head");
  } catch {
    throw readbackPending(prepared, "repository_write_readback_invalid");
  }
  if (head === prepared.expectedParentSha) {
    throw readbackPending(prepared, "repository_write_readback_effect_not_proven");
  }

  let parentSnapshot: RepositoryWriteCommitTreeSnapshot;
  let candidateSnapshot: RepositoryWriteCommitTreeSnapshot;
  try {
    [parentSnapshot, candidateSnapshot] = await Promise.all([
      input.refs.getCommitTreeSnapshot({
        repositoryFullName: prepared.repositoryFullName,
        commitSha: prepared.expectedParentSha,
      }).then((value) => admitCommitTreeSnapshot(value, prepared.expectedParentSha)),
      input.refs.getCommitTreeSnapshot({
        repositoryFullName: prepared.repositoryFullName,
        commitSha: head,
      }).then((value) => admitCommitTreeSnapshot(value, head)),
    ]);
  } catch {
    throw readbackPending(prepared, "repository_write_readback_unavailable");
  }
  if (
    parentSnapshot.repositoryFullName !== prepared.repositoryFullName
    || candidateSnapshot.repositoryFullName !== prepared.repositoryFullName
    || candidateSnapshot.parentShas.length !== 1
    || candidateSnapshot.parentShas[0] !== prepared.expectedParentSha
    || candidateSnapshot.messageSha256 !== sha256(payload.message)
  ) {
    throw readbackPending(prepared, "repository_write_readback_identity_mismatch");
  }

  const parentEntries = entryMap(parentSnapshot.entries);
  const candidateEntries = entryMap(candidateSnapshot.entries);
  const prior = parentEntries.get(prepared.path) ?? null;
  const expected = new Map(parentEntries);
  if (payload.operation === "create_file") {
    if (prior !== null) {
      throw readbackPending(prepared, "repository_write_readback_precondition_mismatch");
    }
    expected.set(prepared.path, {
      path: prepared.path,
      mode: "100644",
      type: "blob",
      sha: gitBlobObjectId(payload.content, head.length),
    });
  } else {
    if (
      prior === null
      || prior.type !== "blob"
      || (prior.mode !== "100644" && prior.mode !== "100755")
      || prior.sha !== payload.contentSha
    ) {
      throw readbackPending(prepared, "repository_write_readback_precondition_mismatch");
    }
    if (payload.operation === "delete_file") {
      expected.delete(prepared.path);
    } else {
      expected.set(prepared.path, {
        path: prepared.path,
        mode: prior.mode,
        type: "blob",
        sha: gitBlobObjectId(payload.content, head.length),
      });
    }
  }
  if (!sameEntryMaps(expected, candidateEntries)) {
    throw readbackPending(prepared, "repository_write_readback_tree_mismatch");
  }

  return await verifyRepositoryWriteResult({
    prepared,
    providerResult: {
      commitSha: head,
      targetRef: prepared.targetRef,
      parentSha: prepared.expectedParentSha,
    },
    refs: {
      getRefHead: async () => head,
      getCommitParents: async () => candidateSnapshot.parentShas,
    },
    ...(input.now ? { now: input.now } : {}),
  });
}

function admitReadbackPayload(
  value: unknown,
  prepared: PreparedRepositoryWrite,
): RepositoryWriteReadbackPayload {
  try {
    const operationRecord = exactRecord(value, ["operation"], [
      "content",
      "contentSha",
      "message",
    ], () => {
      throw new RangeError("invalid readback payload");
    });
    if (operationRecord.operation !== prepared.operation) {
      throw new RangeError("readback operation mismatch");
    }
    const message = readbackMessage(operationRecord.message);
    if (prepared.operation === "create_file") {
      requireReadbackKeys(operationRecord, ["operation", "content", "message"]);
      return Object.freeze({
        operation: prepared.operation,
        content: readbackContent(operationRecord.content),
        message,
      });
    }
    requireReadbackKeys(
      operationRecord,
      prepared.operation === "update_file"
        ? ["operation", "content", "contentSha", "message"]
        : ["operation", "contentSha", "message"],
    );
    const contentSha = exactCommitSha(
      operationRecord.contentSha,
      "Repository write readback content SHA",
    );
    if (prepared.operation === "delete_file") {
      return Object.freeze({ operation: prepared.operation, contentSha, message });
    }
    return Object.freeze({
      operation: prepared.operation,
      content: readbackContent(operationRecord.content),
      contentSha,
      message,
    });
  } catch {
    throw readbackPending(prepared, "repository_write_readback_payload_invalid");
  }
}

function admitCommitTreeSnapshot(
  value: unknown,
  expectedCommitSha: string,
): RepositoryWriteCommitTreeSnapshot {
  const fail = () => {
    throw new RangeError("invalid commit tree snapshot");
  };
  const record = exactRecord(value, [
    "version",
    "repositoryFullName",
    "commitSha",
    "parentShas",
    "messageSha256",
    "treeSha",
    "entries",
  ], [], fail);
  if (record.version !== 1) fail();
  const repositoryFullName = exactRepository(record.repositoryFullName);
  const commitSha = exactCommitSha(record.commitSha, "Commit tree snapshot SHA");
  const parentShas = exactCommitParents(record.parentShas);
  const messageSha256 = exactReadbackSha256(record.messageSha256);
  const treeSha = exactCommitSha(record.treeSha, "Commit tree snapshot tree SHA");
  if (
    commitSha !== expectedCommitSha
    || !sameGitObjectFormat(commitSha, treeSha, ...parentShas)
  ) fail();

  const rawEntries = exactDataArray(record.entries, 100_000, fail);
  const entries: RepositoryWriteTreeEntry[] = [];
  const paths = new Set<string>();
  for (const raw of rawEntries) {
    const entry = exactRecord(raw, ["path", "mode", "type", "sha"], [], fail);
    const path = exactRepositoryPath(entry.path);
    if (paths.has(path)) fail();
    paths.add(path);
    const type = entry.type;
    const mode = entry.mode;
    if (
      (type !== "blob" && type !== "commit")
      || (type === "blob"
        ? mode !== "100644" && mode !== "100755" && mode !== "120000"
        : mode !== "160000")
    ) fail();
    const sha = exactCommitSha(entry.sha, "Commit tree entry SHA");
    if (!sameGitObjectFormat(commitSha, sha)) fail();
    entries.push({ path, mode, type, sha } as RepositoryWriteTreeEntry);
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Object.freeze({
    version: 1,
    repositoryFullName,
    commitSha,
    parentShas,
    messageSha256,
    treeSha,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
}

function exactDataArray(
  value: unknown,
  maximumLength: number,
  fail: () => never,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  if (Object.getOwnPropertySymbols(value).length > 0) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : null;
  if (
    typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > maximumLength
  ) fail();
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) fail();
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail();
    result.push(descriptor.value);
  }
  return result;
}

function requireReadbackKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) throw new RangeError("invalid readback payload keys");
}

function readbackContent(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 10 * 1024 * 1024) {
    throw new RangeError("invalid readback content");
  }
  return value;
}

function readbackMessage(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value !== value.trim()
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) throw new RangeError("invalid readback message");
  return value;
}

function exactReadbackSha256(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError("invalid readback message digest");
  }
  return value;
}

function entryMap(
  entries: readonly RepositoryWriteTreeEntry[],
): Map<string, RepositoryWriteTreeEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function sameEntryMaps(
  expected: ReadonlyMap<string, RepositoryWriteTreeEntry>,
  actual: ReadonlyMap<string, RepositoryWriteTreeEntry>,
): boolean {
  if (expected.size !== actual.size) return false;
  for (const [path, entry] of expected) {
    const observed = actual.get(path);
    if (
      !observed
      || observed.path !== entry.path
      || observed.mode !== entry.mode
      || observed.type !== entry.type
      || observed.sha !== entry.sha
    ) return false;
  }
  return true;
}

function gitBlobObjectId(content: string, objectIdLength: number): string {
  const algorithm = objectIdLength === 40
    ? "sha1"
    : objectIdLength === 64
      ? "sha256"
      : null;
  if (!algorithm) throw new RangeError("invalid Git object format");
  const bytes = Buffer.from(content, "utf8");
  return createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function readbackPending(
  prepared: PreparedRepositoryWrite,
  code: string,
): RepositoryWriteFenceError {
  return pending(
    code,
    "Repository write readback did not prove the exact requested effect",
    prepared,
    null,
  );
}

interface AdmittedIntent {
  version: 1;
  repositoryFullName: string;
  path: string;
  operation: RepositoryWriteOperation;
  targetRef: string;
  expectedParentSha: string;
}

interface AdmittedAuthority {
  version: 1;
  repositoryFullName: string;
  targetRef: string;
  defaultBranch: string;
  authorityId: string;
  authorityGeneration: number;
  defaultBranchApprovalId: string | null;
}

interface AdmittedProviderResult {
  commitSha: string | null;
  providerRequestId: string | null;
  targetRef: string | null;
  parentSha: string | null;
}

function admitIntent(record: Record<string, unknown>): AdmittedIntent {
  if (record.version !== 1) {
    throw rejected(
      "unsupported_repository_write_version",
      "Repository write intent version must be 1",
    );
  }
  return {
    version: 1,
    repositoryFullName: exactRepository(record.repositoryFullName),
    path: exactRepositoryPath(record.path),
    operation: exactOperation(record.operation),
    targetRef: exactBranchRef(record.targetRef, "Repository write target ref"),
    expectedParentSha: exactCommitSha(record.expectedParentSha, "Expected parent SHA"),
  };
}

function admitAuthority(record: Record<string, unknown>): AdmittedAuthority {
  if (record.version !== 1) {
    throw rejected(
      "unsupported_repository_write_authority_version",
      "Repository write authority version must be 1",
    );
  }
  return {
    version: 1,
    repositoryFullName: exactRepository(record.repositoryFullName),
    targetRef: exactBranchRef(record.targetRef, "Authorized target ref"),
    defaultBranch: exactBranchRef(record.defaultBranch, "Authoritative default branch"),
    authorityId: exactIdentifier(record.authorityId, "Repository write authority ID"),
    authorityGeneration: exactPositiveInteger(
      record.authorityGeneration,
      "Repository write authority generation",
    ),
    defaultBranchApprovalId: nullableIdentifier(
      record.defaultBranchApprovalId,
      "Default-branch approval ID",
    ),
  };
}

function buildPrepared(
  intent: AdmittedIntent,
  authority: AdmittedAuthority,
): PreparedRepositoryWrite {
  if (intent.repositoryFullName !== authority.repositoryFullName) {
    throw rejected(
      "repository_write_authority_repository_mismatch",
      "Repository write authority covers another repository",
    );
  }
  if (intent.targetRef !== authority.targetRef) {
    throw rejected(
      "repository_write_authority_target_mismatch",
      "Repository write authority covers another target ref",
    );
  }
  const targetsDefaultBranch = intent.targetRef === authority.defaultBranch;
  if (targetsDefaultBranch && authority.defaultBranchApprovalId === null) {
    throw rejected(
      "default_branch_approval_required",
      "Default-branch repository writes require trusted approval evidence",
    );
  }
  if (!targetsDefaultBranch && authority.defaultBranchApprovalId !== null) {
    throw rejected(
      "irrelevant_default_branch_approval",
      "Default-branch approval evidence cannot be attached to another target ref",
    );
  }

  const fingerprintInput = {
    version: 1 as const,
    repositoryFullName: intent.repositoryFullName,
    path: intent.path,
    operation: intent.operation,
    targetRef: intent.targetRef,
    defaultBranch: authority.defaultBranch,
    expectedParentSha: intent.expectedParentSha,
    authorityId: authority.authorityId,
    authorityGeneration: authority.authorityGeneration,
    defaultBranchApprovalId: authority.defaultBranchApprovalId,
    authorizesProviderDispatch: false as const,
  };
  return Object.freeze({
    ...fingerprintInput,
    state: "prepared",
    requestSha256: sha256(stableJson(fingerprintInput)),
  });
}

function admitPrepared(value: unknown): PreparedRepositoryWrite {
  const record = exactRecord(
    value,
    preparedKeys,
    [],
    () => {
      throw rejected(
        "invalid_prepared_repository_write",
        "Prepared repository write is invalid",
      );
    },
  );
  if (record.state !== "prepared" || record.authorizesProviderDispatch !== false) {
    throw rejected(
      "invalid_prepared_repository_write",
      "Prepared repository write is invalid",
    );
  }
  const expected = buildPrepared(
    admitIntent(record),
    admitAuthority({
      version: record.version,
      repositoryFullName: record.repositoryFullName,
      targetRef: record.targetRef,
      defaultBranch: record.defaultBranch,
      authorityId: record.authorityId,
      authorityGeneration: record.authorityGeneration,
      defaultBranchApprovalId: record.defaultBranchApprovalId,
    }),
  );
  if (record.requestSha256 !== expected.requestSha256) {
    throw rejected(
      "prepared_repository_write_fingerprint_mismatch",
      "Prepared repository write fingerprint does not match its admitted content",
    );
  }
  return expected;
}

function admitProviderResult(
  value: unknown,
  prepared: PreparedRepositoryWrite,
): AdmittedProviderResult {
  let record: Record<string, unknown>;
  try {
    record = exactRecord(
      value,
      [],
      providerResultKeys,
      () => {
        throw new RangeError("invalid provider result");
      },
    );
  } catch {
    throw pending(
      "provider_write_evidence_invalid",
      "Provider write evidence is invalid",
      prepared,
      null,
    );
  }

  let commitSha: string | null;
  try {
    commitSha = optionalCommitSha(record.commitSha, "Provider commit SHA");
  } catch {
    throw pending(
      "provider_write_evidence_invalid",
      "Provider write evidence is invalid",
      prepared,
      null,
    );
  }

  const partial: AdmittedProviderResult = {
    commitSha,
    providerRequestId: null,
    targetRef: null,
    parentSha: null,
  };
  try {
    partial.providerRequestId = nullableSafeIdentifier(
      record.providerRequestId,
      "Provider request ID",
    );
    partial.targetRef = record.targetRef === undefined
      ? null
      : exactBranchRef(record.targetRef, "Provider target ref");
    partial.parentSha = optionalCommitSha(record.parentSha, "Provider parent SHA");
  } catch {
    throw pending(
      "provider_write_evidence_invalid",
      "Provider write evidence is invalid",
      prepared,
      partial,
    );
  }
  return partial;
}

function exactRecord<const Required extends readonly string[], const Optional extends readonly string[]>(
  value: unknown,
  requiredKeys: Required,
  optionalKeys: Optional,
  fail: () => never,
): Record<Required[number] | Optional[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  if (Object.getOwnPropertySymbols(value).length > 0) fail();

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set<string>([...requiredKeys, ...optionalKeys]);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key) || !descriptor.enumerable || !("value" in descriptor)) fail();
    result[key] = descriptor.value;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(descriptors, key)) fail();
  }
  return result as Record<Required[number] | Optional[number], unknown>;
}

function exactCommitParents(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError("Commit parents must be an ordinary array");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError("Commit parents contain a symbol field");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) {
    throw new RangeError("Commit parents length is invalid");
  }
  const lengthValue = lengthDescriptor.value;
  if (
    typeof lengthValue !== "number"
    || !Number.isSafeInteger(lengthValue)
    || lengthValue < 0
    || lengthValue > 16
  ) {
    throw new RangeError("Commit parents length is invalid");
  }
  const length = lengthValue;
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
      throw new RangeError("Commit parents contain an unknown field");
    }
  }
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError("Commit parents must be dense enumerable data entries");
    }
    result.push(exactCommitSha(descriptor.value, "Commit parent SHA"));
  }
  return Object.freeze(result);
}

function exactRepository(value: unknown): string {
  try {
    return admitGitHubRepositoryFullName(value);
  } catch {
    throw rejected(
      "invalid_repository_full_name",
      "Use one exact canonical lowercase GitHub owner/repository identity",
    );
  }
}

function exactRepositoryPath(value: unknown): string {
  try {
    return admitGitHubRepositoryPath(value);
  } catch {
    throw rejected("invalid_repository_path", "Repository path is invalid");
  }
}

function exactOperation(value: unknown): RepositoryWriteOperation {
  if (
    typeof value !== "string"
    || !repositoryWriteOperations.includes(value as RepositoryWriteOperation)
  ) {
    throw rejected(
      "invalid_repository_write_operation",
      "Repository write operation is invalid",
    );
  }
  return value as RepositoryWriteOperation;
}

function exactBranchRef(value: unknown, _label: string): string {
  try {
    return admitGitHubBranchRef(value);
  } catch {
    throw rejected("invalid_repository_target_ref", "Repository target ref is invalid");
  }
}

function exactCommitSha(value: unknown, _label: string): string {
  try {
    return admitGitObjectId(value);
  } catch {
    throw rejected(
      "invalid_commit_sha",
      "Commit identity must use exact lowercase full hexadecimal bytes",
    );
  }
}

function optionalCommitSha(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : exactCommitSha(value, label);
}

function exactIdentifier(value: unknown, label: string): string {
  const text = exactAscii(value, label, 240);
  if (
    credentialShapedPattern.test(text)
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,238}[A-Za-z0-9])?$/u.test(text)
  ) {
    throw rejected(
      "invalid_repository_write_identifier",
      "Repository write identifier is invalid",
    );
  }
  return text;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : exactIdentifier(value, label);
}

function nullableSafeIdentifier(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : exactIdentifier(value, label);
}

function exactPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw rejected(
      "invalid_repository_write_generation",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function exactAscii(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string") {
    throw rejected("invalid_repository_write_text", `${label} must be a string`);
  }
  if (
    value.length < 1
    || value.length > maximumBytes
    || !/^[\x20-\x7e]+$/u.test(value)
    || credentialShapedPattern.test(value)
  ) {
    throw rejected(
      "invalid_repository_write_text",
      `${label} contains invalid bytes`,
    );
  }
  return value;
}

function exactUtcTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !utcTimestampPattern.test(value)) {
    throw new RangeError(`${label} must be an exact UTC timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== normalizeUtcTimestamp(value)) {
    throw new RangeError(`${label} must be a valid UTC timestamp`);
  }
  return date.toISOString();
}

function normalizeUtcTimestamp(value: string): string {
  return value.includes(".") ? value : value.replace("Z", ".000Z");
}

function pending(
  code: string,
  message: string,
  prepared: PreparedRepositoryWrite,
  providerResult: AdmittedProviderResult | null,
  extra: Record<string, string | null> = {},
): RepositoryWriteFenceError {
  return new RepositoryWriteFenceError({
    code,
    message,
    disposition: "pending_reconciliation",
    retry: "reconcile_before_retry",
    evidence: {
      repositoryFullName: prepared.repositoryFullName,
      targetRef: prepared.targetRef,
      expectedParentSha: prepared.expectedParentSha,
      requestSha256: prepared.requestSha256,
      returnedCommitSha: providerResult?.commitSha ?? null,
      providerRequestId: providerResult?.providerRequestId ?? null,
      ...extra,
    },
  });
}

function rejected(
  code: string,
  message: string,
  evidence: Record<string, string | null> = {},
): RepositoryWriteFenceError {
  return new RepositoryWriteFenceError({
    code,
    message,
    disposition: "rejected",
    retry: "do_not_retry",
    evidence,
  });
}
