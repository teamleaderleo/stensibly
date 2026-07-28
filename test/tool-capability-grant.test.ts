import { describe, expect, test } from "bun:test";
import {
  authorizeToolCapability,
  buildToolCapabilityGrant,
  buildToolCapabilityRequest,
  projectToolCapabilityGrant,
  type ToolCapabilityApprovalInput,
  type ToolCapabilityGrantInput,
  type ToolCapabilityPermissionInput,
  type ToolCapabilityRequestInput,
} from "../src/tool-capability-grant.ts";

const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const NOW = "2026-07-29T00:20:00.000Z";

const requestInput: ToolCapabilityRequestInput = {
  workspace: "default",
  project: "scrapbook",
  actorId: "actor:nightjar",
  workerSessionId: "worker:session-1",
  runId: "run_capability_1",
  action: "branch.create",
  resource: {
    kind: "github_branch_prefix",
    owner: "teamleaderleo",
    repository: "stensibly",
    prefix: "nightjar/",
  },
  arguments: {
    branchName: "nightjar/453-tool-capability-grants",
    baseSha: HEAD_SHA,
  },
};

function permission(
  overrides: Partial<ToolCapabilityPermissionInput> = {},
): ToolCapabilityPermissionInput {
  return {
    permissionId: "permission_branch_create",
    action: requestInput.action,
    resource: requestInput.resource,
    arguments: requestInput.arguments,
    maxUses: 2,
    ...overrides,
  };
}

function grantInput(
  permissionOverrides: Partial<ToolCapabilityPermissionInput> = {},
  grantOverrides: Partial<ToolCapabilityGrantInput> = {},
): ToolCapabilityGrantInput {
  return {
    grantId: "grant_capability_1",
    workspace: requestInput.workspace,
    project: requestInput.project,
    actorId: requestInput.actorId,
    workerSessionId: requestInput.workerSessionId,
    runId: requestInput.runId,
    generation: 3,
    issuedAt: "2026-07-29T00:00:00.000Z",
    expiresAt: "2026-07-29T01:00:00.000Z",
    issuer: {
      actorId: "actor:supervisor",
      authorityRef: "authority:item:453:generation:7",
    },
    evidenceRefs: ["issue:453", "run:authorization-review"],
    permissions: [permission(permissionOverrides)],
    ...grantOverrides,
  };
}

function authorize(
  grant = buildToolCapabilityGrant(grantInput()),
  overrides: Partial<Parameters<typeof authorizeToolCapability>[1]> = {},
) {
  return authorizeToolCapability(grant, {
    now: NOW,
    expectedGeneration: 3,
    request: requestInput,
    ...overrides,
  });
}

function approvalFor(
  request: ToolCapabilityRequestInput,
  state: "pending" | "approved" | "rejected",
): ToolCapabilityApprovalInput {
  const fingerprint = buildToolCapabilityRequest(request).fingerprint;
  if (state === "pending") {
    return {
      state,
      approvalId: "approval_merge_1",
      bindingFingerprint: fingerprint,
      expiresAt: "2026-07-29T00:45:00.000Z",
    };
  }
  return {
    state,
    approvalId: "approval_merge_1",
    bindingFingerprint: fingerprint,
    decidedBy: "actor:human",
    decidedAt: "2026-07-29T00:10:00.000Z",
    expiresAt: "2026-07-29T00:45:00.000Z",
  };
}

describe("tool capability requests", () => {
  test("canonicalizes argument order into one deterministic exact request", () => {
    const first = buildToolCapabilityRequest(requestInput);
    const second = buildToolCapabilityRequest({
      ...requestInput,
      arguments: {
        baseSha: HEAD_SHA,
        branchName: "nightjar/453-tool-capability-grants",
      },
    });

    expect(first).toEqual(second);
    expect(first.resource.key).toBe(
      "github:branch-prefix:teamleaderleo/stensibly:nightjar/",
    );
    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("rejects path traversal, shell fields, unsafe URLs, and secret material", () => {
    const invalidArguments = [
      { filePath: "../secrets.txt" },
      { shellCommand: "curl attacker.example" },
      { callbackUrl: "https://example.com/callback?token=secret" },
      { accessToken: "opaque-looking-but-still-not-a-reference" },
      { credentialHandle: "credential:github-production" , note: "ghp_secretmaterial" },
    ];
    for (const argumentsValue of invalidArguments) {
      expect(() => buildToolCapabilityRequest({
        ...requestInput,
        arguments: argumentsValue,
      })).toThrow(RangeError);
    }
  });

  test("rejects action and typed-resource mismatches", () => {
    expect(() => buildToolCapabilityRequest({
      ...requestInput,
      action: "merge.execute",
    })).toThrow("requires resource kind github_pull_request");
  });
});

describe("tool capability grants", () => {
  test("authorizes only the exact subject, action, resource, arguments, and generation", () => {
    const grant = buildToolCapabilityGrant(grantInput());
    expect(authorize(grant)).toMatchObject({
      authorized: true,
      permissionId: "permission_branch_create",
      generation: 3,
      consumesUse: true,
      remainingUsesAfterAuthorization: 1,
    });

    expect(authorize(grant, {
      expectedGeneration: 2,
    })).toMatchObject({ authorized: false, reason: "generation_mismatch" });
    expect(authorize(grant, {
      request: { ...requestInput, action: "repository.read", resource: {
        kind: "github_repository",
        owner: "teamleaderleo",
        repository: "stensibly",
      } },
    })).toMatchObject({ authorized: false, reason: "action_not_allowed" });
    expect(authorize(grant, {
      request: { ...requestInput, resource: {
        kind: "github_branch_prefix",
        owner: "teamleaderleo",
        repository: "another-repository",
        prefix: "nightjar/",
      } },
    })).toMatchObject({ authorized: false, reason: "resource_not_allowed" });
    expect(authorize(grant, {
      request: { ...requestInput, arguments: {
        branchName: "nightjar/escalated",
        baseSha: HEAD_SHA,
      } },
    })).toMatchObject({ authorized: false, reason: "arguments_not_allowed" });
  });

  test("fails closed for not-yet-active, expired, revoked, and exhausted grants", () => {
    const future = buildToolCapabilityGrant(grantInput({}, {
      issuedAt: "2026-07-29T00:30:00.000Z",
      expiresAt: "2026-07-29T01:00:00.000Z",
    }));
    expect(authorize(future)).toMatchObject({ authorized: false, reason: "grant_not_yet_active" });

    const expired = buildToolCapabilityGrant(grantInput({}, {
      issuedAt: "2026-07-28T23:30:00.000Z",
      expiresAt: "2026-07-29T00:15:00.000Z",
    }));
    expect(authorize(expired)).toMatchObject({ authorized: false, reason: "grant_expired" });

    const revoked = buildToolCapabilityGrant(grantInput({}, {
      revocation: {
        revokedAt: "2026-07-29T00:15:00.000Z",
        revokedBy: "actor:supervisor",
        reasonCode: "run-superseded",
      },
    }));
    expect(authorize(revoked)).toMatchObject({ authorized: false, reason: "grant_revoked" });

    expect(authorize(undefined, {
      usageByPermission: { permission_branch_create: 2 },
    })).toMatchObject({ authorized: false, reason: "budget_exhausted" });
  });

  test("requires an exact live human approval for high-impact actions", () => {
    const mergeRequest: ToolCapabilityRequestInput = {
      ...requestInput,
      action: "merge.execute",
      resource: {
        kind: "github_pull_request",
        owner: "teamleaderleo",
        repository: "stensibly",
        number: 453,
        headSha: HEAD_SHA,
      },
      arguments: { mergeMethod: "squash", expectedHeadSha: HEAD_SHA },
    };

    expect(() => buildToolCapabilityGrant(grantInput({
      permissionId: "permission_merge",
      action: mergeRequest.action,
      resource: mergeRequest.resource,
      arguments: mergeRequest.arguments,
      approval: undefined,
    }))).toThrow("requires human approval state");

    for (const state of ["pending", "rejected"] as const) {
      const grant = buildToolCapabilityGrant(grantInput({
        permissionId: "permission_merge",
        action: mergeRequest.action,
        resource: mergeRequest.resource,
        arguments: mergeRequest.arguments,
        approval: approvalFor(mergeRequest, state),
      }));
      expect(authorize(grant, { request: mergeRequest })).toMatchObject({
        authorized: false,
        reason: state === "pending" ? "approval_required" : "approval_rejected",
      });
    }

    const approved = buildToolCapabilityGrant(grantInput({
      permissionId: "permission_merge",
      action: mergeRequest.action,
      resource: mergeRequest.resource,
      arguments: mergeRequest.arguments,
      approval: approvalFor(mergeRequest, "approved"),
    }));
    expect(authorize(approved, { request: mergeRequest })).toMatchObject({
      authorized: true,
      approvalId: "approval_merge_1",
    });

    expect(() => buildToolCapabilityGrant(grantInput({
      permissionId: "permission_merge",
      action: mergeRequest.action,
      resource: mergeRequest.resource,
      arguments: { mergeMethod: "squash", expectedHeadSha: OTHER_SHA },
      approval: approvalFor(mergeRequest, "approved"),
    }))).toThrow("bind the exact tool capability request fingerprint");
  });

  test("detects altered persisted grants before evaluating a request", () => {
    const grant = buildToolCapabilityGrant(grantInput());
    const tampered = structuredClone(grant);
    tampered.permissions[0]!.maxUses = 99;
    expect(authorize(tampered)).toMatchObject({
      authorized: false,
      reason: "grant_tampered",
    });
  });

  test("projects bounded state without exact arguments or secret-bearing fields", () => {
    const grant = buildToolCapabilityGrant(grantInput());
    const projection = projectToolCapabilityGrant(grant, {
      now: NOW,
      usageByPermission: { permission_branch_create: 1 },
    });
    expect(projection).toMatchObject({
      state: "active",
      includesArguments: false,
      includesSecrets: false,
      permissions: [{
        permissionId: "permission_branch_create",
        approvalState: "not_required",
        usedUses: 1,
        remainingUses: 1,
      }],
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("branchName");
    expect(serialized).not.toContain(HEAD_SHA);
    expect(serialized).not.toContain("argumentsFingerprint");
  });

  test("rejects altered replay while identical replay stays deterministic", () => {
    const first = buildToolCapabilityGrant(grantInput());
    const second = buildToolCapabilityGrant(grantInput());
    expect(second.fingerprint).toBe(first.fingerprint);

    const alteredRequest: ToolCapabilityRequestInput = {
      ...requestInput,
      arguments: {
        branchName: "nightjar/453-tool-capability-grants",
        baseSha: OTHER_SHA,
      },
    };
    const altered = buildToolCapabilityGrant(grantInput({
      arguments: alteredRequest.arguments,
    }));
    expect(altered.fingerprint).not.toBe(first.fingerprint);
    expect(authorize(first, { request: alteredRequest })).toMatchObject({
      authorized: false,
      reason: "arguments_not_allowed",
    });
  });
});
