import { describe, expect, test } from "bun:test";
import { githubGraphqlUrl } from "../src/github-update-refs-cas.ts";

describe("GitHub updateRefs GraphQL API base transport security", () => {
  test("rejects non-local HTTP API bases", () => {
    for (const value of [
      "http://api.github.com",
      "http://github.example.com/api/v3",
      "http://192.0.2.1/api/v3",
    ]) {
      expect(() => githubGraphqlUrl(value))
        .toThrow("GitHub API base URL is invalid");
    }
  });

  test("preserves the explicit localhost HTTP test seam", () => {
    expect(githubGraphqlUrl("http://localhost:8787/api/v3").href)
      .toBe("http://localhost:8787/api/graphql");
  });

  test("rejects a non-string API base without caller coercion", () => {
    let coercions = 0;
    const hostile = {
      toString() {
        coercions += 1;
        throw new Error("caller conversion must not run");
      },
    };
    expect(() => githubGraphqlUrl(hostile as never))
      .toThrow("GitHub API base URL is invalid");
    expect(coercions).toBe(0);
  });
});
