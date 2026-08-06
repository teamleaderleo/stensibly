import {
  GitHubProviderRejectedError,
  type GitHubProviderReceipt,
} from "./github-provider-contracts.js";
import type { GitHubIssueProviderWriteService } from "./github-issue-provider-mcp.js";
import {
  compileGitHubOutboundTextPreflightV1,
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  type GitHubOutboundTextPolicyV1,
  type GitHubOutboundTextPreflightResultV1,
} from "./github-outbound-text-preflight.js";
import {
  boundedBody,
  boundedText,
  normalizeGitHubRepository,
} from "./github-provider-validation.js";

const createIssueInputKeys = [
  "project",
  "repository",
  "actorId",
  "clientId",
  "capabilityGrantId",
  "approvalId",
  "title",
  "body",
  "labels",
  "assignees",
  "idempotencyKey",
] as const;
const requiredCreateIssueInputKeys = [
  "project",
  "repository",
  "actorId",
  "clientId",
  "title",
  "idempotencyKey",
] as const;
type CreateIssueInput =
  Parameters<GitHubIssueProviderWriteService["createIssue"]>[0];

const policyKeys = [
  "version",
  "policyId",
  "controlledRepositories",
  "externalReferenceDisposition",
] as const;
const maximumControlledRepositories = 32;
const maximumCreateIssueListEntries = 100;

export class GitHubOutboundTextPreflightError
  extends GitHubProviderRejectedError {
  readonly result: GitHubOutboundTextPreflightResultV1;

  constructor(result: GitHubOutboundTextPreflightResultV1) {
    const requiresAuthority = result.decision === "requires_authority";
    super(
      requiresAuthority
        ? "github_outbound_text_authority_required"
        : "github_outbound_text_rejected",
      requiresAuthority
        ? "GitHub outbound text requires explicit external-interaction authority"
        : "GitHub outbound text was rejected before provider dispatch",
    );
    this.name = "GitHubOutboundTextPreflightError";
    this.result = result;
  }
}

/**
 * Applies the existing outbound-text policy to one exact provider-bound issue
 * create snapshot before delegating to the typed write service. Other write
 * methods remain byte-for-byte delegated and the guard grants no authority.
 */
export class GitHubOutboundTextPreflightWriteService
  implements GitHubIssueProviderWriteService {
  readonly #service: GitHubIssueProviderWriteService;
  readonly #policy: GitHubOutboundTextPolicyV1;

  constructor(
    service: GitHubIssueProviderWriteService,
    policy: GitHubOutboundTextPolicyV1,
  ) {
    this.#service = service;
    this.#policy = snapshotPolicy(policy);
  }

  async createIssue(
    input: Parameters<GitHubIssueProviderWriteService["createIssue"]>[0],
  ): Promise<GitHubProviderReceipt> {
    const snapshot = snapshotCreateIssueInput(input);
    const repositoryFullName = normalizeGitHubRepository(snapshot.repository);
    const title = boundedText(snapshot.title, "GitHub issue title", 256);
    const body = snapshot.body === undefined
      ? undefined
      : boundedBody(snapshot.body, "GitHub issue body", 128 * 1024);

    this.#admit(repositoryFullName, "title", title);
    if (body !== undefined) {
      this.#admit(repositoryFullName, "body", body);
    }

    return await this.#service.createIssue({
      ...snapshot,
      repository: repositoryFullName,
      title,
      ...(body === undefined ? {} : { body }),
    });
  }

  updateIssue(
    input: Parameters<GitHubIssueProviderWriteService["updateIssue"]>[0],
  ): Promise<GitHubProviderReceipt> {
    return this.#service.updateIssue(input);
  }

  addIssueComment(
    input: Parameters<GitHubIssueProviderWriteService["addIssueComment"]>[0],
  ): Promise<GitHubProviderReceipt> {
    return this.#service.addIssueComment(input);
  }

  #admit(
    repositoryFullName: string,
    field: "title" | "body",
    text: string,
  ): void {
    const result = compileGitHubOutboundTextPreflightV1({
      schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policy: this.#policy,
      repositoryFullName,
      field,
      text,
    });
    if (result.decision !== "pass") {
      throw new GitHubOutboundTextPreflightError(result);
    }
  }
}

function snapshotCreateIssueInput(value: unknown): CreateIssueInput {
  if (value === null || typeof value !== "object") {
    throw new TypeError("GitHub issue create input must be an object");
  }
  let isArray: boolean;
  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("GitHub issue create input could not be inspected");
  }
  if (isArray) {
    throw new TypeError("GitHub issue create input must be an object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("GitHub issue create input must use a plain prototype");
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.some((key) =>
      typeof key !== "string"
      || !(createIssueInputKeys as readonly string[]).includes(key)
    )
  ) {
    throw new TypeError("GitHub issue create input has invalid fields");
  }
  if (
    requiredCreateIssueInputKeys.some((key) => descriptors[key] === undefined)
  ) {
    throw new TypeError("GitHub issue create input is missing required fields");
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of createIssueInputKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(
        "GitHub issue create input fields must be enumerable data properties",
      );
    }
    if (
      (key === "labels" || key === "assignees")
      && descriptor.value !== undefined
    ) {
      snapshot[key] = snapshotCreateIssueList(descriptor.value, key);
      continue;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot) as unknown as CreateIssueInput;
}

function snapshotCreateIssueList(
  value: unknown,
  label: "labels" | "assignees",
): readonly unknown[] {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`GitHub issue create ${label} must be an ordinary array`);
  }
  let isArray: boolean;
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new TypeError(`GitHub issue create ${label} could not be inspected`);
  }
  if (!isArray || prototype !== Array.prototype) {
    throw new TypeError(`GitHub issue create ${label} must be an ordinary array`);
  }
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumCreateIssueListEntries
  ) {
    throw new RangeError(
      `GitHub issue create ${label} accepts at most ${maximumCreateIssueListEntries} entries`,
    );
  }

  const entries: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw new TypeError(`GitHub issue create ${label} could not be inspected`);
    }
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(
        `GitHub issue create ${label} must contain dense enumerable data entries`,
      );
    }
    entries.push(descriptor.value);
  }
  return Object.freeze(entries);
}

function snapshotPolicy(value: unknown): GitHubOutboundTextPolicyV1 {
  const record = exactPolicyRecord(value);
  const controlledRepositories = snapshotDenseArray(
    record.controlledRepositories,
  );
  const snapshot = Object.freeze({
    version: record.version as typeof GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policyId: record.policyId as string,
    controlledRepositories: Object.freeze(
      controlledRepositories as string[],
    ),
    externalReferenceDisposition:
      record.externalReferenceDisposition as
        GitHubOutboundTextPolicyV1["externalReferenceDisposition"],
  });

  compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: snapshot,
    repositoryFullName: snapshot.controlledRepositories[0] as string,
    field: "title",
    text: "",
  });
  return snapshot;
}

function exactPolicyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("GitHub outbound text policy must be an object");
  }
  let isArray: boolean;
  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("GitHub outbound text policy could not be inspected");
  }
  if (isArray) {
    throw new TypeError("GitHub outbound text policy must be an object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("GitHub outbound text policy must use a plain prototype");
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== policyKeys.length
    || ownKeys.some((key) =>
      typeof key !== "string"
      || !(policyKeys as readonly string[]).includes(key)
    )
  ) {
    throw new TypeError("GitHub outbound text policy has invalid fields");
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of policyKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(
        "GitHub outbound text policy fields must be enumerable data properties",
      );
    }
    record[key] = descriptor.value;
  }
  return record;
}

function snapshotDenseArray(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") {
    throw new TypeError(
      "GitHub outbound controlled repositories must be an array",
    );
  }
  let isArray: boolean;
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new TypeError(
      "GitHub outbound controlled repositories could not be inspected",
    );
  }
  if (!isArray || prototype !== Array.prototype) {
    throw new TypeError(
      "GitHub outbound controlled repositories must be an array",
    );
  }
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumControlledRepositories
  ) {
    throw new RangeError(
      `GitHub outbound controlled repositories accepts at most ${maximumControlledRepositories} entries`,
    );
  }
  const length = lengthDescriptor.value as number;
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw new TypeError(
        "GitHub outbound controlled repositories must contain only dense data entries",
      );
    }
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(
        "GitHub outbound controlled repositories must contain only dense data entries",
      );
    }
    entries.push(descriptor.value);
  }
  return entries;
}
