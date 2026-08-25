import { describe, expect, test } from "bun:test";
import {
  CODEX_ROOT_PUBLICATION_PREFLIGHT_V1,
  adjudicateCodexRootPublicationPreflight,
  type CodexRootPublicationPreflightInputV1,
} from "../src/codex-root-publication-preflight.js";

const before = "1".repeat(40);
const delivery = "2".repeat(40);

function evidence(
  overrides: Partial<CodexRootPublicationPreflightInputV1> = {},
): CodexRootPublicationPreflightInputV1 {
  return {
    version: CODEX_ROOT_PUBLICATION_PREFLIGHT_V1,
    claim: "delivery_ready",
    repository: "teamleaderleo/stensibly",
    deltaClaimed: true,
    headBefore: before,
    deliveryHead: delivery,
    observedChangedPaths: ["src/fix.ts", "test/fix.test.ts"],
    representedChangedPaths: ["src/fix.ts", "test/fix.test.ts"],
    ownerLease: {
      leaseId: "lease-1046",
      generation: 7,
      repository: "teamleaderleo/stensibly",
      intendedRemoteRef: "refs/heads/worker/1046",
    },
    currentOwnerLease: { leaseId: "lease-1046", generation: 7 },
    remoteReadback: {
      ref: "refs/heads/worker/1046",
      head: delivery,
      deliveryHeadReachability: "reachable",
    },
    requiredChecks: [
      { name: "typecheck", outcome: "passed" },
      { name: "focused-tests", outcome: "passed" },
    ],
    ...overrides,
  };
}

describe("Codex root publication preflight", () => {
  test("admits bounded delivery evidence without granting publication authority", () => {
    const result = adjudicateCodexRootPublicationPreflight(evidence());
    expect(result.publicationEligible).toBeTrue();
    expect(result.authorizesPublication).toBeFalse();
    expect(result.denials).toEqual([]);
    expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("rejects the Quarry false-ready shape deterministically", () => {
    const result = adjudicateCodexRootPublicationPreflight(evidence({
      headBefore: before,
      deliveryHead: before,
      representedChangedPaths: [],
      remoteReadback: {
        ref: "refs/heads/worker/1046",
        head: before,
        deliveryHeadReachability: "unknown",
      },
      requiredChecks: [
        { name: "pytest", outcome: "unavailable" },
        { name: "py_compile", outcome: "passed" },
      ],
    }));
    expect(result.publicationEligible).toBeFalse();
    expect(result.denials).toEqual([
      "claimed_delta_without_new_head",
      "worktree_delta_unrepresented",
      "delivery_head_not_reachable",
      "required_check_not_passed",
    ]);
  });

  test("rejects stale lease and wrong remote ref even when checks pass", () => {
    const result = adjudicateCodexRootPublicationPreflight(evidence({
      currentOwnerLease: { leaseId: "lease-1046", generation: 8 },
      remoteReadback: {
        ref: "refs/heads/wrong-owner",
        head: delivery,
        deliveryHeadReachability: "reachable",
      },
    }));
    expect(result.denials).toEqual(["owner_lease_stale", "remote_ref_mismatch"]);
  });

  test("allows incomplete local progress receipts but never calls them publication-ready", () => {
    const result = adjudicateCodexRootPublicationPreflight(evidence({
      claim: "local_blocker",
      deliveryHead: null,
      remoteReadback: {
        ref: "refs/heads/worker/1046",
        head: null,
        deliveryHeadReachability: "unknown",
      },
      requiredChecks: [{ name: "pytest", outcome: "not_executed" }],
    }));
    expect(result.publicationEligible).toBeFalse();
    expect(result.denials).toContain("local_receipt_only");
    expect(result.denials).toContain("required_check_not_passed");
  });

  test("does not treat an empty caller-supplied check policy as verified", () => {
    const result = adjudicateCodexRootPublicationPreflight(evidence({ requiredChecks: [] }));
    expect(result.publicationEligible).toBeFalse();
    expect(result.authorizesPublication).toBeFalse();
    expect(result.denials).toContain("required_check_policy_not_supplied");
  });
});
