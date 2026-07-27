import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

export const providerMembershipAuditFunctionName =
  "providerMembershipAudit:auditProviderMembership";
export const providerMembershipAuditFailure = "provider_membership_audit_failed";

const auditFunction = makeFunctionReference<"query">(
  providerMembershipAuditFunctionName,
);

const auditStatuses = [
  "identity_absent",
  "workspace_conflict",
  "identity_conflict",
  "account_missing",
  "account_disabled",
  "workspace_absent",
  "membership_absent",
  "membership_conflict",
  "membership_active",
  "membership_revoked",
  "membership_uninspectable",
] as const;

const accountRoles = ["owner", "admin", "member", "viewer"] as const;
const projectScopes = ["all", "bounded", "uninspectable"] as const;
const revocationStates = ["active", "revoked", "uninspectable"] as const;

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const slugPattern = /^[a-z0-9][a-z0-9_-]*$/;
const convexHostPattern = /^[a-z0-9-]+\.convex\.cloud$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const secretFlagPattern = /^--[^=]*(?:secret|token|credential|key)(?:=|$)/i;

const maximumProjectCount = 100;
const maximumProjectLength = 80;

export type ProviderMembershipAuditStatus = typeof auditStatuses[number];
export type ProviderMembershipAuditRole = typeof accountRoles[number];
export type ProviderMembershipAuditProjectScope = typeof projectScopes[number];
export type ProviderMembershipAuditRevocationState = typeof revocationStates[number];

export interface ProviderMembershipAuditCliOptions {
  workspace: string;
  provider: string;
  subject: string;
}

export interface ProviderMembershipAuditArguments
  extends ProviderMembershipAuditCliOptions {
  serviceSecret: string;
}

export interface ProviderMembershipAuditMembership {
  role: ProviderMembershipAuditRole;
  projectScope: ProviderMembershipAuditProjectScope;
  projects: string[] | null;
  projectCount: number;
  revocationState: ProviderMembershipAuditRevocationState;
  revokedAt: string | null;
}

export interface ProviderMembershipAuditResult {
  version: 1;
  workspace: string;
  provider: string;
  status: ProviderMembershipAuditStatus;
  membership: ProviderMembershipAuditMembership | null;
  cleanBootstrapEligible: boolean;
  requiresSeparateMembershipPlan: boolean;
  containsSecrets: false;
  readOnly: true;
  grantsMembershipChange: false;
  grantsMembership: false;
  grantsLogin: false;
  grantsOAuthEnablement: false;
}

export type ProviderMembershipAuditInvoker = (
  deploymentUrl: string,
  args: ProviderMembershipAuditArguments,
) => Promise<unknown>;

export interface ProviderMembershipAuditCliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

const defaultIo: ProviderMembershipAuditCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export function parseProviderMembershipAuditArgs(
  rawArgs: string[],
): ProviderMembershipAuditCliOptions {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
  const seen = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) throw new Error("Provider membership audit arguments are invalid");
    if (secretFlagPattern.test(argument)) {
      throw new Error("Sensitive provider membership audit values must use environment variables");
    }
    if (argument !== "--workspace" && argument !== "--provider" && argument !== "--subject") {
      throw new Error("Provider membership audit argument is unsupported");
    }
    if (seen.has(argument)) {
      throw new Error("Provider membership audit argument is duplicated");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("Provider membership audit argument requires a value");
    }
    seen.add(argument);
    values.set(argument, value);
    index += 1;
  }

  if (seen.size !== 3) {
    throw new Error("Provider membership audit requires workspace, provider, and subject");
  }

  return {
    workspace: normalizeSlug(values.get("--workspace"), "Workspace", 80),
    provider: normalizeSlug(values.get("--provider"), "Provider", 40),
    subject: normalizeSubject(values.get("--subject")),
  };
}

export async function runProviderMembershipAudit(
  options: ProviderMembershipAuditCliOptions,
  env: Record<string, string | undefined> = process.env,
  invoke: ProviderMembershipAuditInvoker = invokeProviderMembershipAudit,
): Promise<ProviderMembershipAuditResult> {
  const deploymentUrl = normalizeConvexDeploymentUrl(env.CONVEX_URL);
  const serviceSecret = readServiceSecret(env.STENSIBLY_SERVICE_SECRET);
  const requested = {
    workspace: normalizeSlug(options.workspace, "Workspace", 80),
    provider: normalizeSlug(options.provider, "Provider", 40),
    subject: normalizeSubject(options.subject),
  };
  const raw = await invoke(deploymentUrl, {
    serviceSecret,
    ...requested,
  });
  return validateAuditResult(raw, requested);
}

export async function executeProviderMembershipAuditCli(
  rawArgs: string[],
  env: Record<string, string | undefined> = process.env,
  io: ProviderMembershipAuditCliIo = defaultIo,
  invoke: ProviderMembershipAuditInvoker = invokeProviderMembershipAudit,
): Promise<number> {
  try {
    const options = parseProviderMembershipAuditArgs(rawArgs);
    const result = await runProviderMembershipAudit(options, env, invoke);
    io.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    io.stderr(`${providerMembershipAuditFailure}\n`);
    return 1;
  }
}

async function invokeProviderMembershipAudit(
  deploymentUrl: string,
  args: ProviderMembershipAuditArguments,
): Promise<unknown> {
  const client = new ConvexHttpClient(deploymentUrl, { logger: false });
  return await client.query(auditFunction, args);
}

function validateAuditResult(
  value: unknown,
  requested: ProviderMembershipAuditCliOptions,
): ProviderMembershipAuditResult {
  const record = exactObject(value, [
    "version",
    "workspace",
    "provider",
    "status",
    "membership",
    "cleanBootstrapEligible",
    "requiresSeparateMembershipPlan",
    "containsSecrets",
    "readOnly",
    "grantsMembershipChange",
    "grantsMembership",
    "grantsLogin",
    "grantsOAuthEnablement",
  ]);

  if (record.version !== 1) throw new Error("Provider membership audit version is invalid");
  if (record.workspace !== requested.workspace || record.provider !== requested.provider) {
    throw new Error("Provider membership audit target is invalid");
  }
  if (!auditStatuses.includes(record.status as ProviderMembershipAuditStatus)) {
    throw new Error("Provider membership audit status is invalid");
  }
  const status = record.status as ProviderMembershipAuditStatus;
  const cleanBootstrapEligible = status === "identity_absent";
  if (
    record.cleanBootstrapEligible !== cleanBootstrapEligible
    || record.requiresSeparateMembershipPlan !== !cleanBootstrapEligible
  ) {
    throw new Error("Provider membership audit decision is invalid");
  }
  if (
    record.containsSecrets !== false
    || record.readOnly !== true
    || record.grantsMembershipChange !== false
    || record.grantsMembership !== false
    || record.grantsLogin !== false
    || record.grantsOAuthEnablement !== false
  ) {
    throw new Error("Provider membership audit authority boundary is invalid");
  }

  const membership = validateMembership(record.membership, status);
  return {
    version: 1,
    workspace: requested.workspace,
    provider: requested.provider,
    status,
    membership,
    cleanBootstrapEligible,
    requiresSeparateMembershipPlan: !cleanBootstrapEligible,
    containsSecrets: false,
    readOnly: true,
    grantsMembershipChange: false,
    grantsMembership: false,
    grantsLogin: false,
    grantsOAuthEnablement: false,
  };
}

function validateMembership(
  value: unknown,
  status: ProviderMembershipAuditStatus,
): ProviderMembershipAuditMembership | null {
  const membershipStatuses = new Set<ProviderMembershipAuditStatus>([
    "membership_active",
    "membership_revoked",
    "membership_uninspectable",
  ]);
  if (!membershipStatuses.has(status)) {
    if (value !== null) throw new Error("Provider membership audit detail is unexpected");
    return null;
  }

  const record = exactObject(value, [
    "role",
    "projectScope",
    "projects",
    "projectCount",
    "revocationState",
    "revokedAt",
  ]);
  if (!accountRoles.includes(record.role as ProviderMembershipAuditRole)) {
    throw new Error("Provider membership audit role is invalid");
  }
  if (!projectScopes.includes(record.projectScope as ProviderMembershipAuditProjectScope)) {
    throw new Error("Provider membership audit project scope is invalid");
  }
  if (!revocationStates.includes(record.revocationState as ProviderMembershipAuditRevocationState)) {
    throw new Error("Provider membership audit revocation state is invalid");
  }
  if (!Number.isInteger(record.projectCount) || (record.projectCount as number) < 0) {
    throw new Error("Provider membership audit project count is invalid");
  }

  const role = record.role as ProviderMembershipAuditRole;
  const projectScope = record.projectScope as ProviderMembershipAuditProjectScope;
  const projectCount = record.projectCount as number;
  const revocationState = record.revocationState as ProviderMembershipAuditRevocationState;
  const projects = validateProjects(record.projects, projectScope, projectCount);
  const revokedAt = validateRevocation(record.revokedAt, revocationState);

  if (
    status === "membership_active"
    && (projectScope === "uninspectable" || revocationState !== "active")
  ) {
    throw new Error("Provider membership audit active state is invalid");
  }
  if (
    status === "membership_revoked"
    && (projectScope === "uninspectable" || revocationState !== "revoked")
  ) {
    throw new Error("Provider membership audit revoked state is invalid");
  }
  if (
    status === "membership_uninspectable"
    && projectScope !== "uninspectable"
    && revocationState !== "uninspectable"
  ) {
    throw new Error("Provider membership audit uninspectable state is invalid");
  }

  return {
    role,
    projectScope,
    projects,
    projectCount,
    revocationState,
    revokedAt,
  };
}

function validateProjects(
  value: unknown,
  scope: ProviderMembershipAuditProjectScope,
  count: number,
): string[] | null {
  if (scope === "all") {
    if (value !== null || count !== 0) {
      throw new Error("Provider membership audit workspace scope is invalid");
    }
    return null;
  }
  if (scope === "uninspectable") {
    if (value !== null) {
      throw new Error("Provider membership audit uninspectable projects are invalid");
    }
    return null;
  }
  if (!Array.isArray(value) || value.length !== count || count > maximumProjectCount) {
    throw new Error("Provider membership audit bounded projects are invalid");
  }
  const projects: string[] = [];
  for (const project of value) {
    if (
      typeof project !== "string"
      || project.length > maximumProjectLength
      || !slugPattern.test(project)
    ) {
      throw new Error("Provider membership audit project is invalid");
    }
    projects.push(project);
  }
  const canonical = [...new Set(projects)].sort(compareCodePoints);
  if (
    canonical.length !== projects.length
    || canonical.some((project, index) => project !== projects[index])
  ) {
    throw new Error("Provider membership audit projects are noncanonical");
  }
  return canonical;
}

function validateRevocation(
  value: unknown,
  state: ProviderMembershipAuditRevocationState,
): string | null {
  if (state === "active" || state === "uninspectable") {
    if (value !== null) throw new Error("Provider membership audit revocation time is invalid");
    return null;
  }
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new Error("Provider membership audit revocation time is invalid");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("Provider membership audit revocation time is invalid");
  }
  return value;
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider membership audit result is invalid");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(compareCodePoints);
  const expected = [...keys].sort(compareCodePoints);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Provider membership audit result fields are invalid");
  }
  return record;
}

function normalizeConvexDeploymentUrl(value: string | undefined): string {
  if (!value || value.length > 2048 || unsafeTextPattern.test(value)) {
    throw new Error("CONVEX_URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("CONVEX_URL is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
    || parsed.port
    || !convexHostPattern.test(parsed.hostname)
  ) {
    throw new Error("CONVEX_URL must be an exact Convex Cloud origin");
  }
  return parsed.origin;
}

function readServiceSecret(value: string | undefined): string {
  if (
    !value
    || value.length < 16
    || value.length > 4096
    || unsafeTextPattern.test(value)
  ) {
    throw new Error("STENSIBLY_SERVICE_SECRET is invalid");
  }
  return value;
}

function normalizeSlug(value: string | undefined, label: string, maximum: number): string {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const normalized = value.trim().toLowerCase();
  if (!slugPattern.test(normalized) || normalized.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function normalizeSubject(value: string | undefined): string {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new Error("Provider subject is invalid");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new Error("Provider subject is invalid");
  }
  return normalized;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await executeProviderMembershipAuditCli(Bun.argv.slice(2));
}
