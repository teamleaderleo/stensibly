import { describe, expect, test } from "bun:test";
import {
  admitRunnerProfileProvenanceV1,
  compareRunnerProfileProvenanceV1,
  requireExactRunnerProfileResumeV1,
  runnerProfileClaimMatchesV1,
  runnerProfileProvenanceV1,
  runnerProfileRolloverDecisionV1,
} from "../src/runner-profile-provenance.js";

const v1 = () => runnerProfileProvenanceV1("sol-manager", "sol-manager/1");
const v2 = () => runnerProfileProvenanceV1("sol-manager", "sol-manager/2");
const legacy = () => runnerProfileProvenanceV1("sol-manager", null);

describe("runner profile version provenance", () => {
  test("normalizes durable exact and legacy-unknown bindings", () => {
    expect(v1()).toEqual({
      version: 1,
      profileId: "sol-manager",
      profileVersion: "sol-manager/1",
    });
    expect(runnerProfileProvenanceV1(" sol-manager ", undefined)).toEqual({
      version: 1,
      profileId: "sol-manager",
      profileVersion: null,
    });
    expect(Object.isFrozen(v1())).toBe(true);
    expect(admitRunnerProfileProvenanceV1(JSON.parse(JSON.stringify(v1())))).toEqual(v1());
  });

  test("matches claim selection only on the same exact or same unknown version", () => {
    expect(compareRunnerProfileProvenanceV1(v1(), v1())).toBe("exact");
    expect(runnerProfileClaimMatchesV1(v1(), v1())).toBe(true);
    expect(compareRunnerProfileProvenanceV1(legacy(), legacy()))
      .toBe("legacy_unknown_match");
    expect(runnerProfileClaimMatchesV1(legacy(), legacy())).toBe(true);

    expect(compareRunnerProfileProvenanceV1(v1(), v2())).toBe("different_version");
    expect(runnerProfileClaimMatchesV1(v1(), v2())).toBe(false);
    expect(compareRunnerProfileProvenanceV1(v1(), legacy())).toBe("version_unknown");
    expect(runnerProfileClaimMatchesV1(v1(), legacy())).toBe(false);
    expect(compareRunnerProfileProvenanceV1(
      v1(),
      runnerProfileProvenanceV1("luna-worker", "sol-manager/1"),
    )).toBe("different_profile");
  });

  test("requires a fresh run for a changed profile and exact provenance for hot resume", () => {
    expect(runnerProfileRolloverDecisionV1(v1(), v1())).toBe("reuse_current_run");
    expect(runnerProfileRolloverDecisionV1(v1(), v2())).toBe("fresh_run_required");
    expect(runnerProfileRolloverDecisionV1(
      v1(),
      runnerProfileProvenanceV1("luna-worker", "luna-worker/1"),
    )).toBe("fresh_run_required");
    expect(runnerProfileRolloverDecisionV1(v1(), legacy()))
      .toBe("exact_version_required");
    expect(runnerProfileRolloverDecisionV1(legacy(), legacy()))
      .toBe("exact_version_required");

    expect(() => requireExactRunnerProfileResumeV1(v1(), v1())).not.toThrow();
    expect(() => requireExactRunnerProfileResumeV1(v1(), v2()))
      .toThrow("start a fresh run");
    expect(() => requireExactRunnerProfileResumeV1(v1(), legacy()))
      .toThrow("exact durable profile version");
    expect(() => requireExactRunnerProfileResumeV1(legacy(), legacy()))
      .toThrow("exact durable profile version");
  });

  test("rejects ambiguous, hostile, and credential-shaped durable records", () => {
    expect(() => admitRunnerProfileProvenanceV1({
      version: 1,
      profileId: "sol-manager",
    })).toThrow("exact version or null");
    expect(() => admitRunnerProfileProvenanceV1({
      version: 1,
      profileId: "sol-manager",
      profileVersion: null,
      cacheKey: "provider-private",
    })).toThrow("unexpected fields");
    expect(() => runnerProfileProvenanceV1("sol-manager", "stn.tok_secret"))
      .toThrow("invalid");

    let getterReads = 0;
    const hostile: Record<string, unknown> = {
      version: 1,
      profileId: "sol-manager",
      profileVersion: "sol-manager/1",
    };
    Object.defineProperty(hostile, "profileVersion", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "sol-manager/1";
      },
    });
    expect(() => admitRunnerProfileProvenanceV1(hostile)).toThrow("accessors");
    expect(getterReads).toBe(0);
  });
});
