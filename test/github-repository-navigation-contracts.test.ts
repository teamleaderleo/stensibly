import { describe, expect, test } from "bun:test";
import {
  GitHubDelegatedReadContractError,
  parseGitHubDelegatedReadArguments,
  supportsGitHubDelegatedReadContract,
} from "../src/github-delegated-read-contracts.ts";

const commitSha = "a".repeat(40);

describe("GitHub repository navigation delegated contracts", () => {
  test("admits explicit root and nested immutable directory reads", () => {
    expect(parseGitHubDelegatedReadArguments("list_directory", {
      path: "",
      ref: commitSha.toUpperCase(),
    })).toEqual({ path: "", ref: commitSha });
    expect(parseGitHubDelegatedReadArguments("list_directory", {
      path: "src/providers",
      ref: commitSha,
    })).toEqual({ path: "src/providers", ref: commitSha });
  });

  test("admits only fully-qualified branch and tag refs", () => {
    for (const ref of [
      "refs/heads/main",
      "refs/heads/feature/navigation",
      "refs/tags/v1.2.3",
      "refs/tags/releases/2026-08",
    ]) {
      expect(parseGitHubDelegatedReadArguments("resolve_ref", { ref }))
        .toEqual({ ref });
    }
    for (const ref of [
      "main",
      "v1.2.3",
      "refs/remotes/origin/main",
      "refs/heads/../main",
      "refs/heads/.hidden",
      "refs/tags/release.lock",
      "refs/heads/feature@{1}",
      " refs/heads/main",
    ]) {
      expect(() => parseGitHubDelegatedReadArguments("resolve_ref", { ref }))
        .toThrow(GitHubDelegatedReadContractError);
    }
  });

  test("rejects mutable directory refs, path escapes, and repository overrides", () => {
    for (const argumentsValue of [
      { path: ".", ref: commitSha },
      { path: "../src", ref: commitSha },
      { path: "/src", ref: commitSha },
      { path: "src/", ref: commitSha },
      { path: "src", ref: "main" },
      { path: "src", ref: commitSha, repository: "other/repo" },
    ]) {
      expect(() => parseGitHubDelegatedReadArguments("list_directory", argumentsValue))
        .toThrow(GitHubDelegatedReadContractError);
    }
  });

  test("advertises both navigation contracts", () => {
    expect(supportsGitHubDelegatedReadContract("list_directory")).toBe(true);
    expect(supportsGitHubDelegatedReadContract("resolve_ref")).toBe(true);
  });
});
