import { describe, expect, test } from "bun:test";
import { githubCapabilityRegistry } from "../src/github-capability-curation.ts";
import {
  compareGitHubLiveConnectorObservation,
  compileGitHubLiveConnectorObservation,
  githubLiveConnectorDrift,
  githubLiveConnectorObservation,
} from "../src/github-live-connector-observation.ts";

describe("live ChatGPT GitHub connector observation", () => {
  test("pins the observed 2026-08-10 connector inventory immutably", () => {
    expect(githubLiveConnectorObservation.observedAt).toBe("2026-08-10");
    expect(githubLiveConnectorObservation.toolNames).toHaveLength(89);
    expect(Object.isFrozen(githubLiveConnectorObservation)).toBe(true);
    expect(Object.isFrozen(githubLiveConnectorObservation.toolNames)).toBe(true);
    expect(githubLiveConnectorObservation.toolNames).toContain("fetch_workflow_job_logs");
    expect(githubLiveConnectorObservation.toolNames).toContain("merge_pull_request");
  });

  test("reports curated capabilities missing from the live connector explicitly", () => {
    expect(githubCapabilityRegistry.capabilities).toHaveLength(101);
    expect(githubLiveConnectorDrift.liveAndCurated).toHaveLength(89);
    expect(githubLiveConnectorDrift.liveButUncurated).toEqual([]);
    expect(githubLiveConnectorDrift.curatedButLiveMissing).toEqual([
      "branch_tidy",
      "check_repo_initialized",
      "ci_diagnose",
      "get_commit_diff",
      "get_repo_installation_id",
      "land_pr",
      "list_commits",
      "list_directory",
      "oai_user_fetch",
      "oai_user_search",
      "repo_health",
      "resolve_ref",
    ]);
    expect(Object.isFrozen(githubLiveConnectorDrift)).toBe(true);
    expect(Object.isFrozen(githubLiveConnectorDrift.curatedButLiveMissing)).toBe(true);
  });

  test("canonicalizes tool ordering before fingerprinting", () => {
    const forward = compileGitHubLiveConnectorObservation({
      version: 1,
      source: "chatgpt-github-connector",
      sourceRevision: "test-observation",
      observedAt: "2026-08-10",
      toolNames: ["fetch_file", "get_repo"],
    });
    const reverse = compileGitHubLiveConnectorObservation({
      version: 1,
      source: "chatgpt-github-connector",
      sourceRevision: "test-observation",
      observedAt: "2026-08-10",
      toolNames: ["get_repo", "fetch_file"],
    });

    expect(reverse.toolNames).toEqual(["fetch_file", "get_repo"]);
    expect(reverse.fingerprint).toBe(forward.fingerprint);
    expect(compareGitHubLiveConnectorObservation(reverse).liveButUncurated).toEqual([]);
  });

  test("rejects duplicate and non-canonical tool observations", () => {
    expect(() => compileGitHubLiveConnectorObservation({
      version: 1,
      source: "chatgpt-github-connector",
      sourceRevision: "test-observation",
      observedAt: "2026-08-10",
      toolNames: ["fetch_file", "fetch_file"],
    })).toThrow("tool names must be unique");

    expect(() => compileGitHubLiveConnectorObservation({
      version: 1,
      source: "chatgpt-github-connector",
      sourceRevision: "test-observation",
      observedAt: "2026-08-10",
      toolNames: [" fetch_file"],
    })).toThrow("without surrounding whitespace");
  });
});
