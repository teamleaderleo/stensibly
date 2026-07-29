import { createHash } from "node:crypto";

export const toolCapabilityActions = [
  "repository.read",
  "branch.create",
  "pull_request.open",
  "artifact.attach",
  "deployment.request",
  "merge.execute",
  "deployment.execute",
  "credential.use",
  "external_message.send",
  "destructive.delete",
  "spend.commit",
] as const;

export type ToolCapabilityAction = typeof toolCapabilityActions[number];

export const toolCapabilityResourceKinds = [
  "github_repository",
  "github_branch_prefix",
  "github_pull_request",
  "stensibly_project",
  "deployment_environment",
  "credential_handle",
  "external_recipient",
  "resource_record",
  "spend_budget",
] as const;

export type ToolCapabilityResourceKind = typeof toolCapabilityResourceKinds[number];
export type ToolCapabilityJsonValue = null | boolean | number | string | ToolCapabilityJsonValue[] | {
  [key: string]: ToolCapabilityJsonValue;
};

export type ToolCapabilityResourceInput =
  | { kind: "github_repository"; owner: string; repository: string }
  | { kind: "github_branch_prefix"; owner: string; repository: string; prefix: string }
  | {
    kind: "github_pull_request";
    owner: string;
    repository: string;
    number: number;
    headSha: string;
  }
  | { kind: "stensibly_project"; workspace: string; project: string }
  | { kind: "deployment_environment"; environment: string; sourceSha: string }
  | { kind: "credential_handle"; handle: string }
  | { kind: "external_recipient"; provider: string; recipientRef: string }
  | { kind: "resource_record"; system: string; resourceType: string; resourceId: string }
  | { kind: "spend_budget"; currency: string; maximumMinorUnits: number };

export interface ToolCapabilityResource {
  kind: ToolCapabilityResourceKind;
  key: string;
}

export interface ToolCapabilityRequestInput {
  workspace: string;
  project: string;
  actorId: string;
  workerSessionId: string;
  runId: string;
  action: ToolCapabilityAction;
  resource: ToolCapabilityResourceInput;
  arguments: unknown;
}

export interface ToolCapabilityRequest {
  version: 1;
  workspace: string;
  project: string;
  actorId: string;
  workerSessionId: string;
  runId: string;
  action: ToolCapabilityAction;
  resource: ToolCapabilityResource;
  arguments: { [key: string]: ToolCapabilityJsonValue };
  argumentsFingerprint: string;
  fingerprint: string;
}

export type ToolCapabilityApprovalInput =
  | {
    state: "pending";
    approvalId: string;
    bindingFingerprint: string;
    expiresAt: string;
  }
  | {
    state: "approved" | "rejected";
    approvalId: string;
    bindingFingerprint: string;
    decidedBy: string;
    decidedAt: string;
    expiresAt: string;
  };

export type ToolCapabilityApproval =
  | {
    state: "not_required";
    approvalId: null;
    bindingFingerprint: null;
    decidedBy: null;
    decidedAt: null;
    expiresAt: null;
  }
  | {
    state: "pending";
    approvalId: string;
    bindingFingerprint: string;
    decidedBy: null;
    decidedAt: null;
    expiresAt: string;
  }
  | {
    state: "approved" | "rejected";
    approvalId: string;
    bindingFingerprint: string;
    decidedBy: string;
    decidedAt: string;
    expiresAt: string;
  };

export interface ToolCapabilityPermissionInput {
  permissionId: string;
  action: ToolCapabilityAction;
  resource: ToolCapabilityResourceInput;
  arguments: unknown;
  maxUses?: number;
  approval?: ToolCapabilityApprovalInput;
}

export interface ToolCapabilityPermission {
  permissionId: string;
  request: ToolCapabilityRequest;
  maxUses: number;
  approval: ToolCapabilityApproval;
}

export interface ToolCapabilityGrantInput {
  grantId: string;
  workspace: string;
  project: string;
  actorId: string;
  workerSessionId: string;
  runId: string;
  generation: number;
  issuedAt: string;
  expiresAt: string;
  issuer: {
    actorId: string;
    authorityRef: string;
  };
  evidenceRefs: readonly string[];
  permissions: readonly ToolCapabilityPermissionInput[];
  revocation?: {
    revokedAt: string;
    revokedBy: string;
    reasonCode: string;
  };
}

export interface ToolCapabilityGrant {
  version: 1;
  grantId: string;
  workspace: string;
  project: string;
  actorId: string;
  workerSessionId: string;
  runId: string;
  generation: number;
  issuedAt: string;
  expiresAt: string;
  issuer: {
    actorId: string;
    authorityRef: string;
  };
  evidenceRefs: string[];
  permissions: ToolCapabilityPermission[];
  revocation: {
    revokedAt: string;
    revokedBy: string;
    reasonCode: string;
  } | null;
  authorizesOnlyExactRequests: true;
  exposesSecretsToModel: false;
  fingerprint: string;
}

export type ToolCapabilityDenialReason =
  | "grant_untrusted"
  | "grant_tampered"
  | "request_invalid"
  | "grant_not_yet_active"
  | "grant_expired"
  | "grant_revoked"
  | "generation_mismatch"
  | "workspace_mismatch"
  | "project_mismatch"
  | "actor_mismatch"
  | "worker_session_mismatch"
  | "run_mismatch"
  | "action_not_allowed"
  | "resource_not_allowed"
  | "arguments_not_allowed"
  | "approval_required"
  | "approval_rejected"
  | "approval_expired"
  | "budget_exhausted";

export type ToolCapabilityAuthorization =
  | {
    authorized: true;
    grantId: string;
    permissionId: string;
    generation: number;
    requestFingerprint: string;
    resourceKey: string;
    approvalId: string | null;
    expiresAt: string;
    consumesUse: true;
    remainingUsesAfterAuthorization: number;
  }
  | {
    authorized: false;
    grantId: string;
    requestFingerprint: string | null;
    reason: ToolCapabilityDenialReason;
  };

export interface AuthorizeToolCapabilityInput {
  now: string;
  trustedGrantFingerprint: string;
  expectedGeneration: number;
  request: ToolCapabilityRequestInput;
  usageByPermission?: Readonly<Record<string, number>>;
}

export type ToolCapabilityGrantState =
  | "active"
  | "not_yet_active"
  | "expired"
  | "revoked"
  | "invalid";

export interface ToolCapabilityGrantProjection {
  version: 1;
  grantId: string | null;
  workspace: string | null;
  project: string | null;
  actorId: string | null;
  workerSessionId: string | null;
  runId: string | null;
  generation: number | null;
  issuedAt: string | null;
  expiresAt: string | null;
  state: ToolCapabilityGrantState;
  issuer: {
    actorId: string;
    authorityRef: string;
  } | null;
  evidenceRefs: string[];
  permissions: Array<{
    permissionId: string;
    action: ToolCapabilityAction;
    resourceKind: ToolCapabilityResourceKind;
    resourceKey: string;
    approvalState: ToolCapabilityApproval["state"];
    approvalId: string | null;
    maxUses: number;
    usedUses: number;
    remainingUses: number;
  }>;
  includesArguments: false;
  includesSecrets: false;
}

const limits = {
  grantId: 160,
  permissionId: 160,
  workspace: 80,
  project: 80,
  actorId: 160,
  workerSessionId: 160,
  runId: 160,
  reference: 240,
  references: 32,
  permissions: 32,
  maxUses: 100,
  grantLifetimeMs: 60 * 60 * 1_000,
  argumentBytes: 16 * 1024,
  argumentNodes: 2_048,
  argumentDepth: 6,
  argumentKeys: 64,
  argumentArray: 64,
  argumentString: 2_048,
  owner: 39,
  repository: 100,
  branchPrefix: 100,
  resourcePart: 160,
} as const;

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const workspacePattern = /^[a-z0-9][a-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const grantPattern = /^grant_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const permissionPattern = /^permission_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const runPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const slugPattern = /^[a-z0-9][a-z0-9._-]*$/;
const githubOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const githubRepositoryPattern = /^[A-Za-z0-9_.-]+$/;
const branchPrefixPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const shaPattern = /^[a-f0-9]{40}$/;
const currencyPattern = /^[A-Z]{3}$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const forbiddenObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const secretKeyPattern = /(secret|password|token|authorization|cookie|private.?key|credential)/iu;
const executableKeyPattern = /(command|shell|script|argv|executable)/iu;
const safeReferenceSuffix = /(ref(?:erence)?|id|name|kind|type|scope|handle)$/iu;
const pathKeyPattern = /(path|file|directory|worktree)$/iu;
const urlKeyPattern = /(url|uri|endpoint)$/iu;
const obviousSecretValuePattern = /^(?:Bearer\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/u;

const expectedResourceKind = {
  "repository.read": "github_repository",
  "branch.create": "github_branch_prefix",
  "pull_request.open": "github_repository",
  "artifact.attach": "stensibly_project",
  "deployment.request": "deployment_environment",
  "merge.execute": "github_pull_request",
  "deployment.execute": "deployment_environment",
  "credential.use": "credential_handle",
  "external_message.send": "external_recipient",
  "destructive.delete": "resource_record",
  "spend.commit": "spend_budget",
} as const satisfies Readonly<Record<ToolCapabilityAction, ToolCapabilityResourceKind>>;

const highImpactActions = new Set<ToolCapabilityAction>([
  "merge.execute",
  "deployment.execute",
  "credential.use",
  "external_message.send",
  "destructive.delete",
  "spend.commit",
]);

interface ArgumentBudget {
  nodes: number;
}

/** Builds one exact, canonical tool-call request. */
export function buildToolCapabilityRequest(
  input: ToolCapabilityRequestInput,
): ToolCapabilityRequest {
  if (!isRecord(input)) throw new RangeError("Tool capability request must be an object");
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const actorId = boundedIdentifier(input.actorId, "Actor ID", limits.actorId);
  const workerSessionId = boundedIdentifier(
    input.workerSessionId,
    "Worker session ID",
    limits.workerSessionId,
  );
  const runId = boundedPrefixedIdentifier(input.runId, "Run ID", runPattern, limits.runId);
  const action = exactEnum(input.action, toolCapabilityActions, "Tool capability action");
  const resource = canonicalResource(action, input.resource);
  const argumentsValue = canonicalArguments(input.arguments);
  validateActionConstraints({
    workspace,
    project,
    action,
    resourceInput: input.resource,
    arguments: argumentsValue,
  });
  const argumentsFingerprint = sha256(stableJson(argumentsValue));
  const canonical = {
    version: 1 as const,
    workspace,
    project,
    actorId,
    workerSessionId,
    runId,
    action,
    resource,
    arguments: argumentsValue,
    argumentsFingerprint,
  };
  return deepFreeze({ ...canonical, fingerprint: sha256(stableJson(canonical)) });
}

/** Builds the exact approval binding for one grant generation and permission. */
export function buildToolCapabilityApprovalBinding(input: {
  grantId: string;
  generation: number;
  permissionId: string;
  request: ToolCapabilityRequestInput;
}): string {
  if (!isRecord(input)) throw new RangeError("Tool capability approval binding must be an object");
  const grantId = boundedPrefixedIdentifier(input.grantId, "Grant ID", grantPattern, limits.grantId);
  const generation = positiveInteger(input.generation, "Grant generation");
  const permissionId = boundedPrefixedIdentifier(
    input.permissionId,
    "Permission ID",
    permissionPattern,
    limits.permissionId,
  );
  const request = buildToolCapabilityRequest(input.request);
  return approvalBindingFingerprint(grantId, generation, permissionId, request.fingerprint);
}

/**
 * Builds one short-lived, generation-fenced grant. Building the grant does not
 * persist it, inject credentials, consume a use, or execute a provider action.
 */
export function buildToolCapabilityGrant(
  input: ToolCapabilityGrantInput,
): ToolCapabilityGrant {
  if (!isRecord(input)) throw new RangeError("Tool capability grant must be an object");
  const grantId = boundedPrefixedIdentifier(input.grantId, "Grant ID", grantPattern, limits.grantId);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const actorId = boundedIdentifier(input.actorId, "Actor ID", limits.actorId);
  const workerSessionId = boundedIdentifier(
    input.workerSessionId,
    "Worker session ID",
    limits.workerSessionId,
  );
  const runId = boundedPrefixedIdentifier(input.runId, "Run ID", runPattern, limits.runId);
  const generation = positiveInteger(input.generation, "Grant generation");
  const issuedAt = canonicalTimestamp(input.issuedAt, "Grant issue time");
  const expiresAt = canonicalTimestamp(input.expiresAt, "Grant expiry");
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= issuedMs) throw new RangeError("Grant expiry must be later than issue time");
  if (expiresMs - issuedMs > limits.grantLifetimeMs) {
    throw new RangeError("Tool capability grant lifetime must not exceed 3600 seconds");
  }

  if (!isRecord(input.issuer)) throw new RangeError("Grant issuer must be an object");
  const issuer = {
    actorId: boundedIdentifier(input.issuer.actorId, "Issuer actor ID", limits.actorId),
    authorityRef: boundedIdentifier(
      input.issuer.authorityRef,
      "Issuer authority reference",
      limits.reference,
    ),
  };
  const evidenceRefs = canonicalReferenceList(input.evidenceRefs, "Evidence");
  if (evidenceRefs.length === 0) {
    throw new RangeError("Tool capability grant requires at least one evidence reference");
  }

  if (
    !Array.isArray(input.permissions)
    || input.permissions.length === 0
    || input.permissions.length > limits.permissions
  ) {
    throw new RangeError(`Tool capability grant must contain 1-${limits.permissions} permissions`);
  }

  const permissionIds = new Set<string>();
  const requestFingerprints = new Set<string>();
  const permissions = input.permissions.map((permissionInput) => {
    if (!isRecord(permissionInput)) throw new RangeError("Tool capability permission must be an object");
    const permissionId = boundedPrefixedIdentifier(
      permissionInput.permissionId,
      "Permission ID",
      permissionPattern,
      limits.permissionId,
    );
    if (permissionIds.has(permissionId)) {
      throw new RangeError(`Duplicate tool capability permission ID: ${permissionId}`);
    }
    permissionIds.add(permissionId);

    const request = buildToolCapabilityRequest({
      workspace,
      project,
      actorId,
      workerSessionId,
      runId,
      action: permissionInput.action,
      resource: permissionInput.resource,
      arguments: permissionInput.arguments,
    });
    if (requestFingerprints.has(request.fingerprint)) {
      throw new RangeError("Duplicate exact tool capability request");
    }
    requestFingerprints.add(request.fingerprint);

    const maxUses = permissionInput.maxUses === undefined
      ? 1
      : boundedInteger(permissionInput.maxUses, "Permission maximum uses", 1, limits.maxUses);
    if (highImpactActions.has(request.action) && maxUses !== 1) {
      throw new RangeError(`High-impact action ${request.action} must be limited to one use`);
    }
    const approval = canonicalApproval(
      grantId,
      generation,
      permissionId,
      request,
      permissionInput.approval,
      issuedAt,
      expiresAt,
    );
    return { permissionId, request, maxUses, approval } satisfies ToolCapabilityPermission;
  }).sort((left, right) => compareUnicodeCodeUnits(left.permissionId, right.permissionId));

  const revocation = input.revocation === undefined
    ? null
    : canonicalRevocation(input.revocation, issuedAt, expiresAt);
  const canonical = {
    version: 1 as const,
    grantId,
    workspace,
    project,
    actorId,
    workerSessionId,
    runId,
    generation,
    issuedAt,
    expiresAt,
    issuer,
    evidenceRefs,
    permissions,
    revocation,
    authorizesOnlyExactRequests: true as const,
    exposesSecretsToModel: false as const,
  };
  return deepFreeze({ ...canonical, fingerprint: sha256(stableJson(canonical)) });
}

/** Evaluates one tool call without mutating grant usage or invoking the tool. */
export function authorizeToolCapability(
  grant: ToolCapabilityGrant,
  input: AuthorizeToolCapabilityInput,
): ToolCapabilityAuthorization {
  if (!validGrantFingerprint(grant)) return denied(grant, null, "grant_tampered");

  let trustedGrantFingerprint: string;
  try {
    trustedGrantFingerprint = boundedFingerprint(
      input.trustedGrantFingerprint,
      "Trusted grant fingerprint",
    );
  } catch {
    return denied(grant, null, "grant_untrusted");
  }
  if (trustedGrantFingerprint !== grant.fingerprint) {
    return denied(grant, null, "grant_untrusted");
  }

  let now: string;
  let expectedGeneration: number;
  let request: ToolCapabilityRequest;
  try {
    now = canonicalTimestamp(input.now, "Authorization time");
    expectedGeneration = positiveInteger(input.expectedGeneration, "Expected grant generation");
    request = buildToolCapabilityRequest(input.request);
  } catch {
    return denied(grant, null, "request_invalid");
  }

  const requestFingerprint = request.fingerprint;
  const state = currentGrantState(grant, now);
  if (state === "not_yet_active") return denied(grant, requestFingerprint, "grant_not_yet_active");
  if (state === "expired") return denied(grant, requestFingerprint, "grant_expired");
  if (state === "revoked") return denied(grant, requestFingerprint, "grant_revoked");
  if (expectedGeneration !== grant.generation) {
    return denied(grant, requestFingerprint, "generation_mismatch");
  }
  if (request.workspace !== grant.workspace) return denied(grant, requestFingerprint, "workspace_mismatch");
  if (request.project !== grant.project) return denied(grant, requestFingerprint, "project_mismatch");
  if (request.actorId !== grant.actorId) return denied(grant, requestFingerprint, "actor_mismatch");
  if (request.workerSessionId !== grant.workerSessionId) {
    return denied(grant, requestFingerprint, "worker_session_mismatch");
  }
  if (request.runId !== grant.runId) return denied(grant, requestFingerprint, "run_mismatch");

  const actionMatches = grant.permissions.filter((permission) =>
    permission.request.action === request.action
  );
  if (actionMatches.length === 0) return denied(grant, requestFingerprint, "action_not_allowed");
  const resourceMatches = actionMatches.filter((permission) =>
    permission.request.resource.key === request.resource.key
  );
  if (resourceMatches.length === 0) return denied(grant, requestFingerprint, "resource_not_allowed");
  const permission = resourceMatches.find((candidate) =>
    candidate.request.fingerprint === requestFingerprint
  );
  if (!permission) return denied(grant, requestFingerprint, "arguments_not_allowed");

  const approval = permission.approval;
  if (approval.state === "pending") {
    const reason = Date.parse(now) >= Date.parse(approval.expiresAt)
      ? "approval_expired"
      : "approval_required";
    return denied(grant, requestFingerprint, reason);
  }
  if (approval.state === "rejected") return denied(grant, requestFingerprint, "approval_rejected");
  if (approval.state === "approved" && Date.parse(now) >= Date.parse(approval.expiresAt)) {
    return denied(grant, requestFingerprint, "approval_expired");
  }

  let usedUses: number;
  try {
    usedUses = permissionUsage(input.usageByPermission, permission.permissionId);
  } catch {
    return denied(grant, requestFingerprint, "request_invalid");
  }
  if (usedUses >= permission.maxUses) {
    return denied(grant, requestFingerprint, "budget_exhausted");
  }

  return {
    authorized: true,
    grantId: grant.grantId,
    permissionId: permission.permissionId,
    generation: grant.generation,
    requestFingerprint,
    resourceKey: request.resource.key,
    approvalId: approval.approvalId,
    expiresAt: grant.expiresAt,
    consumesUse: true,
    remainingUsesAfterAuthorization: permission.maxUses - usedUses - 1,
  };
}

/** Projects grant state without exposing exact arguments or secret material. */
export function projectToolCapabilityGrant(
  grant: ToolCapabilityGrant,
  input: {
    now: string;
    trustedGrantFingerprint: string;
    usageByPermission?: Readonly<Record<string, number>>;
  },
): ToolCapabilityGrantProjection {
  if (!validGrantFingerprint(grant)) return invalidToolCapabilityGrantProjection();

  let now: string;
  try {
    now = canonicalTimestamp(input.now, "Projection time");
    const trusted = boundedFingerprint(
      input.trustedGrantFingerprint,
      "Trusted grant fingerprint",
    ) === grant.fingerprint;
    if (!trusted) return invalidToolCapabilityGrantProjection();
  } catch {
    return invalidToolCapabilityGrantProjection();
  }

  let permissions: ToolCapabilityGrantProjection["permissions"];
  try {
    permissions = grant.permissions.map((permission) => {
      const usedUses = permissionUsage(input.usageByPermission, permission.permissionId);
      return {
        permissionId: permission.permissionId,
        action: permission.request.action,
        resourceKind: permission.request.resource.kind,
        resourceKey: permission.request.resource.key,
        approvalState: permission.approval.state,
        approvalId: permission.approval.approvalId,
        maxUses: permission.maxUses,
        usedUses,
        remainingUses: Math.max(0, permission.maxUses - usedUses),
      };
    });
  } catch {
    return invalidToolCapabilityGrantProjection();
  }

  return {
    version: 1,
    grantId: grant.grantId,
    workspace: grant.workspace,
    project: grant.project,
    actorId: grant.actorId,
    workerSessionId: grant.workerSessionId,
    runId: grant.runId,
    generation: grant.generation,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    state: currentGrantState(grant, now),
    issuer: { ...grant.issuer },
    evidenceRefs: [...grant.evidenceRefs],
    permissions,
    includesArguments: false,
    includesSecrets: false,
  };
}

function invalidToolCapabilityGrantProjection(): ToolCapabilityGrantProjection {
  return {
    version: 1,
    grantId: null,
    workspace: null,
    project: null,
    actorId: null,
    workerSessionId: null,
    runId: null,
    generation: null,
    issuedAt: null,
    expiresAt: null,
    state: "invalid",
    issuer: null,
    evidenceRefs: [],
    permissions: [],
    includesArguments: false,
    includesSecrets: false,
  };
}

function canonicalResource(
  action: ToolCapabilityAction,
  input: ToolCapabilityResourceInput,
): ToolCapabilityResource {
  if (!isRecord(input)) throw new RangeError("Tool capability resource must be an object");
  const kind = exactEnum(input.kind, toolCapabilityResourceKinds, "Tool capability resource kind");
  if (kind !== expectedResourceKind[action]) {
    throw new RangeError(`Action ${action} requires resource kind ${expectedResourceKind[action]}`);
  }

  switch (input.kind) {
    case "github_repository": {
      const owner = boundedGitHubOwner(input.owner);
      const repository = boundedGitHubRepository(input.repository);
      return { kind: input.kind, key: `github:repository:${owner}/${repository}` };
    }
    case "github_branch_prefix": {
      const owner = boundedGitHubOwner(input.owner);
      const repository = boundedGitHubRepository(input.repository);
      const prefix = boundedBranchPrefix(input.prefix);
      return { kind: input.kind, key: `github:branch-prefix:${owner}/${repository}:${prefix}` };
    }
    case "github_pull_request": {
      const owner = boundedGitHubOwner(input.owner);
      const repository = boundedGitHubRepository(input.repository);
      const number = positiveInteger(input.number, "Pull request number");
      const headSha = boundedSha(input.headSha, "Pull request head SHA");
      return { kind: input.kind, key: `github:pull-request:${owner}/${repository}#${number}@${headSha}` };
    }
    case "stensibly_project": {
      const workspace = boundedWorkspace(input.workspace, "Resource workspace");
      const project = boundedWorkspace(input.project, "Resource project");
      return { kind: input.kind, key: `stensibly:project:${workspace}/${project}` };
    }
    case "deployment_environment": {
      const environment = boundedSlug(input.environment, "Deployment environment", limits.resourcePart);
      const sourceSha = boundedSha(input.sourceSha, "Deployment source SHA");
      return { kind: input.kind, key: `deployment:environment:${environment}@${sourceSha}` };
    }
    case "credential_handle": {
      const handle = boundedIdentifier(input.handle, "Credential handle", limits.resourcePart);
      return { kind: input.kind, key: `credential:handle:${handle}` };
    }
    case "external_recipient": {
      const provider = boundedSlug(input.provider, "Recipient provider", limits.resourcePart);
      const recipientRef = boundedIdentifier(
        input.recipientRef,
        "Recipient reference",
        limits.resourcePart,
      );
      return { kind: input.kind, key: `external:recipient:${provider}:${recipientRef}` };
    }
    case "resource_record": {
      const system = boundedSlug(input.system, "Resource system", limits.resourcePart);
      const resourceType = boundedSlug(input.resourceType, "Resource type", limits.resourcePart);
      const resourceId = boundedIdentifier(input.resourceId, "Resource ID", limits.resourcePart);
      return { kind: input.kind, key: `resource:${system}:${resourceType}:${resourceId}` };
    }
    case "spend_budget": {
      const currency = boundedCurrency(input.currency);
      const maximumMinorUnits = positiveInteger(
        input.maximumMinorUnits,
        "Maximum spend minor units",
      );
      return { kind: input.kind, key: `spend:${currency}:${maximumMinorUnits}` };
    }
  }
}

function validateActionConstraints(input: {
  workspace: string;
  project: string;
  action: ToolCapabilityAction;
  resourceInput: ToolCapabilityResourceInput;
  arguments: { [key: string]: ToolCapabilityJsonValue };
}): void {
  switch (input.action) {
    case "branch.create": {
      if (input.resourceInput.kind !== "github_branch_prefix") {
        throw new RangeError("Branch creation requires a branch-prefix resource");
      }
      const prefix = boundedBranchPrefix(input.resourceInput.prefix);
      const branchName = boundedBranchName(
        requiredArgumentString(input.arguments, "branchName", "Branch name"),
      );
      if (branchName === prefix || !branchName.startsWith(prefix)) {
        throw new RangeError("Branch name must be inside the authorized branch prefix");
      }
      boundedSha(
        requiredArgumentString(input.arguments, "baseSha", "Branch base SHA"),
        "Branch base SHA",
      );
      return;
    }
    case "artifact.attach": {
      if (input.resourceInput.kind !== "stensibly_project") {
        throw new RangeError("Artifact attachment requires a Stensibly project resource");
      }
      const resourceWorkspace = boundedWorkspace(input.resourceInput.workspace, "Resource workspace");
      const resourceProject = boundedWorkspace(input.resourceInput.project, "Resource project");
      if (resourceWorkspace !== input.workspace || resourceProject !== input.project) {
        throw new RangeError("Artifact attachment resource must match the request project scope");
      }
      return;
    }
    case "merge.execute": {
      if (input.resourceInput.kind !== "github_pull_request") {
        throw new RangeError("Merge execution requires an exact pull-request resource");
      }
      const expectedHeadSha = boundedSha(
        requiredArgumentString(input.arguments, "expectedHeadSha", "Expected pull-request head SHA"),
        "Expected pull-request head SHA",
      );
      if (expectedHeadSha !== boundedSha(input.resourceInput.headSha, "Pull request head SHA")) {
        throw new RangeError("Merge arguments must preserve the authorized pull-request head SHA");
      }
      const mergeMethod = requiredArgumentString(input.arguments, "mergeMethod", "Merge method");
      exactEnum(mergeMethod, ["merge", "squash", "rebase"] as const, "Merge method");
      return;
    }
    case "spend.commit": {
      if (input.resourceInput.kind !== "spend_budget") {
        throw new RangeError("Spend commitment requires a spend-budget resource");
      }
      const currency = boundedCurrency(
        requiredArgumentString(input.arguments, "currency", "Spend currency"),
      );
      const maximumMinorUnits = positiveInteger(
        input.resourceInput.maximumMinorUnits,
        "Maximum spend minor units",
      );
      const amountMinorUnits = requiredArgumentInteger(
        input.arguments,
        "amountMinorUnits",
        "Spend amount minor units",
      );
      if (currency !== boundedCurrency(input.resourceInput.currency)) {
        throw new RangeError("Spend arguments must use the authorized currency");
      }
      if (amountMinorUnits > maximumMinorUnits) {
        throw new RangeError("Spend amount exceeds the authorized budget");
      }
      return;
    }
    default:
      return;
  }
}

function requiredArgumentString(
  argumentsValue: { [key: string]: ToolCapabilityJsonValue },
  key: string,
  label: string,
): string {
  const value = argumentsValue[key];
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  return value;
}

function requiredArgumentInteger(
  argumentsValue: { [key: string]: ToolCapabilityJsonValue },
  key: string,
  label: string,
): number {
  const value = argumentsValue[key];
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function approvalBindingFingerprint(
  grantId: string,
  generation: number,
  permissionId: string,
  requestFingerprint: string,
): string {
  return sha256(stableJson({
    version: 1,
    grantId,
    generation,
    permissionId,
    requestFingerprint,
  }));
}

function canonicalApproval(
  grantId: string,
  generation: number,
  permissionId: string,
  request: ToolCapabilityRequest,
  input: ToolCapabilityApprovalInput | undefined,
  issuedAt: string,
  grantExpiresAt: string,
): ToolCapabilityApproval {
  const requiresApproval = highImpactActions.has(request.action);
  if (!requiresApproval) {
    if (input !== undefined) {
      throw new RangeError(`Action ${request.action} does not accept a human approval decoration`);
    }
    return {
      state: "not_required",
      approvalId: null,
      bindingFingerprint: null,
      decidedBy: null,
      decidedAt: null,
      expiresAt: null,
    };
  }
  if (!isRecord(input)) throw new RangeError(`Action ${request.action} requires human approval state`);
  if (input.state !== "pending" && input.state !== "approved" && input.state !== "rejected") {
    throw new RangeError("Unknown tool capability approval state");
  }
  const approvalId = boundedIdentifier(input.approvalId, "Approval ID", limits.reference);
  const bindingFingerprint = boundedFingerprint(input.bindingFingerprint, "Approval binding fingerprint");
  const expectedBinding = approvalBindingFingerprint(
    grantId,
    generation,
    permissionId,
    request.fingerprint,
  );
  if (bindingFingerprint !== expectedBinding) {
    throw new RangeError(
      "Human approval must bind the exact grant generation, permission, and request",
    );
  }
  const expiresAt = canonicalTimestamp(input.expiresAt, "Approval expiry");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new RangeError("Approval expiry must be later than grant issue time");
  }
  if (Date.parse(expiresAt) > Date.parse(grantExpiresAt)) {
    throw new RangeError("Approval expiry must not outlive the tool capability grant");
  }
  if (input.state === "pending") {
    return {
      state: "pending",
      approvalId,
      bindingFingerprint,
      decidedBy: null,
      decidedAt: null,
      expiresAt,
    };
  }
  const decidedBy = boundedIdentifier(input.decidedBy, "Approval decider ID", limits.actorId);
  const decidedAt = canonicalTimestamp(input.decidedAt, "Approval decision time");
  if (Date.parse(decidedAt) < Date.parse(issuedAt) || Date.parse(decidedAt) > Date.parse(expiresAt)) {
    throw new RangeError("Approval decision time must fall within the approval lifetime");
  }
  return {
    state: input.state,
    approvalId,
    bindingFingerprint,
    decidedBy,
    decidedAt,
    expiresAt,
  };
}

function canonicalRevocation(
  input: NonNullable<ToolCapabilityGrantInput["revocation"]>,
  issuedAt: string,
  expiresAt: string,
): NonNullable<ToolCapabilityGrant["revocation"]> {
  if (!isRecord(input)) throw new RangeError("Grant revocation must be an object");
  const revokedAt = canonicalTimestamp(input.revokedAt, "Grant revocation time");
  if (Date.parse(revokedAt) < Date.parse(issuedAt) || Date.parse(revokedAt) > Date.parse(expiresAt)) {
    throw new RangeError("Grant revocation time must fall within the grant lifetime");
  }
  return {
    revokedAt,
    revokedBy: boundedIdentifier(input.revokedBy, "Revoking actor ID", limits.actorId),
    reasonCode: boundedSlug(input.reasonCode, "Revocation reason code", limits.resourcePart),
  };
}

function canonicalArguments(value: unknown): { [key: string]: ToolCapabilityJsonValue } {
  const budget: ArgumentBudget = { nodes: 0 };
  const canonical = canonicalJson(value, "arguments", null, 0, new Set<object>(), budget);
  if (Array.isArray(canonical) || !isRecord(canonical)) {
    throw new RangeError("Tool capability arguments must be a JSON object");
  }
  const json = stableJson(canonical);
  if (Buffer.byteLength(json, "utf8") > limits.argumentBytes) {
    throw new RangeError(`Tool capability arguments must be at most ${limits.argumentBytes} bytes`);
  }
  return canonical as { [key: string]: ToolCapabilityJsonValue };
}

function canonicalJson(
  value: unknown,
  path: string,
  key: string | null,
  depth: number,
  seen: Set<object>,
  budget: ArgumentBudget,
): ToolCapabilityJsonValue {
  if (depth > limits.argumentDepth) {
    throw new RangeError(`Tool capability ${path} exceeds the maximum depth`);
  }
  budget.nodes += 1;
  if (budget.nodes > limits.argumentNodes) {
    throw new RangeError("Tool capability arguments contain too many values");
  }

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`Tool capability ${path} must be finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") return canonicalArgumentString(value, path, key);
  if (typeof value !== "object" || value === null) {
    throw new RangeError(`Tool capability ${path} must contain JSON values only`);
  }
  if (seen.has(value)) throw new RangeError(`Tool capability ${path} must not contain cycles`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > limits.argumentArray) {
        throw new RangeError(`Tool capability ${path} array is too large`);
      }
      return value.map((entry, index) =>
        canonicalJson(entry, `${path}[${index}]`, key, depth + 1, seen, budget)
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RangeError(`Tool capability ${path} must be a plain object`);
    }
    const entries = Object.entries(value);
    if (entries.length > limits.argumentKeys) {
      throw new RangeError(`Tool capability ${path} has too many keys`);
    }
    const result: { [key: string]: ToolCapabilityJsonValue } = {};
    for (const [entryKey, entryValue] of entries.sort(([left], [right]) => compareUnicodeCodeUnits(left, right))) {
      boundedArgumentKey(entryKey, path);
      if (forbiddenObjectKeys.has(entryKey)) {
        throw new RangeError(`Tool capability ${path} contains a forbidden key`);
      }
      const normalizedKey = entryKey.replace(/[^A-Za-z0-9]/g, "");
      if (
        (secretKeyPattern.test(normalizedKey) || executableKeyPattern.test(normalizedKey))
        && !safeReferenceSuffix.test(normalizedKey)
      ) {
        throw new RangeError(`Tool capability ${path}.${entryKey} must use an opaque reference`);
      }
      result[entryKey] = canonicalJson(
        entryValue,
        `${path}.${entryKey}`,
        entryKey,
        depth + 1,
        seen,
        budget,
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalArgumentString(value: string, path: string, key: string | null): string {
  assertSafeText(value, `Tool capability ${path}`);
  const normalized = value.normalize("NFKC");
  if ([...normalized].length > limits.argumentString) {
    throw new RangeError(`Tool capability ${path} must be at most ${limits.argumentString} characters`);
  }
  if (obviousSecretValuePattern.test(normalized)) {
    throw new RangeError(`Tool capability ${path} must use an opaque secret handle`);
  }
  const normalizedKey = key?.replace(/[^A-Za-z0-9]/g, "") ?? "";
  if (pathKeyPattern.test(normalizedKey)) validateRelativePath(normalized, path);
  if (urlKeyPattern.test(normalizedKey)) validateHttpsUrl(normalized, path);
  return normalized;
}

function validateRelativePath(value: string, path: string): void {
  if (
    value.startsWith("/")
    || value.startsWith("\\")
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes("\\")
    || value.split("/").includes("..")
  ) {
    throw new RangeError(`Tool capability ${path} must be a relative traversal-free path`);
  }
}

function validateHttpsUrl(value: string, path: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError(`Tool capability ${path} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new RangeError(`Tool capability ${path} must be a credential-free HTTPS URL without query or fragment`);
  }
}

function currentGrantState(
  grant: ToolCapabilityGrant,
  now: string,
): Exclude<ToolCapabilityGrantState, "invalid"> {
  const nowMs = Date.parse(now);
  if (nowMs < Date.parse(grant.issuedAt)) return "not_yet_active";
  if (grant.revocation && nowMs >= Date.parse(grant.revocation.revokedAt)) return "revoked";
  if (nowMs >= Date.parse(grant.expiresAt)) return "expired";
  return "active";
}

function validGrantFingerprint(grant: ToolCapabilityGrant): boolean {
  try {
    const { fingerprint, ...canonical } = grant;
    return boundedFingerprint(fingerprint, "Grant fingerprint") === sha256(stableJson(canonical));
  } catch {
    return false;
  }
}

function permissionUsage(
  usageByPermission: Readonly<Record<string, number>> | undefined,
  permissionId: string,
): number {
  const value = usageByPermission?.[permissionId] ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Tool capability usage must be a non-negative safe integer");
  }
  return value;
}

function denied(
  grant: Pick<ToolCapabilityGrant, "grantId">,
  requestFingerprint: string | null,
  reason: ToolCapabilityDenialReason,
): ToolCapabilityAuthorization {
  return {
    authorized: false,
    grantId: typeof grant?.grantId === "string" ? grant.grantId : "invalid",
    requestFingerprint,
    reason,
  };
}

function canonicalReferenceList(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.length > limits.references) {
    throw new RangeError(`${label} references must contain at most ${limits.references} entries`);
  }
  const result = values.map((value) =>
    boundedIdentifier(value, `${label} reference`, limits.reference)
  );
  if (new Set(result).size !== result.length) {
    throw new RangeError(`${label} references must be unique`);
  }
  return result.sort(compareUnicodeCodeUnits);
}

function boundedWorkspace(value: string, label: string): string {
  return boundedPattern(value, label, limits.workspace, workspacePattern).toLowerCase();
}

function boundedIdentifier(value: string, label: string, maximum: number): string {
  return boundedPattern(value, label, maximum, identifierPattern);
}

function boundedPrefixedIdentifier(
  value: string,
  label: string,
  pattern: RegExp,
  maximum: number,
): string {
  return boundedPattern(value, label, maximum, pattern);
}

function boundedSlug(value: string, label: string, maximum: number): string {
  return boundedPattern(value, label, maximum, slugPattern).toLowerCase();
}

function boundedPattern(value: string, label: string, maximum: number, pattern: RegExp): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  assertSafeText(value, label);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || [...normalized].length > maximum || !pattern.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function boundedGitHubOwner(value: string): string {
  const owner = boundedPattern(value, "GitHub owner", limits.owner, githubOwnerPattern);
  if (owner.includes("--")) throw new RangeError("GitHub owner is invalid");
  return owner.toLowerCase();
}

function boundedGitHubRepository(value: string): string {
  const repository = boundedPattern(
    value,
    "GitHub repository",
    limits.repository,
    githubRepositoryPattern,
  );
  if (repository === "." || repository === ".." || repository.includes("..")) {
    throw new RangeError("GitHub repository is invalid");
  }
  return repository.toLowerCase();
}

function boundedBranchPrefix(value: string): string {
  const prefix = boundedPattern(value, "GitHub branch prefix", limits.branchPrefix, branchPrefixPattern);
  if (
    prefix.startsWith("/")
    || prefix.includes("//")
    || prefix.split("/").includes("..")
    || prefix.endsWith(".")
  ) {
    throw new RangeError("GitHub branch prefix is invalid");
  }
  return prefix;
}

function boundedBranchName(value: string): string {
  const branch = boundedPattern(
    value,
    "GitHub branch name",
    limits.branchPrefix,
    branchPrefixPattern,
  );
  if (
    branch.startsWith("/")
    || branch.endsWith("/")
    || branch.includes("//")
    || branch.includes("..")
    || branch.includes("@{")
    || branch.split("/").some((part) => !part || part === "." || part.endsWith(".lock"))
    || branch.endsWith(".")
  ) {
    throw new RangeError("GitHub branch name is invalid");
  }
  return branch;
}

function boundedSha(value: string, label: string): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  const normalized = value.trim().toLowerCase();
  if (!shaPattern.test(normalized)) throw new RangeError(`${label} must be a full 40-character SHA`);
  return normalized;
}

function boundedCurrency(value: string): string {
  if (typeof value !== "string") throw new RangeError("Spend currency must be a string");
  const normalized = value.trim().toUpperCase();
  if (!currencyPattern.test(normalized)) throw new RangeError("Spend currency must be an ISO-style code");
  return normalized;
}

function boundedArgumentKey(value: string, path: string): string {
  assertSafeText(value, `Tool capability ${path} key`);
  if (!value || [...value].length > 80) throw new RangeError(`Tool capability ${path} key is invalid`);
  return value;
}

function boundedFingerprint(value: string, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function canonicalTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new RangeError(`${label} must be an ISO UTC timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function exactEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function assertSafeText(value: string, label: string): void {
  if (unsafeTextPattern.test(value)) throw new RangeError(`${label} contains unsafe characters`);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Version 1 canonical ordering uses direct UTF-16 code-unit comparison. */
function compareUnicodeCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Canonical JSON number must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (!isRecord(value)) throw new RangeError("Canonical JSON value is invalid");
  const entries = Object.keys(value).sort(compareUnicodeCodeUnits);
  return `{${entries.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
