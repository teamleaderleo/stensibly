import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  acceptSqliteToolCapabilityGrant,
  ensureToolCapabilityGrantSchema,
  getCurrentSqliteToolCapabilityGrant,
  getSqliteToolCapabilityPermissionUsage,
  getSqliteToolCapabilityRevocation,
  listSqliteToolCapabilityAdmissions,
  listSqliteToolCapabilityGrantHistory,
  reserveSqliteToolCapabilityUse,
  revokeSqliteToolCapabilityGrant,
  ToolCapabilityGrantStorageConflictError,
} from "../src/tool-capability-grants-sqlite.ts";
import {
  buildToolCapabilityGrant,
  type ToolCapabilityGrantInput,
  type ToolCapabilityPermissionInput,
  type ToolCapabilityRequestInput,
} from "../src/tool-capability-grant.ts";
import { StensiblyStore } from "../src/store.ts";

const HEAD_SHA = "a".repeat(40);
const NOW = "2026-07-29T00:20:00.000Z";
const ACCEPTED_AT = "2026-07-29T00:05:00.000Z";

const requestInput: ToolCapabilityRequestInput = {
  workspace: "default",
  project: "scrapbook",
  actorId: "actor:mercury",
  workerSessionId: "worker:session-453",
  runId: "run_capability_storage_1",
  action: "branch.create",
  resource: {
    kind: "github_branch_prefix",
    owner: "teamleaderleo",
    repository: "stensibly",
    prefix: "mercury/",
  },
  arguments: {
    branchName: "mercury/453-capability-grant-sqlite",
    baseSha: HEAD_SHA,
  },
};

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => store.close());

function clockAt(value: string) {
  return { clock: () => new Date(value) };
}

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

function grant(
  generation = 1,
  permissionOverrides: Partial<ToolCapabilityPermissionInput> = {},
  grantOverrides: Partial<ToolCapabilityGrantInput> = {},
) {
  return buildToolCapabilityGrant({
    grantId: "grant_storage_1",
    workspace: requestInput.workspace,
    project: requestInput.project,
    actorId: requestInput.actorId,
    workerSessionId: requestInput.workerSessionId,
    runId: requestInput.runId,
    generation,
    issuedAt: "2026-07-29T00:00:00.000Z",
    expiresAt: "2026-07-29T01:00:00.000Z",
    issuer: {
      actorId: "actor:supervisor",
      authorityRef: `authority:item:453:generation:${generation}`,
    },
    evidenceRefs: ["issue:453", `generation:${generation}`],
    permissions: [permission(permissionOverrides)],
    ...grantOverrides,
  });
}

function accept(
  acceptedGrant = grant(),
  expectedCurrentGeneration: number | null = null,
  overrides: Partial<Parameters<typeof acceptSqliteToolCapabilityGrant>[1]> = {},
  acceptedAt = ACCEPTED_AT,
) {
  return acceptSqliteToolCapabilityGrant(store, {
    workspace: "default",
    project: "scrapbook",
    grant: acceptedGrant,
    expectedCurrentGeneration,
    acceptanceRef: `accept:${acceptedGrant.grantId}:${acceptedGrant.generation}`,
    acceptedBy: "actor:mercury",
    ...overrides,
  }, clockAt(acceptedAt));
}

function reserve(
  idempotencyKey: string,
  overrides: Partial<Parameters<typeof reserveSqliteToolCapabilityUse>[1]> = {},
  at = NOW,
) {
  return reserveSqliteToolCapabilityUse(store, {
    workspace: "default",
    project: "scrapbook",
    grantId: "grant_storage_1",
    expectedGeneration: 1,
    request: requestInput,
    idempotencyKey,
    ...overrides,
  }, clockAt(at));
}

describe("SQLite tool capability grant acceptance", () => {
  test("accepts one immutable current generation and deduplicates exact replay", () => {
    const firstGrant = grant();
    const first = accept(firstGrant);
    expect(first).toMatchObject({
      replayed: false,
      record: {
        workspace: "default",
        project: "scrapbook",
        grantId: "grant_storage_1",
        generation: 1,
        fingerprint: firstGrant.fingerprint,
        acceptedAt: ACCEPTED_AT,
        isCurrent: true,
      },
    });

    const replay = accept(firstGrant, null, {}, "2026-07-29T00:10:00.000Z");
    expect(replay.replayed).toBe(true);
    expect(replay.record.id).toBe(first.record.id);
    expect(replay.record.acceptedAt).toBe(ACCEPTED_AT);
    expect(listSqliteToolCapabilityGrantHistory(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: "grant_storage_1",
    })).toHaveLength(1);
  });

  test("rejects altered acceptance reuse and altered generation reuse", () => {
    const firstGrant = grant();
    accept(firstGrant);
    expect(() => accept(firstGrant, null, {
      acceptedBy: "actor:other",
    })).toThrow("acceptance reference");

  expect(() => accept(firstGrant, null, {
    acceptanceRef: "accept:other-reference",
  })).toThrow("acceptance provenance");
  expect(() => accept(firstGrant, null, {
    acceptanceRef: "accept:other-actor-reference",
    acceptedBy: "actor:other",
  })).toThrow("acceptance provenance");

  const altered = grant(1, {}, {
      evidenceRefs: ["issue:453", "altered:evidence"],
    });
    expect(() => accept(altered, null, {
      acceptanceRef: "accept:altered-generation-one",
    })).toThrow("generation 1 was reused with altered content");
  });

  test("uses generation compare-and-swap and preserves append-only history", () => {
    const first = accept(grant(1));
    const secondGrant = grant(2);
    const second = accept(secondGrant, 1);

    expect(second.record).toMatchObject({ generation: 2, isCurrent: true });
    expect(getCurrentSqliteToolCapabilityGrant(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: "grant_storage_1",
    })?.id).toBe(second.record.id);
    expect(listSqliteToolCapabilityGrantHistory(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: "grant_storage_1",
    }).map((entry) => [entry.generation, entry.isCurrent])).toEqual([
      [1, false],
      [2, true],
    ]);

    expect(() => accept(grant(3), 1)).toThrow("Expected current generation 1");
    expect(() => accept(grant(3), null)).toThrow("Expected current generation null");
    expect(first.record.id).not.toBe(second.record.id);
  });

  test("prevents subject drift and scope drift across higher generations", () => {
    accept(grant(1));
    expect(() => accept(grant(2, {}, {
      actorId: "actor:other",
    }), 1)).toThrow("must preserve the grant actor");
    expect(() => acceptSqliteToolCapabilityGrant(store, {
      workspace: "other",
      project: "scrapbook",
      grant: grant(2),
      expectedCurrentGeneration: null,
      acceptanceRef: "accept:foreign-scope",
      acceptedBy: "actor:mercury",
    }, clockAt(ACCEPTED_AT))).toThrow("must match the storage scope");
  });

  test("rejects tampered, noncanonical, and embedded-revocation grants", () => {
    const tampered = structuredClone(grant());
    tampered.permissions[0]!.maxUses = 99;
    expect(() => accept(tampered)).toThrow("canonical shape is invalid");

    const extraField = structuredClone(grant()) as ReturnType<typeof grant> & { extra?: string };
    extraField.extra = "unreviewed";
    const canonical = structuredClone(grant());
    extraField.fingerprint = canonical.fingerprint;
    expect(() => accept(extraField, null, {
      acceptanceRef: "accept:extra-field",
    })).toThrow("canonical shape is invalid");

    const revokedGrant = buildToolCapabilityGrant({
      grantId: "grant_revoked_embedded",
      workspace: requestInput.workspace,
      project: requestInput.project,
      actorId: requestInput.actorId,
      workerSessionId: requestInput.workerSessionId,
      runId: requestInput.runId,
      generation: 1,
      issuedAt: "2026-07-29T00:00:00.000Z",
      expiresAt: "2026-07-29T01:00:00.000Z",
      issuer: { actorId: "actor:supervisor", authorityRef: "authority:453" },
      evidenceRefs: ["issue:453"],
      permissions: [permission()],
      revocation: {
        revokedAt: "2026-07-29T00:10:00.000Z",
        revokedBy: "actor:supervisor",
        reasonCode: "superseded",
      },
    });
    expect(() => accept(revokedGrant, null, {
      acceptanceRef: "accept:embedded-revocation",
    })).toThrow("use the revocation ledger");
  });
});

describe("atomic SQLite tool admission", () => {
  test("atomically consumes uses and makes exact replay free across clock changes", () => {
    const accepted = accept(grant());
    const first = reserve("admission:one");
    expect(first).toMatchObject({
      replayed: false,
      record: {
        acceptedGrantGeneration: 1,
        acceptedGrantFingerprint: accepted.record.fingerprint,
        recordedAt: NOW,
        authorization: {
          authorized: true,
          permissionId: "permission_branch_create",
          remainingUsesAfterAuthorization: 1,
        },
      },
    });
    expect(getSqliteToolCapabilityPermissionUsage(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      generation: accepted.record.generation,
      fingerprint: accepted.record.fingerprint,
      permissionId: "permission_branch_create",
    })).toBe(1);

    const replay = reserve(
      "admission:one",
      {},
      "2026-07-29T00:59:59.000Z",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.record.id).toBe(first.record.id);
    expect(replay.record.recordedAt).toBe(NOW);
    expect(getSqliteToolCapabilityPermissionUsage(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      generation: accepted.record.generation,
      fingerprint: accepted.record.fingerprint,
      permissionId: "permission_branch_create",
    })).toBe(1);

    expect(reserve("admission:two").record.authorization).toMatchObject({
      authorized: true,
      remainingUsesAfterAuthorization: 0,
    });
    expect(reserve("admission:three").record.authorization).toMatchObject({
      authorized: false,
      reason: "budget_exhausted",
    });
    expect(getSqliteToolCapabilityPermissionUsage(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      generation: accepted.record.generation,
      fingerprint: accepted.record.fingerprint,
      permissionId: "permission_branch_create",
    })).toBe(2);
    expect(listSqliteToolCapabilityAdmissions(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: "grant_storage_1",
    })).toHaveLength(3);
  });

  test("rejects altered idempotency replay before another use is consumed", () => {
    const accepted = accept(grant());
    reserve("admission:stable");
    expect(() => reserve("admission:stable", {
      expectedGeneration: 2,
    })).toThrow("was reused with altered content");
    expect(getSqliteToolCapabilityPermissionUsage(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      generation: accepted.record.generation,
      fingerprint: accepted.record.fingerprint,
      permissionId: "permission_branch_create",
    })).toBe(1);
  });

  test("records bounded denials without caller-supplied trust or time", () => {
    const missing = reserve("admission:no-grant");
    expect(missing.record).toMatchObject({
      acceptedGrantGeneration: null,
      acceptedGrantFingerprint: null,
      authorization: { authorized: false, reason: "grant_untrusted" },
    });

    accept(grant());
    expect(reserve("admission:wrong-generation", {
      expectedGeneration: 2,
    }).record.authorization).toMatchObject({
      authorized: false,
      reason: "generation_mismatch",
    });
    expect(reserve("admission:wrong-arguments", {
      request: {
        ...requestInput,
        arguments: {
          branchName: "mercury/other",
          baseSha: HEAD_SHA,
        },
      },
    }).record.authorization).toMatchObject({
      authorized: false,
      reason: "arguments_not_allowed",
    });
  });

  test("isolates usage by grant generation", () => {
    const first = accept(grant(1));
    reserve("admission:g1:one");
    reserve("admission:g1:two");
    const second = accept(grant(2), 1);

    const generationTwo = reserve("admission:g2:one", {
      expectedGeneration: 2,
    });
    expect(generationTwo.record.authorization).toMatchObject({
      authorized: true,
      generation: 2,
      remainingUsesAfterAuthorization: 1,
    });
    expect(getSqliteToolCapabilityPermissionUsage(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: first.record.grantId,
      generation: 1,
      fingerprint: first.record.fingerprint,
      permissionId: "permission_branch_create",
    })).toBe(2);
    expect(getSqliteToolCapabilityPermissionUsage(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: second.record.grantId,
      generation: 2,
      fingerprint: second.record.fingerprint,
      permissionId: "permission_branch_create",
    })).toBe(1);
  });
});

describe("SQLite tool capability revocation", () => {
  test("binds revocation to current fingerprint and denies from server effective time", () => {
    const accepted = accept(grant());
    expect(reserve(
      "admission:before-revocation",
      {},
      "2026-07-29T00:29:59.000Z",
    ).record.authorization).toMatchObject({ authorized: true });

    const revoked = revokeSqliteToolCapabilityGrant(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      expectedGeneration: accepted.record.generation,
      expectedFingerprint: accepted.record.fingerprint,
      revokedBy: "actor:supervisor",
      reasonCode: "run-superseded",
      idempotencyKey: "revoke:grant-storage-1",
    }, clockAt("2026-07-29T00:30:00.000Z"));
    expect(revoked).toMatchObject({
      replayed: false,
      record: {
        reasonCode: "run-superseded",
        revokedAt: "2026-07-29T00:30:00.000Z",
      },
    });
    const replay = revokeSqliteToolCapabilityGrant(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      expectedGeneration: accepted.record.generation,
      expectedFingerprint: accepted.record.fingerprint,
      revokedBy: "actor:supervisor",
      reasonCode: "run-superseded",
      idempotencyKey: "revoke:grant-storage-1",
    }, clockAt("2026-07-29T00:40:00.000Z"));
    expect(replay.replayed).toBe(true);
    expect(replay.record.id).toBe(revoked.record.id);

    expect(reserve(
      "admission:after-revocation",
      {},
      "2026-07-29T00:30:00.000Z",
    ).record.authorization).toMatchObject({
      authorized: false,
      reason: "grant_revoked",
    });
    expect(getSqliteToolCapabilityRevocation(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      generation: accepted.record.generation,
    })?.id).toBe(revoked.record.id);
  });

  test("rejects stale fingerprint, altered replay, and out-of-lifetime revocation", () => {
    const accepted = accept(grant());
    expect(() => revokeSqliteToolCapabilityGrant(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      expectedGeneration: 1,
      expectedFingerprint: `sha256:${"0".repeat(64)}`,
      revokedBy: "actor:supervisor",
      reasonCode: "wrong-fingerprint",
      idempotencyKey: "revoke:wrong-fingerprint",
    }, clockAt("2026-07-29T00:30:00.000Z"))).toThrow(
      "current generation and fingerprint",
    );

    revokeSqliteToolCapabilityGrant(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      expectedGeneration: 1,
      expectedFingerprint: accepted.record.fingerprint,
      revokedBy: "actor:supervisor",
      reasonCode: "run-superseded",
      idempotencyKey: "revoke:stable",
    }, clockAt("2026-07-29T00:30:00.000Z"));
    expect(() => revokeSqliteToolCapabilityGrant(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
      expectedGeneration: 1,
      expectedFingerprint: accepted.record.fingerprint,
      revokedBy: "actor:supervisor",
      reasonCode: "changed",
      idempotencyKey: "revoke:stable",
    }, clockAt("2026-07-29T00:31:00.000Z"))).toThrow(
      "was reused with altered content",
    );

    const secondStore = new StensiblyStore(":memory:");
    try {
      const secondGrant = grant();
      const secondAccepted = acceptSqliteToolCapabilityGrant(secondStore, {
        workspace: "default",
        project: "scrapbook",
        grant: secondGrant,
        expectedCurrentGeneration: null,
        acceptanceRef: "accept:second-store",
        acceptedBy: "actor:mercury",
      }, clockAt(ACCEPTED_AT));
      expect(() => revokeSqliteToolCapabilityGrant(secondStore, {
        workspace: "default",
        project: "scrapbook",
        grantId: secondAccepted.record.grantId,
        expectedGeneration: 1,
        expectedFingerprint: secondAccepted.record.fingerprint,
        revokedBy: "actor:supervisor",
        reasonCode: "too-late",
        idempotencyKey: "revoke:too-late",
      }, clockAt("2026-07-29T01:00:01.000Z"))).toThrow(
        "within the grant lifetime",
      );
    } finally {
      secondStore.close();
    }
  });
});

describe("stored capability integrity", () => {
  test("detects tampered grants and admission authorizations", () => {
    const accepted = accept(grant());
    store.db.query(`
      UPDATE tool_capability_grants
      SET fingerprint = ?1
      WHERE id = ?2
    `).run(`sha256:${"0".repeat(64)}`, accepted.record.id);
    expect(() => getCurrentSqliteToolCapabilityGrant(store, {
      workspace: "default",
      project: "scrapbook",
      grantId: accepted.record.grantId,
    })).toThrow("metadata does not match");

    const isolated = new StensiblyStore(":memory:");
    try {
      const isolatedGrant = grant();
      acceptSqliteToolCapabilityGrant(isolated, {
        workspace: "default",
        project: "scrapbook",
        grant: isolatedGrant,
        expectedCurrentGeneration: null,
        acceptanceRef: "accept:isolated",
        acceptedBy: "actor:mercury",
      }, clockAt(ACCEPTED_AT));
      const admission = reserveSqliteToolCapabilityUse(isolated, {
        workspace: "default",
        project: "scrapbook",
        grantId: isolatedGrant.grantId,
        expectedGeneration: 1,
        request: requestInput,
        idempotencyKey: "admission:isolated",
      }, clockAt(NOW));
      isolated.db.query(`
        UPDATE tool_capability_admissions
        SET authorization_json = ?1
        WHERE id = ?2
      `).run("{}", admission.record.id);
      expect(() => listSqliteToolCapabilityAdmissions(isolated, {
        workspace: "default",
        project: "scrapbook",
        grantId: isolatedGrant.grantId,
      })).toThrow("authorization fingerprint is invalid");
    } finally {
      isolated.close();
    }
  });

  test("keeps workspace and project admission histories isolated", () => {
    accept(grant());
    reserve("admission:default");
    expect(listSqliteToolCapabilityAdmissions(store, {
      workspace: "other",
      project: "scrapbook",
      grantId: "grant_storage_1",
    })).toEqual([]);
    expect(listSqliteToolCapabilityAdmissions(store, {
      workspace: "default",
      project: "other",
      grantId: "grant_storage_1",
    })).toEqual([]);
  });
});
