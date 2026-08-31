import { describe, expect, test } from "bun:test";
import {
  admitGlaedaCapabilityArtifactV1,
  fingerprintGlaedaCapabilitySnapshotV1,
  GLAEDA_CAPABILITY_ARTIFACT_SCHEMA,
} from "../src/glaeda-owned-workstation-capability.ts";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const source = { repository: "teamleaderleo/glaeda", commitOid: "1".repeat(40), treeOid: "2".repeat(40) };
const target = {
  node: {
    id: "air-blue",
    generation: 3,
    osClass: "macos" as const,
    architectureClass: "arm64" as const,
    glaedaRuntimeSha256: sha("a"),
  },
  profileGeneration: sha("c"),
  source,
  python: { executableSha256: sha("b"), version: "3.14.6" },
  now: new Date("2026-08-31T05:01:00.000Z"),
};

describe("owned workstation capability artifact admission", () => {
  test("admits one bounded, fresh, exact, zero-authority snapshot", () => {
    const admitted = admitGlaedaCapabilityArtifactV1([artifact()], target);
    expect(admitted).toEqual({
      snapshotSha256: fingerprintGlaedaCapabilitySnapshotV1(snapshot()),
      observedAt: "2026-08-31T05:00:00.000Z",
      expiresAt: "2026-08-31T05:03:00.000Z",
      heatClass: "resident_hot",
    });
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  test("refuses stale, future, overlong, and authority-bearing snapshots", () => {
    expectRefusal((value) => { value.expiresAt = "2026-08-31T05:01:00.000Z"; }, /stale/);
    expectRefusal((value) => { value.observedAt = "2026-08-31T05:02:00.000Z"; }, /stale/);
    expectRefusal((value) => { value.expiresAt = "2026-08-31T05:06:00.001Z"; }, /validity/);
    expectRefusal((value) => { value.authorizesExecution = true; }, /authority/);
  });

  test("refuses runtime, node, source, profile, and digest drift", () => {
    expectRefusal((value) => { (value.node as Record<string, unknown>).id = "big-red"; }, /physical target/);
    expectRefusal((value) => {
      const producer = value.producer as Record<string, unknown>;
      (producer.python as Record<string, unknown>).version = "3.9.6";
    }, /Python runtime/);
    expectRefusal((value) => {
      const projects = value.projects as Array<Record<string, unknown>>;
      (projects[0]!.source as Record<string, unknown>).commitOid = "3".repeat(40);
    }, /resident source/);
    expectRefusal((value) => {
      const profiles = value.profiles as Array<Record<string, unknown>>;
      profiles[0]!.versionSha256 = sha("0");
    }, /requested profile/);

    const changed = artifact();
    (changed.metadata as Record<string, unknown>).snapshotSha256 = sha("0");
    expect(() => admitGlaedaCapabilityArtifactV1([changed], target)).toThrow(/digest changed/);
    expect(() => admitGlaedaCapabilityArtifactV1([artifact(), artifact()], target)).toThrow(/exactly one/);
  });
});

function expectRefusal(
  change: (value: Record<string, unknown>) => void,
  pattern: RegExp,
): void {
  const value = snapshot();
  change(value);
  const candidate = artifact(value);
  expect(() => admitGlaedaCapabilityArtifactV1([candidate], target)).toThrow(pattern);
}

function artifact(value = snapshot()) {
  const snapshotSha256 = fingerprintGlaedaCapabilitySnapshotV1(value);
  return {
    kind: "other",
    uri: `urn:stensibly:glaeda-capability:${snapshotSha256}`,
    metadata: {
      schema: GLAEDA_CAPABILITY_ARTIFACT_SCHEMA,
      snapshot: value,
      snapshotSha256,
    },
  };
}

function snapshot(): Record<string, unknown> {
  return {
    admission: {
      activeWorkloadsClass: "unobserved",
      availabilityClass: "available",
      pressureClass: "unobserved",
    },
    advisoryOnly: true,
    authorizesDispatch: false,
    authorizesExecution: false,
    expiresAt: "2026-08-31T05:03:00.000Z",
    node: { architectureClass: "arm64", generation: 3, id: "air-blue", osClass: "macos" },
    observedAt: "2026-08-31T05:00:00.000Z",
    producer: {
      glaedaRuntimeSha256: sha("a"),
      python: { executableSha256: sha("b"), version: "3.14.6" },
      workspaceCapabilitySha256: sha("d"),
    },
    profiles: [{ class: "repo_query", id: "repo-query/v1", versionSha256: sha("c") }],
    projects: [{
      heatClass: "resident_hot",
      repository: "teamleaderleo/glaeda",
      source: { commitOid: source.commitOid, treeOid: source.treeOid },
      sourceObjectClass: "exact_commit_and_tree_present",
      verificationProfiles: ["glaeda.doctor", "glaeda.required"],
    }],
    schema: "glaeda-owned-workstation-capability/v1",
  };
}
