import { describe, expect, test } from "bun:test";
import {
  githubToolsetProfileNames,
  githubUpstreamToolsets,
  resolveGitHubToolsetProfile,
  type GitHubProviderMode,
  type GitHubToolsetProfileName,
} from "../src/github-toolset-profiles.ts";

describe("GitHub toolset profiles", () => {
  test("tracks the official toolset inventory without a fixed count contract", () => {
    const names = githubUpstreamToolsets.map((toolset) => toolset.name);

    for (const requiredName of [
      "actions",
      "issues",
      "projects",
      "pull_requests",
      "repos",
      "users",
    ] as const) {
      expect(names).toContain(requiredName);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("default");
    expect(names).not.toContain("all");
    expect(Object.isFrozen(githubUpstreamToolsets)).toBe(true);
    expect(Object.isFrozen(githubUpstreamToolsets[0])).toBe(true);
    expect(Object.isFrozen(githubToolsetProfileNames)).toBe(true);
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

  test("rejects unknown profile names and provider modes deliberately", () => {
    expect(() => resolveGitHubToolsetProfile(
      "destructive" as GitHubToolsetProfileName,
      "remote",
    )).toThrow("GitHub toolset profile name is invalid");
    expect(() => resolveGitHubToolsetProfile(
      "default",
      "cloud" as GitHubProviderMode,
    )).toThrow("GitHub provider mode must be local or remote");
    expect(() => resolveGitHubToolsetProfile(
      null as unknown as GitHubToolsetProfileName,
      "remote",
    )).toThrow("GitHub toolset profile name is invalid");
  });

  test("freezes resolved profiles and isolates repeated resolution", () => {
    const first = resolveGitHubToolsetProfile("read_only", "remote");
    const second = resolveGitHubToolsetProfile("read_only", "remote");

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.toolsets)).toBe(true);
    expect(Object.isFrozen(first.omittedToolsets)).toBe(true);
    expect(first.toolsets).not.toBe(second.toolsets);
    expect(first.omittedToolsets).not.toBe(second.omittedToolsets);

    expect(() => {
      (first.toolsets as string[]).push("made_up");
    }).toThrow(TypeError);
    expect(() => {
      (first as { readOnly: boolean }).readOnly = false;
    }).toThrow(TypeError);
    expect(() => {
      (githubUpstreamToolsets as unknown as Array<{ name: string }>)[0]!.name = "changed";
    }).toThrow(TypeError);

    expect(resolveGitHubToolsetProfile("read_only", "remote")).toEqual(second);
    expect(githubUpstreamToolsets[0]?.name).toBe("actions");
  });
});
