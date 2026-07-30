import { describe, expect, test } from "bun:test";
import {
  compileGitHubCapabilityRegistry,
  githubCapabilityRegistry,
} from "../src/github-capability-curation.ts";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";

describe("curated GitHub capability surface", () => {
  test("keeps the approved tiers unique, immutable, and additive-count agnostic", () => {
    const names = githubCapabilityRegistry.capabilities.map((entry) => entry.name);

    expect(new Set(names).size).toBe(names.length);
    expect(Object.isFrozen(githubCapabilityRegistry)).toBe(true);
    expect(Object.isFrozen(githubCapabilityRegistry.capabilities)).toBe(true);
    for (const required of [
      "fetch_file",
      "search_issues",
      "fetch_pr",
      "fetch_workflow_job_logs",
      "create_branch",
      "merge_pull_request",
    ]) {
      expect(names).toContain(required);
    }
    expect(githubCapabilityRegistry.capabilities
      .find((entry) => entry.name === "create_blob")?.tier).toBe("internal");
    expect(githubCapabilityRegistry.capabilities
      .find((entry) => entry.name === "add_reaction_to_pr")?.tier).toBe("excluded");
  });

  test("rejects duplicate capability names", () => {
    const duplicate = [
      { name: "fetch_file", tier: "essential", skill: "github", readOnly: true },
      { name: "fetch_file", tier: "secondary", skill: "github", readOnly: true },
    ] as const;
    expect(() => compileGitHubCapabilityRegistry({
      version: 1,
      source: "chatgpt-github-connector",
      sourceRevision: "test-source",
      curationRevision: "test-curation",
      capabilities: duplicate.map((entry) => ({ ...entry })),
    })).toThrow("Duplicate GitHub capability: fetch_file");
  });

  test("lists skill bundles and hides the inflection-point tiers by default", () => {
    const service = new GitHubCapabilityCatalogueService();
    const listed = service.listToolsets();

    expect(listed.delegatedDispatchEnabled).toBe(false);
    expect(listed.visibilityPolicy).toEqual({
      defaultVisibleTiers: ["essential"],
      searchableTiers: ["essential", "secondary", "advanced"],
      hiddenTiers: ["internal", "excluded"],
    });
    const publishing = listed.toolsets.find((entry) => entry.name === "publish_changes");
    expect(publishing?.tierCounts.internal).toBe(0);
    expect(service.listToolsets({ includeHidden: true }).toolsets
      .find((entry) => entry.name === "publish_changes")?.tierCounts.internal)
      .toBeGreaterThan(0);
  });

  test("searches across skill and tier while retaining exact first-party bindings", () => {
    const service = new GitHubCapabilityCatalogueService();
    const workflows = service.searchTools({
      query: "workflow logs",
      skills: ["ci_debug"],
      limit: 10,
    });
    expect(workflows.map((entry) => entry.name)).toContain("fetch_workflow_job_logs");

    expect(service.searchTools({ query: "reaction", limit: 20 })).toEqual([]);
    expect(service.searchTools({
      query: "reaction",
      includeHidden: true,
      tiers: ["excluded"],
      limit: 20,
    }).length).toBeGreaterThan(0);

    expect(service.getTool("search_issues")).toMatchObject({
      tier: "essential",
      executionMode: "typed_first_party",
      firstPartyTool: "github_search_issues",
      dispatchEnabled: true,
    });
    expect(service.getTool("fetch_file")).toMatchObject({
      tier: "essential",
      executionMode: "delegated",
      dispatchEnabled: false,
    });
  });
});
