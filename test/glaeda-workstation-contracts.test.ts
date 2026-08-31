import { describe, expect, test } from "bun:test";
import {
  admitGlaedaWorkstationCheckV1,
  admitGlaedaWorkstationReceiptV1,
  assertGlaedaWorkstationCheckMatchesCommandV1,
  assertGlaedaWorkstationReceiptMatchesCommandV1,
  fingerprintGlaedaWorkstationCommandV1,
  normalizeGlaedaWorkstationCommandV1,
  type GlaedaWorkstationCheckV1,
  type GlaedaWorkstationCommandV1,
  type GlaedaWorkstationReceiptV1,
} from "../src/glaeda-workstation-contracts.ts";

const sha = (char: string) => `sha256:${char.repeat(64)}`;
const git = (char: string, length = 40) => char.repeat(length);

function command(overrides: Partial<GlaedaWorkstationCommandV1> = {}): GlaedaWorkstationCommandV1 {
  return {
    version: 1,
    project: "glaeda",
    itemId: "item-owned-workstation",
    itemClaimGeneration: 3,
    runId: "run-owned-workstation",
    runGeneration: 4,
    leaseGeneration: 2,
    authority: {
      holderId: "agent:owned-workstation",
      expiresAt: "2026-08-31T02:00:00.000Z",
    },
    commandId: "glaeda-command-1",
    idempotencyKey: "glaeda-command-idempotency-1",
    node: {
      id: "big-red",
      generation: 7,
      capabilitySnapshotSha256: sha("a"),
      osClass: "linux",
      architectureClass: "x86_64",
      glaedaRuntimeSha256: sha("b"),
    },
    source: {
      repository: "teamleaderleo/glaeda",
      commitOid: git("c"),
      treeOid: git("d"),
      logicalChangeRef: "stensibly:change:glaeda-hot-loop",
    },
    profile: {
      id: "repo-query-v1",
      versionSha256: sha("e"),
      class: "repo_query",
      resourceClass: "interactive-small",
      deadlineSeconds: 60,
    },
    ...overrides,
  };
}

function check(
  input: GlaedaWorkstationCommandV1,
  overrides: Partial<GlaedaWorkstationCheckV1> = {},
): GlaedaWorkstationCheckV1 {
  return {
    schema: "glaeda-workstation-check/v1",
    commandFingerprint: fingerprintGlaedaWorkstationCommandV1(input),
    node: { ...input.node },
    source: {
      repository: input.source.repository,
      commitOid: input.source.commitOid,
      treeOid: input.source.treeOid,
    },
    profile: {
      id: input.profile.id,
      versionSha256: input.profile.versionSha256,
      class: input.profile.class,
    },
    executionIdentityClass: input.profile.class === "repo_query"
      ? "read_only_repository"
      : "credentialless_project",
    supported: true,
    rawContentEmitted: false,
    authorizesWork: false,
    authorizesEffects: false,
    ...overrides,
  };
}

function receipt(
  input: GlaedaWorkstationCommandV1,
  checked: GlaedaWorkstationCheckV1,
  overrides: Partial<GlaedaWorkstationReceiptV1> = {},
): GlaedaWorkstationReceiptV1 {
  return {
    schema: "glaeda-workstation-receipt/v1",
    commandFingerprint: checked.commandFingerprint,
    node: { ...checked.node },
    source: { ...checked.source },
    profile: { ...checked.profile },
    executionIdentityClass: checked.executionIdentityClass,
    terminalClass: "succeeded",
    resultSha256: sha("f"),
    resultBytes: 384,
    startedAt: "2026-08-31T01:00:00.000Z",
    settledAt: "2026-08-31T01:00:01.000Z",
    rawContentEmitted: false,
    containsPrivateContent: false,
    containsCredentials: false,
    authorizesWork: false,
    authorizesEffects: false,
    authorizesRedispatch: false,
    ...overrides,
  };
}

describe("pure Glaeda workstation contracts", () => {
  test("normalizes and fingerprints one exact Big Red repository query", () => {
    const input = command();
    const normalized = normalizeGlaedaWorkstationCommandV1(input);
    expect(normalized).toEqual(input);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.node)).toBe(true);
    expect(Object.isFrozen(normalized.source)).toBe(true);
    expect(Object.isFrozen(normalized.profile)).toBe(true);
    expect(fingerprintGlaedaWorkstationCommandV1(input)).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  test("accepts SHA-256 Git object format when commit and tree agree", () => {
    const input = command({
      source: {
        repository: "teamleaderleo/glaeda",
        commitOid: git("1", 64),
        treeOid: git("2", 64),
        logicalChangeRef: null,
      },
    });
    expect(normalizeGlaedaWorkstationCommandV1(input).source.commitOid).toHaveLength(64);
  });

  test("rejects branch-like or mixed-format source identity", () => {
    const branchLike = command({
      source: {
        repository: "teamleaderleo/glaeda",
        commitOid: "main",
        treeOid: git("d"),
        logicalChangeRef: null,
      },
    });
    expect(() => normalizeGlaedaWorkstationCommandV1(branchLike)).toThrow(/commit OID/);

    const mixed = command({
      source: {
        repository: "teamleaderleo/glaeda",
        commitOid: git("c"),
        treeOid: git("d", 64),
        logicalChangeRef: null,
      },
    });
    expect(() => normalizeGlaedaWorkstationCommandV1(mixed)).toThrow(/object formats/);
  });

  test("rejects unexpected fields and accessor-backed fields", () => {
    expect(() => normalizeGlaedaWorkstationCommandV1({
      ...command(),
      shell: "cargo test",
    })).toThrow(/unexpected fields/);

    const input = command() as unknown as Record<string, unknown>;
    Object.defineProperty(input, "commandId", {
      enumerable: true,
      get() {
        throw new Error("getter must never run");
      },
    });
    expect(() => normalizeGlaedaWorkstationCommandV1(input)).toThrow(/accessor/);
  });

  test("admits a content-free check and terminal receipt for the exact command", () => {
    const input = command();
    const checked = check(input);
    const terminal = receipt(input, checked);
    expect(admitGlaedaWorkstationCheckV1(checked)).toEqual(checked);
    expect(admitGlaedaWorkstationReceiptV1(terminal)).toEqual(terminal);
    expect(() => assertGlaedaWorkstationCheckMatchesCommandV1(input, checked)).not.toThrow();
    expect(() =>
      assertGlaedaWorkstationReceiptMatchesCommandV1(input, checked, terminal)
    ).not.toThrow();
    expect(terminal).toMatchObject({
      rawContentEmitted: false,
      containsPrivateContent: false,
      containsCredentials: false,
      authorizesWork: false,
      authorizesEffects: false,
      authorizesRedispatch: false,
    });
  });

  test("source, node, and profile drift independently invalidate exact matching", () => {
    const input = command();
    const checked = check(input);
    const mutations: GlaedaWorkstationCheckV1[] = [
      {
        ...checked,
        source: { ...checked.source, commitOid: git("9") },
      },
      {
        ...checked,
        node: { ...checked.node, generation: checked.node.generation + 1 },
      },
      {
        ...checked,
        profile: { ...checked.profile, versionSha256: sha("9") },
      },
    ];
    for (const changed of mutations) {
      expect(() => assertGlaedaWorkstationCheckMatchesCommandV1(input, changed)).toThrow(
        /does not match/,
      );
    }
  });

  test("run, lease, authority, and logical change continuity all participate in command identity", () => {
    const input = command();
    const baseline = fingerprintGlaedaWorkstationCommandV1(input);
    const variants = [
      command({ runGeneration: input.runGeneration + 1 }),
      command({ leaseGeneration: input.leaseGeneration + 1 }),
      command({
        authority: { ...input.authority, expiresAt: "2026-08-31T02:01:00.000Z" },
      }),
      command({
        source: { ...input.source, logicalChangeRef: "stensibly:change:successor" },
      }),
    ];
    for (const variant of variants) {
      expect(fingerprintGlaedaWorkstationCommandV1(variant)).not.toBe(baseline);
    }
  });

  test("execution identity is fixed by profile class", () => {
    const query = command();
    expect(() => admitGlaedaWorkstationCheckV1(check(query, {
      executionIdentityClass: "credentialless_project",
    }))).toThrow(/execution identity/);

    const verify = command({
      profile: {
        id: "verify-focused-v1",
        versionSha256: sha("e"),
        class: "verify_focused",
        resourceClass: "interactive-medium",
        deadlineSeconds: 900,
      },
    });
    expect(() => admitGlaedaWorkstationCheckV1(check(verify))).not.toThrow();
    expect(check(verify).executionIdentityClass).toBe("credentialless_project");
  });

  test("rejects unknown profile classes and malformed digests", () => {
    expect(() => normalizeGlaedaWorkstationCommandV1({
      ...command(),
      profile: { ...command().profile, class: "arbitrary_shell" },
    })).toThrow(/profile class/);
    expect(() => normalizeGlaedaWorkstationCommandV1({
      ...command(),
      node: { ...command().node, capabilitySnapshotSha256: "latest" },
    })).toThrow(/capability snapshot/);
  });

  test("receipt timing and result bounds are explicit", () => {
    const input = command();
    const checked = check(input);
    expect(() => admitGlaedaWorkstationReceiptV1(receipt(input, checked, {
      startedAt: "2026-08-31T01:00:02.000Z",
      settledAt: "2026-08-31T01:00:01.000Z",
    }))).toThrow(/settled before/);
    expect(() => admitGlaedaWorkstationReceiptV1(receipt(input, checked, {
      resultBytes: 1_000_001,
    }))).toThrow(/result bytes/);
  });

  test("a receipt for a rewritten exact source never transfers to its logical successor", () => {
    const original = command();
    const checked = check(original);
    const terminal = receipt(original, checked);
    const rewritten = command({
      source: {
        ...original.source,
        commitOid: git("8"),
        treeOid: git("7"),
      },
    });
    expect(() =>
      assertGlaedaWorkstationReceiptMatchesCommandV1(rewritten, checked, terminal)
    ).toThrow(/does not match/);
  });
});
