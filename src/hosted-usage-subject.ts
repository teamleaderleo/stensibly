import type { AccountUsageSubject } from "./account-usage-reservation.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import type { HostedSessionContext } from "./hosted-account-service.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  principalAuthorizationId,
  type TokenPrincipal,
} from "./token-contracts.js";

export const HOSTED_USAGE_SUBJECT_VERSION = 1 as const;

export type HostedUsageSubjectSource =
  | "hosted_session_account"
  | "oauth_account"
  | "authorization";

export interface HostedUsageSubjectResolution {
  version: typeof HOSTED_USAGE_SUBJECT_VERSION;
  source: HostedUsageSubjectSource;
  subject: AccountUsageSubject;
  subjectFingerprint: string;
  grantsAuthority: false;
}

const boundedIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const accountIdPattern = /^acct_[A-Za-z0-9_-]+$/u;
const workspacePattern = /^[a-z0-9][a-z0-9-_]*$/u;

/**
 * Resolve one authenticated hosted browser session to the stable account
 * identity used by product-usage accounting. The configured workspace is
 * checked independently from session/account data so stale or cross-workspace
 * context cannot silently select another allowance owner.
 */
export function resolveHostedSessionUsageSubject(
  context: HostedSessionContext,
  workspaceInput: string,
): HostedUsageSubjectResolution {
  const workspace = exactWorkspace(workspaceInput);
  if (!isRecord(context)) {
    throw new TypeError("hosted session context is invalid");
  }
  if (!isRecord(context.account) || !isRecord(context.membership) || !isRecord(context.principal)) {
    throw new TypeError("hosted session context is invalid");
  }
  if (context.principal.type !== "account") {
    throw new Error("hosted session principal kind is invalid");
  }
  if (context.account.disabledAt !== null || context.membership.revokedAt !== null) {
    throw new Error("hosted session account is unavailable for usage accounting");
  }

  const accountId = exactAccountId(context.account.id);
  const principalAccountId = exactAccountId(context.principal.accountId);
  const membershipWorkspace = exactWorkspace(context.membership.workspace);
  const principalWorkspace = exactWorkspace(context.principal.workspace);
  if (
    principalAccountId !== accountId
    || membershipWorkspace !== workspace
    || principalWorkspace !== workspace
  ) {
    throw new Error("hosted session usage identity does not match its workspace/account context");
  }

  return resolution("hosted_session_account", {
    kind: "account",
    id: accountId,
    workspace,
  });
}

/**
 * Resolve an authenticated bearer/MCP principal to a product-usage owner.
 * Verified OAuth principals use the hosted account identity, so rotating an
 * access token or reconnecting the same account does not mint fresh allowance.
 * Other credentials use the stable authorization identity, falling back to the
 * token identity only when the authenticator has no broader service-principal
 * identity to provide.
 */
export function resolveTokenUsageSubject(
  principal: TokenPrincipal,
  workspaceInput: string,
): HostedUsageSubjectResolution {
  const workspace = exactWorkspace(workspaceInput);
  if (!isRecord(principal)) {
    throw new TypeError("token principal is invalid");
  }

  if (principal.oauthAccountId !== undefined) {
    return resolution("oauth_account", {
      kind: "account",
      id: exactAccountId(principal.oauthAccountId),
      workspace,
    });
  }

  const authorizationId = exactStableIdentity(
    principalAuthorizationId(principal),
    "authorization identity",
    240,
  );
  return resolution("authorization", {
    kind: "authorization",
    id: authorizationId,
    workspace,
  });
}

function resolution(
  source: HostedUsageSubjectSource,
  subject: AccountUsageSubject,
): HostedUsageSubjectResolution {
  const frozenSubject = Object.freeze({ ...subject });
  const subjectFingerprint = fingerprintCanonicalRequest({
    version: HOSTED_USAGE_SUBJECT_VERSION,
    operation: "account_usage.subject",
    subject: frozenSubject,
  });
  return Object.freeze({
    version: HOSTED_USAGE_SUBJECT_VERSION,
    source,
    subject: frozenSubject,
    subjectFingerprint,
    grantsAuthority: false as const,
  });
}

function exactWorkspace(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 80
    || value.trim() !== value
    || value !== value.toLowerCase()
    || !workspacePattern.test(value)
  ) {
    throw new TypeError("workspace is invalid");
  }
  return value;
}

function exactAccountId(value: unknown): string {
  const id = exactStableIdentity(value, "account identity", 160);
  if (!accountIdPattern.test(id)) {
    throw new TypeError("account identity is invalid");
  }
  return id;
}

function exactStableIdentity(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || !boundedIdentityPattern.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new TypeError(`${field} cannot retain credential-like text`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
