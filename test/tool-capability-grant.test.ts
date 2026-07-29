import { describe, expect, test } from "bun:test";
import {
  authorizeToolCapability,
  buildToolCapabilityApprovalBinding,
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
    trustedGrantFingerprint: grant.fingerprint,
    expectedGeneration: 3,
    request: requestInput,
    ...overrides,
  });
}

function approvalFor(
  request: ToolCapabilityRequestInput,
  state: "pending" | "approved" | "rejected",
  overrides: {
    grantId?: string;
    generation?: number;
    permissionId?: string;
  } = {},
): ToolCapabilityApprovalInput {
  const fingerprint = buildToolCapabilityApprovalBinding({
    grantId: overrides.grantId ?? "grant_capability_1",
    generation: overrides.generation ?? 3,
    permissionId: overrides.permissionId ?? "permission_merge",
    request,
  });
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

  test("enforces branch prefixes, project scope, pull-request heads, and spend caps", () => {
    expect(() => buildToolCapabilityRequest({
      ...requestInput,
      arguments: { branchName: "other/escalated", baseSha: HEAD_SHA },
    })).toThrow("inside the authorized branch prefix");
    expect(() => buildToolCapabilityRequest({
      ...requestInput,
      arguments: { branchName: "nightjar/valid", baseSha: "main" },
    })).toThrow("full 40-character SHA");

    expect(() => buildToolCapabilityRequest({
      ...requestInput,
      action: "artifact.attach",
      resource: { kind: "stensibly_project", workspace: "default", project: "foreign" },
      arguments: { artifactRef: "artifact:bounded" },
    })).toThrow("match the request project scope");

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
      arguments: { mergeMethod: "squash", expectedHeadSha: OTHER_SHA },
    };
    expect(() => buildToolCapabilityRequest(mergeRequest)).toThrow(
      "preserve the authorized pull-request head SHA",
    );

    expect(() => buildToolCapabilityRequest({
      ...requestInput,
      action: "spend.commit",
      resource: { kind: "spend_budget", currency: "CAD", maximumMinorUnits: 5000 },
      arguments: { currency: "CAD", amountMinorUnits: 5001 },
    })).toThrow("exceeds the authorized budget");
    expect(() => buildToolCapabilityRequest({
      ...requestInput,
      action: "spend.commit",
      resource: { kind: "spend_budget", currency: "CAD", maximumMinorUnits: 5000 },
      arguments: { currency: "USD", amountMinorUnits: 100 },
    })).toThrow("authorized currency");
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
      maxUses: 1,
      action: mergeRequest.action,
      resource: mergeRequest.resource,
      arguments: mergeRequest.arguments,
      approval: undefined,
    }))).toThrow("requires human approval state");

    for (const state of ["pending", "rejected"] as const) {
      const grant = buildToolCapabilityGrant(grantInput({
        permissionId: "permission_merge",
        maxUses: 1,
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
      maxUses: 1,
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
      maxUses: 1,
      action: mergeRequest.action,
      resource: mergeRequest.resource,
      arguments: { mergeMethod: "squash", expectedHeadSha: OTHER_SHA },
      approval: approvalFor(mergeRequest, "approved"),
    }))).toThrow("Merge arguments must preserve the authorized pull-request head SHA");

    expect(() => buildToolCapabilityGrant(grantInput({
      permissionId: "permission_merge",
      maxUses: 1,
      action: mergeRequest.action,
      resource: mergeRequest.resource,
      arguments: mergeRequest.arguments,
      approval: approvalFor(mergeRequest, "approved", { generation: 3 }),
    }, { generation: 4 }))).toThrow(
      "bind the exact grant generation, permission, and request",
    );
  });

  test("requires a server-owned trusted grant fingerprint", () => {
    const grant = buildToolCapabilityGrant(grantInput());
    expect(authorizeToolCapability(grant, {
      now: NOW,
      trustedGrantFingerprint: `sha256:${"0".repeat(64)}`,
      expectedGeneration: 3,
      request: requestInput,
    })).toMatchObject({ authorized: false, reason: "grant_untrusted" });

    const selfMinted = buildToolCapabilityGrant(grantInput({}, {
      grantId: "grant_self_minted",
      issuer: { actorId: "actor:attacker", authorityRef: "authority:invented" },
    }));
    expect(authorizeToolCapability(selfMinted, {
      now: NOW,
      trustedGrantFingerprint: grant.fingerprint,
      expectedGeneration: 3,
      request: requestInput,
    })).toMatchObject({ authorized: false, reason: "grant_untrusted" });
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
      trustedGrantFingerprint: grant.fingerprint,
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


describe("tool capability canonical ordering", () => {
  test("uses Unicode code-unit order across requests and grants", () => {
    const firstRequest = buildToolCapabilityRequest({
      ...requestInput,
      arguments: {
        branchName: "nightjar/453-tool-capability-grants",
        baseSha: HEAD_SHA,
        a: 2,
        Z: 1,
      },
    });
    const secondRequest = buildToolCapabilityRequest({
      ...requestInput,
      arguments: {
        Z: 1,
        a: 2,
        baseSha: HEAD_SHA,
        branchName: "nightjar/453-tool-capability-grants",
      },
    });

    expect(firstRequest.fingerprint).toBe(secondRequest.fingerprint);
    expect(Object.keys(firstRequest.arguments).filter((key) => key === "Z" || key === "a"))
      .toEqual(["Z", "a"]);

    const permissionA = permission({
      permissionId: "permission_a",
      arguments: { branchName: "nightjar/a", baseSha: HEAD_SHA },
    });
    const permissionZ = permission({
      permissionId: "permission_Z",
      arguments: { branchName: "nightjar/Z", baseSha: HEAD_SHA },
    });
    const firstGrant = buildToolCapabilityGrant(grantInput({}, {
      evidenceRefs: ["ref:a", "ref:Z"],
      permissions: [permissionA, permissionZ],
    }));
    const secondGrant = buildToolCapabilityGrant(grantInput({}, {
      evidenceRefs: ["ref:Z", "ref:a"],
      permissions: [permissionZ, permissionA],
    }));

    expect(firstGrant.fingerprint).toBe(secondGrant.fingerprint);
    expect(firstGrant.evidenceRefs).toEqual(["ref:Z", "ref:a"]);
    expect(firstGrant.permissions.map((entry) => entry.permissionId))
      .toEqual(["permission_Z", "permission_a"]);
  });
});


describe("tool capability authority boundaries", () => {
  test("keeps high-impact approvals one-shot", () => {
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
    const approvedMerge = approvalFor(mergeRequest, "approved");

    expect(() => buildToolCapabilityGrant(grantInput({
      permissionId: "permission_merge",
      action: mergeRequest.action,
      resource: mergeRequest.resource,
      arguments: mergeRequest.arguments,
      maxUses: 2,
      approval: approvedMerge,
    }))).toThrow("must be limited to one use");

    const mergeGrant = buildToolCapabilityGrant(grantInput({
      permissionId: "permission_merge",
      maxUses: 1,
      action: mergeRequest.action,
      resource: mergeRequest.resource,
      arguments: mergeRequest.arguments,
      approval: approvedMerge,
    }));
    expect(authorize(mergeGrant, { request: mergeRequest })).toMatchObject({
      authorized: true,
      remainingUsesAfterAuthorization: 0,
    });
    expect(authorize(mergeGrant, {
      request: mergeRequest,
      usageByPermission: { permission_merge: 1 },
    })).toMatchObject({ authorized: false, reason: "budget_exhausted" });

    const spendRequest: ToolCapabilityRequestInput = {
      ...requestInput,
      action: "spend.commit",
      resource: { kind: "spend_budget", currency: "GBP", maximumMinorUnits: 5000 },
      arguments: { currency: "GBP", amountMinorUnits: 5000 },
    };
    const spendGrant = buildToolCapabilityGrant(grantInput({
      permissionId: "permission_spend",
      maxUses: 1,
      action: spendRequest.action,
      resource: spendRequest.resource,
      arguments: spendRequest.arguments,
      approval: approvalFor(spendRequest, "approved", { permissionId: "permission_spend" }),
    }));
    expect(authorize(spendGrant, { request: spendRequest })).toMatchObject({
      authorized: true,
      remainingUsesAfterAuthorization: 0,
    });
    expect(authorize(spendGrant, {
      request: spendRequest,
      usageByPermission: { permission_spend: 1 },
    })).toMatchObject({ authorized: false, reason: "budget_exhausted" });
  });

  test("classifies subject mismatches and malformed authorization inputs", () => {
    const grant = buildToolCapabilityGrant(grantInput());
    const mismatches: Array<[Partial<ToolCapabilityRequestInput>, string]> = [
      [{ workspace: "other" }, "workspace_mismatch"],
      [{ project: "other" }, "project_mismatch"],
      [{ actorId: "actor:other" }, "actor_mismatch"],
      [{ workerSessionId: "worker:other" }, "worker_session_mismatch"],
      [{ runId: "run_capability_2" }, "run_mismatch"],
    ];
    for (const [requestOverride, reason] of mismatches) {
      expect(authorize(grant, {
        request: { ...requestInput, ...requestOverride },
      })).toMatchObject({ authorized: false, reason });
    }
    expect(authorize(grant, { now: "invalid" })).toMatchObject({
      authorized: false,
      reason: "request_invalid",
    });
    for (const used of [-1, 1.5]) {
      expect(authorize(grant, {
        usageByPermission: { permission_branch_create: used },
      })).toMatchObject({ authorized: false, reason: "request_invalid" });
    }
  });

  test("fails closed for expired approvals and invalid projections", () => {
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
    for (const state of ["pending", "approved"] as const) {
      const approval = approvalFor(mergeRequest, state);
      const grant = buildToolCapabilityGrant(grantInput({
        permissionId: "permission_merge",
        maxUses: 1,
        action: mergeRequest.action,
        resource: mergeRequest.resource,
        arguments: mergeRequest.arguments,
        approval: { ...approval, expiresAt: "2026-07-29T00:15:00.000Z" },
      }));
      expect(authorize(grant, { request: mergeRequest })).toMatchObject({
        authorized: false,
        reason: "approval_expired",
      });
    }

    const grant = buildToolCapabilityGrant(grantInput());
    const invalidProjections = [
      projectToolCapabilityGrant(grant, {
        now: "invalid",
        trustedGrantFingerprint: grant.fingerprint,
      }),
      projectToolCapabilityGrant(grant, {
        now: NOW,
        trustedGrantFingerprint: `sha256:${"0".repeat(64)}`,
      }),
      projectToolCapabilityGrant(grant, {
        now: NOW,
        trustedGrantFingerprint: grant.fingerprint,
        usageByPermission: { permission_branch_create: -1 },
      }),
    ];
    for (const projection of invalidProjections) {
      expect(projection).toMatchObject({
        state: "invalid",
        grantId: null,
        workspace: null,
        project: null,
        actorId: null,
        workerSessionId: null,
        runId: null,
        generation: null,
        issuedAt: null,
        expiresAt: null,
        issuer: null,
        evidenceRefs: [],
        permissions: [],
        includesArguments: false,
        includesSecrets: false,
      });
    }
  });

  test("rejects invisible unsafe text characters", () => {
    for (const character of ["\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\ufeff"]) {
      expect(() => buildToolCapabilityRequest({
        ...requestInput,
        arguments: {
          branchName: `nightjar/unsafe${character}branch`,
          baseSha: HEAD_SHA,
        },
      })).toThrow("unsafe characters");
    }
  });
});
