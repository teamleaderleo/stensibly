import { describe, expect, test } from "bun:test";
import {
  GitHubDelegatedReadContractError,
  parseGitHubDelegatedReadArguments,
} from "../src/github-delegated-read-contracts.ts";

const commitSha = "a".repeat(40);

describe("GitHub delegated read argument admission", () => {
  test("copies enumerable data properties without invoking accessors", () => {
    let reads = 0;
    const input = {} as Record<string, unknown>;
    Object.defineProperty(input, "path", {
      enumerable: true,
      get() {
        reads += 1;
        return "README.md";
      },
    });

    expect(() => parseGitHubDelegatedReadArguments("fetch_file", input))
      .toThrow("field path must be an enumerable data property");
    expect(reads).toBe(0);
  });

  test("rejects hidden repository selectors and symbol fields", () => {
    const hiddenSelector = { path: "README.md", ref: commitSha };
    Object.defineProperty(hiddenSelector, "repository_full_name", {
      enumerable: false,
      value: "other/repository",
    });
    expect(() => parseGitHubDelegatedReadArguments("fetch_file", hiddenSelector))
      .toThrow("field repository_full_name must be an enumerable data property");

    const symbolic = { path: "README.md", ref: commitSha };
    Object.defineProperty(symbolic, Symbol("repository"), {
      enumerable: true,
      value: "other/repository",
    });
    expect(() => parseGitHubDelegatedReadArguments("fetch_file", symbolic))
      .toThrow("contains a symbol field");
  });

  test("retains canonical null-prototype JSON arguments", () => {
    const input = Object.assign(Object.create(null), {
      path: "docs/current-wave.md",
      ref: commitSha,
    });
    const admitted = parseGitHubDelegatedReadArguments("fetch_file", input);
    expect(admitted).toEqual({
      path: "docs/current-wave.md",
      ref: commitSha,
    });
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  test("requires an immutable full commit ref for file reads", () => {
    expect(() => parseGitHubDelegatedReadArguments("fetch_file", {
      path: "README.md",
    })).toThrow("commit SHA must be a string");
    expect(() => parseGitHubDelegatedReadArguments("fetch_file", {
      path: "README.md",
      ref: "main",
    })).toThrow("exactly 40 hexadecimal characters");

    const uppercase = commitSha.toUpperCase();
    expect(parseGitHubDelegatedReadArguments("fetch_file", {
      path: "README.md",
      ref: uppercase,
    })).toEqual({ path: "README.md", ref: commitSha });
  });

  test("rejects normalized tool and commit aliases", () => {
    for (const tool of [" fetch_file", "fetch_file ", "ｆetch_file"]) {
      expect(() => parseGitHubDelegatedReadArguments(tool, {
        path: "README.md",
        ref: commitSha,
      })).toThrow();
    }
    for (const ref of [` ${commitSha}`, `${commitSha} `]) {
      expect(() => parseGitHubDelegatedReadArguments("fetch_file", {
        path: "README.md",
        ref,
      })).toThrow("without surrounding whitespace");
    }
  });

  test("uses the typed contract error for every rejected descriptor form", () => {
    const hidden = { ref: commitSha };
    Object.defineProperty(hidden, "path", {
      enumerable: false,
      value: "README.md",
    });
    try {
      parseGitHubDelegatedReadArguments("fetch_file", hidden);
      throw new Error("Expected delegated read argument rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubDelegatedReadContractError);
    }
  });
});
