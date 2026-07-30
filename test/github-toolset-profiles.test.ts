import { describe, expect, test } from "bun:test";
import {
  githubUpstreamToolsets,
  resolveGitHubToolsetProfile,
} from "../src/github-toolset-profiles.ts";

describe("GitHub toolset profiles", () => {
  test("tracks the official toolset inventory without a fixed count contract", () => {
    const names = githubUpstreamToolsets.map((toolset) => toolset.name);

    expect(new Set(names).size).toBe(names.length);
    for (const requiredName of [
      "actions",
      "issues",
      "projects",
      "pull_requests",
      "repos",
      "users",
    ]) {
      expect(names).toContain(requiredName);
    }
    expect(names).not.toContain("default");
    expect(names).not.toContain("all");
  });

  test("resolves the remote all profile from the inventory", () => {
    const profile = resolveGitHubToolsetProfile("all", "remote");

    expect(profile.toolsets).toEqual(
      githubUpstreamToolsets.map((toolset) => toolset.name),
    );
    expect(profile.omittedToolsets).toEqual([]);
    expect(profile.readOnly).toBe(false);
    expect(profile.requiresOperatorApproval).toBe(true);
  });

  test("removes remote-only toolsets from local sidecar profiles", () => {
    const profile = resolveGitHubToolsetProfile("read_only", "local");

    expect(profile.toolsets).not.toContain("copilot_spaces");
    expect(profile.toolsets).not.toContain("github_support_docs_search");
    expect(profile.omittedToolsets).toEqual([
      "copilot_spaces",
      "github_support_docs_search",
    ]);
    expect(profile.readOnly).toBe(true);
  });

  test("keeps focused profiles compact", () => {
    expect(resolveGitHubToolsetProfile("actions", "remote").toolsets).toEqual([
      "actions",
    ]);
    expect(resolveGitHubToolsetProfile("projects", "remote").toolsets).toEqual([
      "projects",
    ]);
    expect(resolveGitHubToolsetProfile("notifications", "remote").toolsets).toEqual([
      "notifications",
    ]);
  });
});
