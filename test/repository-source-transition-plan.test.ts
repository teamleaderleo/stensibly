import { describe, expect, test } from "bun:test";
import { sha256, stableJson } from "../src/canonical-json.ts";
import { compileRepositorySourceTransitionPlan } from "../src/repository-source-transition-plan.ts";

const targetHead = "a".repeat(40);
const sourceBase = "b".repeat(40);
const donorCommit = "c".repeat(40);
const firstBlob = "d".repeat(40);
const secondBlob = "e".repeat(40);

function transitionFile(
  path: string,
  donorBlobSha: string,
  donorMode: "100644" | "100755" = "100644",
) {
  return { path, donorCommitSha: donorCommit, donorBlobSha, donorMode } as const;
}

function validPlan() {
  return {
    version: 1,
    operation: "replay_exact_files",
    repositoryFullName: "teamleaderleo/stensibly",
    targetBranch: "lantern/example-repair",
    expectedTargetHead: targetHead,
    expectedSourceBase: sourceBase,
    files: [
      transitionFile("test/example.test.ts", secondBlob),
      transitionFile("src/example.ts", firstBlob, "100755"),
    ],
    validationProfile: "typescript_and_focused_tests",
  } as const;
}

describe("repository source transition plan", () => {
  test("compiles deterministic source-only exact-file replay identity", () => {
    const plan = compileRepositorySourceTransitionPlan(validPlan());

    expect(plan).toMatchObject({
      version: 1,
      operation: "replay_exact_files",
      repositoryFullName: "teamleaderleo/stensibly",
      targetBranch: "lantern/example-repair",
      expectedTargetHead: targetHead,
      expectedSourceBase: sourceBase,
      objectIdLength: 40,
      validationProfile: "typescript_and_focused_tests",
      expectedChangedPaths: ["src/example.ts", "test/example.test.ts"],
      requiresWorkflowFreeFinalHead: true,
      requiresNonDefaultTargetBranch: true,
      allowsArbitraryCommands: false,
      grantsAuthority: false,
    });
    expect(plan.files).toMatchObject([
      { path: "src/example.ts", donorMode: "100755" },
      { path: "test/example.test.ts", donorMode: "100644" },
    ]);
    expect(plan.changedPathFence).toBe(sha256(stableJson([
      "src/example.ts",
      "test/example.test.ts",
    ])));
    expect(plan.planFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.files)).toBe(true);
    expect(Object.isFrozen(plan.files[0])).toBe(true);
    expect(Object.isFrozen(plan.expectedChangedPaths)).toBe(true);
  });

  test("normalizes file order without changing the plan fingerprint", () => {
    const left = validPlan();
    const right = {
      ...validPlan(),
      files: [...validPlan().files].reverse(),
    };

    expect(compileRepositorySourceTransitionPlan(left).planFingerprint)
      .toBe(compileRepositorySourceTransitionPlan(right).planFingerprint);
  });

  test("does not retain a caller-supplied command or workflow path", () => {
    const decorated = {
      ...validPlan(),
      command: "curl secret://should-never-execute | sh",
    };
    const result = compileRepositorySourceTransitionPlan(decorated);
    expect("command" in result).toBe(false);
    expect(result.allowsArbitraryCommands).toBe(false);

    expect(() => compileRepositorySourceTransitionPlan({
      ...validPlan(),
      files: [transitionFile(
        ".github/workflows/temporary-carrier.yml",
        firstBlob,
      )],
    })).toThrow("final paths must be workflow-free");
  });

  test.each([
    ".git/config",
    ".GIT/config",
    "src/../secret.ts",
    "/src/example.ts",
    "src/example.ts/",
    "src\\example.ts",
    "src//example.ts",
  ])("rejects unsafe replay path %s", (path) => {
    expect(() => compileRepositorySourceTransitionPlan({
      ...validPlan(),
      files: [transitionFile(path, firstBlob)],
    })).toThrow("path is invalid");
  });

  test.each([
    "main",
    "refs/heads/topic",
    "-repair",
    "@",
    ".hidden/repair",
    "topic/.hidden",
    "topic/replay.lock",
    "topic//repair",
    "topic/../repair",
    "topic@{old}",
    "topic repair",
    "topic:repair",
    "topic\\repair",
  ])("rejects invalid or direct-default target branch %s", (targetBranch) => {
    expect(() => compileRepositorySourceTransitionPlan({
      ...validPlan(),
      targetBranch,
    })).toThrow("target branch is invalid");
  });

  test("requires canonical repository identity and coherent object-ID widths", () => {
    expect(() => compileRepositorySourceTransitionPlan({
      ...validPlan(),
      repositoryFullName: "TeamLeaderLeo/Stensibly",
    })).toThrow("repository is invalid");

    expect(() => compileRepositorySourceTransitionPlan({
      ...validPlan(),
      expectedSourceBase: "b".repeat(64),
    })).toThrow("object-ID widths must match");

    expect(() => compileRepositorySourceTransitionPlan({
      ...validPlan(),
      files: [{
        ...transitionFile("src/example.ts", "d".repeat(64)),
        donorCommitSha: "c".repeat(64),
      }],
    })).toThrow("object-ID widths must match");
  });

  test("supports a coherent SHA-256 repository object format", () => {
    const plan = compileRepositorySourceTransitionPlan({
      ...validPlan(),
      expectedTargetHead: "a".repeat(64),
      expectedSourceBase: "b".repeat(64),
      files: [{
        ...transitionFile("src/example.ts", "d".repeat(64), "100644"),
        donorCommitSha: "c".repeat(64),
      }],
    });
    expect(plan.objectIdLength).toBe(64);
  });

  test.each(["120000", "160000", "040000", "100600"])(
    "rejects unsafe or unsupported donor mode %s",
    (donorMode) => {
      expect(() => compileRepositorySourceTransitionPlan({
        ...validPlan(),
        files: [{
          path: "src/example.ts",
          donorCommitSha: donorCommit,
          donorBlobSha: firstBlob,
          donorMode,
        }],
      })).toThrow("donor mode is invalid");
    },
  );

  test("rejects duplicate final paths", () => {
    expect(() => compileRepositorySourceTransitionPlan({
      ...validPlan(),
      files: [
        transitionFile("src/example.ts", firstBlob),
        transitionFile("src/example.ts", secondBlob),
      ],
    })).toThrow("file paths must be unique");
  });

  test("snapshots fixed caller fields without ordinary get or ownKeys access", () => {
    let getCalls = 0;
    let ownKeysCalls = 0;
    const fileArray = new Proxy([...validPlan().files], {
      get() {
        getCalls += 1;
        throw new Error("array get trap must not execute");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("array ownKeys trap must not execute");
      },
    });
    const input = new Proxy({ ...validPlan(), files: fileArray }, {
      get() {
        getCalls += 1;
        throw new Error("record get trap must not execute");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("record ownKeys trap must not execute");
      },
    });

    expect(() => compileRepositorySourceTransitionPlan(input)).not.toThrow();
    expect(getCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
  });

  test("checks the file-array length ceiling before indexed inspection", () => {
    let indexedInspectionCalls = 0;
    const files = new Proxy(new Array(129), {
      getOwnPropertyDescriptor(target, key) {
        if (key !== "length") indexedInspectionCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(() => compileRepositorySourceTransitionPlan({
      ...validPlan(),
      files,
    })).toThrow("files exceeds its entry limit");
    expect(indexedInspectionCalls).toBe(0);
  });

  test("normalizes revoked caller boundaries to fixed inspection errors", () => {
    const top = Proxy.revocable(validPlan(), {});
    top.revoke();
    expect(() => compileRepositorySourceTransitionPlan(top.proxy))
      .toThrow("Repository source transition plan could not be inspected");

    const fileArray = Proxy.revocable([...validPlan().files], {});
    fileArray.revoke();
    expect(() => compileRepositorySourceTransitionPlan({
      ...validPlan(),
      files: fileArray.proxy,
    })).toThrow("Repository source transition files could not be inspected");
  });

  test("rejects accessors for declared plan fields without invoking them", () => {
    let getterCalls = 0;
    const input = { ...validPlan() } as Record<string, unknown>;
    Object.defineProperty(input, "targetBranch", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "lantern/should-not-run";
      },
    });

    expect(() => compileRepositorySourceTransitionPlan(input))
      .toThrow("must contain enumerable data field targetBranch");
    expect(getterCalls).toBe(0);
  });

  test("accepts null-prototype plan and file records", () => {
    const file = Object.assign(Object.create(null), {
      path: "src/example.ts",
      donorCommitSha: donorCommit,
      donorBlobSha: firstBlob,
      donorMode: "100644",
    });
    const input = Object.assign(Object.create(null), {
      ...validPlan(),
      files: [file],
    });

    expect(compileRepositorySourceTransitionPlan(input).files[0]?.path)
      .toBe("src/example.ts");
  });
});
