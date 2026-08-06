import { describe, expect, test } from "bun:test";
import {
  GitHubRepositoryWritePostEffectError,
} from "../src/github-repository-write-post-effect-error.ts";

const commitSha = "a".repeat(40);
const parentSha = "b".repeat(40);
const targetRef = "topic/post-effect";

function result(overrides: Record<string, unknown> = {}) {
  return {
    commitSha,
    parentSha,
    targetRef,
    providerRequestId: "REQ-POST-EFFECT",
    ...overrides,
  };
}

function create(overrides: Record<string, unknown> = {}) {
  return new GitHubRepositoryWritePostEffectError({
    code: "repository_write_effect_readback_incomplete",
    result: result(overrides),
  });
}

describe("GitHub repository write post-effect evidence admission", () => {
  test("retains one exact frozen provider result", () => {
    const error = create();
    expect(error).toMatchObject({
      code: "repository_write_effect_readback_incomplete",
      result: {
        commitSha,
        parentSha,
        targetRef,
        providerRequestId: "REQ-POST-EFFECT",
      },
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.result)).toBe(true);
  });

  test("preserves optional parent and request evidence only when supplied", () => {
    const error = new GitHubRepositoryWritePostEffectError({
      code: "repository_write_effect_readback_incomplete",
      result: { commitSha, targetRef },
    });
    expect(error.result).toEqual({ commitSha, targetRef });
    expect(Object.hasOwn(error.result, "parentSha")).toBe(false);
    expect(Object.hasOwn(error.result, "providerRequestId")).toBe(false);
  });

  test("rejects invalid target refs through shared repository-write admission", () => {
    for (const value of [
      "HEAD",
      "refs/heads/main",
      " topic/post-effect",
      "topic//post-effect",
      "topic/.hidden",
      "topic/post-effect.lock",
    ]) {
      expect(() => create({ targetRef: value })).toThrow(
        "GitHub repository write post-effect evidence is invalid",
      );
    }
  });

  test("rejects every shared credential family without echo", () => {
    const secrets = [
      `github_pat_${"a".repeat(20)}`,
      `ghp_${"b".repeat(20)}`,
      `sk-proj-${"c".repeat(20)}`,
      `stn.tok_${"d".repeat(12)}`,
      `stn.svc_${"e".repeat(12)}`,
      `xoxb-${"f".repeat(16)}`,
      `Bearer ${"g".repeat(12)}`,
      "secret://github/app-key",
      "authorization: token",
      `eyJ${"h".repeat(8)}.eyJ${"i".repeat(8)}.${"j".repeat(8)}`,
      "-----BEGIN PRIVATE KEY-----",
    ];

    for (const secret of secrets) {
      let observed: unknown;
      try {
        create({ providerRequestId: `request-${secret}` });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(TypeError);
      expect((observed as Error).message).toBe(
        "GitHub repository write post-effect evidence is invalid",
      );
      expect((observed as Error).message).not.toContain(secret);
      expect(JSON.stringify(observed)).not.toContain(secret);
    }
  });

  test("rejects malformed required fields without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = result();
    Object.defineProperty(accessor, "commitSha", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return commitSha;
      },
    });
    expect(() => new GitHubRepositoryWritePostEffectError({
      code: "repository_write_effect_readback_incomplete",
      result: accessor,
    })).toThrow("GitHub repository write post-effect evidence is invalid");
    expect(getterCalls).toBe(0);

    const custom = Object.create({ inherited: true });
    Object.assign(custom, result());
    for (const value of [
      { ...result(), commitSha: "a".repeat(39) },
      { ...result(), parentSha: "B".repeat(40) },
      custom,
    ]) {
      expect(() => new GitHubRepositoryWritePostEffectError({
        code: "repository_write_effect_readback_incomplete",
        result: value,
      })).toThrow("GitHub repository write post-effect evidence is invalid");
    }
  });

  test("projects fixed fields without caller-owned key enumeration", () => {
    let outerOwnKeysCalls = 0;
    let resultOwnKeysCalls = 0;
    const resultTarget = {
      ...result(),
      unrelated: "must-not-retain",
      [Symbol("hidden-result")]: "must-not-retain",
    };
    const resultValue = new Proxy(resultTarget, {
      ownKeys() {
        resultOwnKeysCalls += 1;
        throw new Error("result ownKeys must remain unused");
      },
    });
    const outerTarget = {
      code: "repository_write_effect_readback_incomplete",
      result: resultValue,
      unrelated: "must-not-retain",
      [Symbol("hidden-outer")]: "must-not-retain",
    };
    const outerValue = new Proxy(outerTarget, {
      ownKeys() {
        outerOwnKeysCalls += 1;
        throw new Error("outer ownKeys must remain unused");
      },
    });

    const error = new GitHubRepositoryWritePostEffectError(outerValue);

    expect(error.result).toEqual({
      commitSha,
      targetRef,
      parentSha,
      providerRequestId: "REQ-POST-EFFECT",
    });
    expect(outerOwnKeysCalls).toBe(0);
    expect(resultOwnKeysCalls).toBe(0);
    expect(JSON.stringify(error)).not.toContain("must-not-retain");
  });

  test("preserves benign short token-like request aliases", () => {
    expect(create({
      providerRequestId: "REQ-ghp-review-stn.svc-review-Bearer-review",
    }).result.providerRequestId).toBe(
      "REQ-ghp-review-stn.svc-review-Bearer-review",
    );
  });
});
