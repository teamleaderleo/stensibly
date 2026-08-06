import { describe, expect, test } from "bun:test";
import {
  GitHubRepositoryWritePostEffectError,
} from "../src/github-repository-write-post-effect-error.ts";

const commitSha = "a".repeat(40);
const parentSha = "b".repeat(40);

function errorWith(overrides: Record<string, unknown> = {}) {
  return new GitHubRepositoryWritePostEffectError({
    code: "repository_write_effect_readback_incomplete",
    result: {
      commitSha,
      parentSha,
      targetRef: "topic/post-effect",
      providerRequestId: "REQ-POST-EFFECT-1",
      ...overrides,
    },
  });
}

describe("repository write post-effect carried identity admission", () => {
  test("preserves one canonical branch and credential-safe request ID", () => {
    const error = errorWith();

    expect(error.code).toBe("repository_write_effect_readback_incomplete");
    expect(error.result).toEqual({
      commitSha,
      parentSha,
      targetRef: "topic/post-effect",
      providerRequestId: "REQ-POST-EFFECT-1",
    });
    expect(Object.isFrozen(error.result)).toBe(true);
    expect(Object.isFrozen(error)).toBe(true);
  });

  test("rejects authorization-header-shaped request identity without retaining it", () => {
    const hostile = "authorization:token";
    let thrown: unknown;

    try {
      errorWith({ providerRequestId: hostile });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain(hostile);
    expect(JSON.stringify(thrown)).not.toContain(hostile);
  });

  test.each([
    "HEAD",
    "refs/heads/main",
    "-topic",
    ".hidden/main",
    "topic.lock",
    "topic with space",
    "topic:colon",
  ])("rejects non-canonical carried target ref %s", (targetRef) => {
    let thrown: unknown;

    try {
      errorWith({ targetRef });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain(targetRef);
    expect(JSON.stringify(thrown)).not.toContain(targetRef);
  });
});
