import { describe, expect, test } from "bun:test";
import { githubDelegatedReadContractToolNames } from "../src/github-delegated-read-contracts.ts";
import {
  assertGitHubOfficialMcpReadMappingMatchesPolicy,
  githubOfficialMcpReadMappingPolicy,
  githubOfficialMcpReadSource,
  mapGitHubDelegatedReadToOfficialMcp,
  type GitHubOfficialMcpMappedRead,
  type GitHubOfficialMcpReadMapping,
} from "../src/github-official-mcp-read-mapping.ts";
import {
  sha256,
  stableJson,
} from "../src/github-provider-validation.ts";

const repository = "teamleaderleo/stensibly";
const commitSha = "a".repeat(40);

function map(tool: string, argumentsValue: Record<string, unknown> = {}) {
  return mapGitHubDelegatedReadToOfficialMcp({
    tool,
    arguments: argumentsValue,
    repositoryFullName: repository,
  });
}

function requireMapped(
  mapping: GitHubOfficialMcpReadMapping,
): GitHubOfficialMcpMappedRead {
  if (mapping.state !== "mapped") throw new Error("Expected mapped read");
  return mapping;
}

function expectDivergence(value: unknown): void {
  expect(() => assertGitHubOfficialMcpReadMappingMatchesPolicy(value)).toThrow(
    "GitHub official MCP mapping diverges from its fingerprinted policy",
  );
}

function expectEvidence(
  mapping: GitHubOfficialMcpReadMapping,
  sourceToolSnapshotBlobShas: readonly string[],
): void {
  expect(mapping.authorizesProviderCall).toBe(false);
  expect(mapping.mappingPolicyVersion).toBe(1);
  expect(mapping.mappingPolicyFingerprint).toBe(
    githubOfficialMcpReadMappingPolicy.fingerprint,
  );
  expect(mapping.mappingPolicyFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(mapping.sourceCommitSha).toBe(githubOfficialMcpReadSource.commitSha);
  expect(mapping.sourceToolSnapshotBlobShas).toEqual(
    sourceToolSnapshotBlobShas,
  );
  expect(Object.isFrozen(mapping)).toBe(true);
  expect(Object.isFrozen(mapping.sourceToolSnapshotBlobShas)).toBe(true);
}

describe("official GitHub MCP delegated-read mapping", () => {
  test("binds mappings and policy to exact reviewed upstream snapshots", () => {
    expect(githubOfficialMcpReadSource).toEqual({
      repository: "github/github-mcp-server",
      commitSha: "3778a41476e31a072430cfee7c5d31c5f72def60",
      toolSnapshots: {
        search_repositories: "23b1d5e839bcc543296c91f8224791679ecce769",
        get_file_contents: "dec933c94d6c3e1142d6e7f83ee6778c4c1b13b3",
        pull_request_read: "41bc90b597466504646aa6aac139d6d4908f71b1",
        get_commit: "ad6a805515f53f04e2adf016939a69c2d5b8edbc",
        actions_list: "be97affbdb4e2dcf2afe6e11b0dc934add7c86bd",
        actions_get: "661f379f5f3855bd6edb117f58c9798dca40da8d",
        get_job_logs: "575182c0b146f3a2e37a6db192345a7faa648047",
      },
    });
    expect(githubOfficialMcpReadMappingPolicy).toEqual(
      expect.objectContaining({
        version: 1,
        authorizesProviderCall: false,
        source: githubOfficialMcpReadSource,
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    );
    expect(Object.keys(githubOfficialMcpReadMappingPolicy.rules).sort()).toEqual(
      [...githubDelegatedReadContractToolNames].sort(),
    );
    expect(Object.isFrozen(githubOfficialMcpReadSource)).toBe(true);
    expect(Object.isFrozen(githubOfficialMcpReadSource.toolSnapshots)).toBe(true);
    expect(Object.isFrozen(githubOfficialMcpReadMappingPolicy)).toBe(true);
    expect(Object.isFrozen(githubOfficialMcpReadMappingPolicy.rules)).toBe(true);
    expect(Object.isFrozen(
      githubOfficialMcpReadMappingPolicy.rules.get_repo
        .sourceToolSnapshotBlobShas,
    )).toBe(true);
  });

  test("fingerprints exact positive and negative mapping semantics", () => {
    const { fingerprint, ...definition } = githubOfficialMcpReadMappingPolicy;
    expect(fingerprint).toBe(sha256(stableJson(definition)));

    expect(githubOfficialMcpReadMappingPolicy.rules.get_repo).toEqual(
      expect.objectContaining({
        state: "mapped",
        officialToolset: "repos",
        officialTool: "search_repositories",
        argumentKeys: ["minimal_output", "perPage", "query"],
        fixedArguments: { minimal_output: false, perPage: 1 },
        resultContract: "repository_search_exact",
        maximumResultItems: 1,
      }),
    );
    expect(githubOfficialMcpReadMappingPolicy.rules.get_pr_info).toEqual(
      expect.objectContaining({
        state: "mapped",
        officialToolset: "pull_requests",
        officialTool: "pull_request_read",
        argumentKeys: ["method", "owner", "pullNumber", "repo"],
        fixedArguments: { method: "get" },
        resultContract: "pull_request_exact",
        maximumResultItems: 1,
      }),
    );
    expect(githubOfficialMcpReadMappingPolicy.rules.get_pr_diff).toEqual(
      expect.objectContaining({
        state: "conditional",
        officialToolset: "pull_requests",
        officialTool: "pull_request_read",
        argumentKeys: ["method", "owner", "pullNumber", "repo"],
        fixedArguments: { method: "get_diff" },
        resultContract: "pull_request_diff",
        maximumResultItems: 1,
        unsupportedReason: "patch_format_unavailable",
      }),
    );
    expect(
      githubOfficialMcpReadMappingPolicy.rules.fetch_workflow_job_steps,
    ).toEqual(expect.objectContaining({
      state: "mapped",
      officialToolset: "actions",
      officialTool: "actions_get",
      argumentKeys: ["method", "owner", "repo", "resource_id"],
      fixedArguments: { method: "get_workflow_job" },
      resultContract: "workflow_job_exact",
      maximumResultItems: 1,
    }));
    expect(
      githubOfficialMcpReadMappingPolicy.rules.fetch_workflow_job_logs,
    ).toEqual({
      state: "unsupported",
      reason: "workflow_logs_require_truncation_contract",
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.get_job_logs,
      ],
    });

    for (const rule of [
      githubOfficialMcpReadMappingPolicy.rules.get_repo,
      githubOfficialMcpReadMappingPolicy.rules.get_pr_info,
      githubOfficialMcpReadMappingPolicy.rules.get_pr_diff,
      githubOfficialMcpReadMappingPolicy.rules.fetch_workflow_job_steps,
    ]) {
      expect(Object.isFrozen(rule.argumentKeys)).toBe(true);
      expect(Object.isFrozen(rule.fixedArguments)).toBe(true);
    }
  });

  test("rejects common, mapped, and unsupported policy divergence", () => {
    const mapped = requireMapped(map("get_repo"));
    expectDivergence({
      ...mapped,
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.get_file_contents,
      ],
    });
    expectDivergence({
      ...mapped,
      officialArguments: {
        ...mapped.officialArguments,
        perPage: 2,
      },
    });
    expectDivergence({ ...mapped, authorizesProviderCall: true });

    const unsupported = map("fetch_workflow_job_logs", { job_id: 7001 });
    expectDivergence({
      ...unsupported,
      reason: "patch_format_unavailable",
    });
    expectDivergence({
      ...unsupported,
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
      ],
    });
  });

  test("exact-admits state-specific decisions and ignores no authority fields", () => {
    const mapped = requireMapped(map("get_repo"));
    expectDivergence({ ...mapped, credential: "github_pat_private" });
    expectDivergence({ ...mapped, dispatchAuthorized: true });

    const unsupported = map("fetch_workflow_job_logs", { job_id: 7001 });
    expectDivergence({ ...unsupported, officialArguments: {} });
    expectDivergence({ ...unsupported, approvalId: "approval-1" });

    let reads = 0;
    const hostile = { ...mapped } as Record<string, unknown>;
    Object.defineProperty(hostile, "secret://github/token", {
      enumerable: true,
      get() {
        reads += 1;
        return "credential";
      },
    });
    expectDivergence(hostile);
    expect(reads).toBe(0);
  });

  test("re-admits every dynamic provider selector through the delegated contracts", () => {
    const repositoryRead = requireMapped(map("get_repo"));
    expectDivergence({
      ...repositoryRead,
      officialArguments: {
        ...repositoryRead.officialArguments,
        query: "repo:another-owner/private-repository",
      },
    });

    const file = requireMapped(map("fetch_file", {
      path: "src/index.ts",
      ref: commitSha,
    }));
    for (const officialArguments of [
      { ...file.officialArguments, owner: "another-owner" },
      { ...file.officialArguments, repo: "another-repository" },
      { ...file.officialArguments, path: "../src/index.ts" },
      { ...file.officialArguments, sha: commitSha.toUpperCase() },
    ]) {
      expectDivergence({ ...file, officialArguments });
    }

    const pullRequest = requireMapped(map("get_pr_info", { pr_number: 42 }));
    for (const pullNumber of [0, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectDivergence({
        ...pullRequest,
        officialArguments: {
          ...pullRequest.officialArguments,
          pullNumber,
        },
      });
    }

    const workflowJob = requireMapped(
      map("fetch_workflow_job_steps", { job_id: 7001 }),
    );
    for (const resourceId of ["07001", "7.001", "-1", "9007199254740992"] ) {
      expectDivergence({
        ...workflowJob,
        officialArguments: {
          ...workflowJob.officialArguments,
          resource_id: resourceId,
        },
      });
    }
  });

  test("rejects decorated, sparse, accessor, and oversized snapshot evidence", () => {
    const mapped = requireMapped(map("get_repo"));
    let reads = 0;

    const accessor = [...mapped.sourceToolSnapshotBlobShas];
    Object.defineProperty(accessor, "1", {
      enumerable: true,
      get() {
        reads += 1;
        return commitSha;
      },
    });
    expectDivergence({ ...mapped, sourceToolSnapshotBlobShas: accessor });
    expect(reads).toBe(0);

    const decorated = [...mapped.sourceToolSnapshotBlobShas] as unknown[] & {
      map?: unknown;
    };
    Object.defineProperty(decorated, "map", {
      enumerable: true,
      value: () => [],
    });
    expectDivergence({ ...mapped, sourceToolSnapshotBlobShas: decorated });

    const sparse = [...mapped.sourceToolSnapshotBlobShas];
    sparse.length = 3;
    expectDivergence({ ...mapped, sourceToolSnapshotBlobShas: sparse });

    const oversized = [...mapped.sourceToolSnapshotBlobShas];
    oversized.length = 9;
    expectDivergence({ ...mapped, sourceToolSnapshotBlobShas: oversized });
  });

  test("maps repository and file reads as non-authorizing compatibility data", () => {
    const repositoryRead = map("get_repo");
    expect(repositoryRead).toEqual(expect.objectContaining({
      state: "mapped",
      officialToolset: "repos",
      officialTool: "search_repositories",
      officialArguments: {
        query: `repo:${repository}`,
        perPage: 1,
        minimal_output: false,
      },
      resultContract: "repository_search_exact",
      maximumResultItems: 1,
    }));
    expectEvidence(repositoryRead, [
      githubOfficialMcpReadSource.toolSnapshots.search_repositories,
    ]);

    const file = map("fetch_file", {
      path: "src/index.ts",
      ref: commitSha.toUpperCase(),
    });
    expect(file).toEqual(expect.objectContaining({
      state: "mapped",
      officialToolset: "repos",
      officialTool: "get_file_contents",
      officialArguments: {
        owner: "teamleaderleo",
        repo: "stensibly",
        path: "src/index.ts",
        sha: commitSha,
      },
      resultContract: "repository_file_at_commit",
      maximumResultItems: 1,
    }));
    expectEvidence(file, [
      githubOfficialMcpReadSource.toolSnapshots.get_file_contents,
    ]);
    if (file.state === "mapped") {
      expect(Object.isFrozen(file.officialArguments)).toBe(true);
    }
  });

  test("requires the exact file commit revision before mapping", () => {
    expect(() => map("fetch_file", { path: "README.md" })).toThrow(
      "GitHub commit SHA must be a string",
    );
  });

  test("maps exact pull-request reads and keeps patch format fail closed", () => {
    const info = map("get_pr_info", { pr_number: 42 });
    expect(info).toEqual(expect.objectContaining({
      state: "mapped",
      officialToolset: "pull_requests",
      officialTool: "pull_request_read",
      officialArguments: {
        method: "get",
        owner: "teamleaderleo",
        repo: "stensibly",
        pullNumber: 42,
      },
      resultContract: "pull_request_exact",
      maximumResultItems: 1,
    }));
    expectEvidence(info, [
      githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
    ]);

    const diff = map("get_pr_diff", { pr_number: 42 });
    expect(diff).toEqual(expect.objectContaining({
      state: "mapped",
      officialArguments: {
        method: "get_diff",
        owner: "teamleaderleo",
        repo: "stensibly",
        pullNumber: 42,
      },
      resultContract: "pull_request_diff",
      maximumResultItems: 1,
    }));
    expectEvidence(diff, [
      githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
    ]);

    const patch = map("get_pr_diff", { pr_number: 42, format: "patch" });
    expect(patch).toEqual(expect.objectContaining({
      state: "unsupported",
      stensiblyTool: "get_pr_diff",
      repositoryFullName: repository,
      reason: "patch_format_unavailable",
    }));
    expectEvidence(patch, [
      githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
    ]);
  });

  test("keeps unpaged review-thread and workflow-job reads unsupported", () => {
    const reviewThreads = map(
      "list_pull_request_review_threads",
      { pr_number: 42 },
    );
    expect(reviewThreads).toEqual(expect.objectContaining({
      state: "unsupported",
      reason: "review_threads_require_pagination_contract",
    }));
    expectEvidence(reviewThreads, [
      githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
    ]);

    const workflowJobs = map("fetch_workflow_run_jobs", { run_id: 9001 });
    expect(workflowJobs).toEqual(expect.objectContaining({
      state: "unsupported",
      reason: "workflow_jobs_require_pagination_contract",
    }));
    expectEvidence(workflowJobs, [
      githubOfficialMcpReadSource.toolSnapshots.actions_list,
    ]);
  });

  test("maps exact workflow-job detail only", () => {
    const steps = map("fetch_workflow_job_steps", { job_id: 7001 });
    expect(steps).toEqual(expect.objectContaining({
      state: "mapped",
      officialToolset: "actions",
      officialTool: "actions_get",
      officialArguments: {
        method: "get_workflow_job",
        owner: "teamleaderleo",
        repo: "stensibly",
        resource_id: "7001",
      },
      resultContract: "workflow_job_exact",
      maximumResultItems: 1,
    }));
    expectEvidence(steps, [
      githubOfficialMcpReadSource.toolSnapshots.actions_get,
    ]);
  });

  test("attributes every unresolved semantic gap to exact source blobs", () => {
    const status = map("get_commit_combined_status", {
      commit_sha: commitSha,
    });
    expect(status).toEqual(expect.objectContaining({
      state: "unsupported",
      reason: "commit_status_requires_pull_request",
    }));
    expectEvidence(status, [
      githubOfficialMcpReadSource.toolSnapshots.get_commit,
      githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
    ]);

    const workflowRuns = map("fetch_commit_workflow_runs", {
      commit_sha: commitSha,
    });
    expect(workflowRuns).toEqual(expect.objectContaining({
      state: "unsupported",
      reason: "workflow_runs_lack_commit_filter",
    }));
    expectEvidence(workflowRuns, [
      githubOfficialMcpReadSource.toolSnapshots.actions_list,
    ]);

    const logs = map("fetch_workflow_job_logs", { job_id: 7001 });
    expect(logs).toEqual(expect.objectContaining({
      state: "unsupported",
      reason: "workflow_logs_require_truncation_contract",
    }));
    expectEvidence(logs, [
      githubOfficialMcpReadSource.toolSnapshots.get_job_logs,
    ]);
  });

  test("admits repository bytes before GitHub alias canonicalization", () => {
    for (const repositoryFullName of [
      " teamleaderleo/stensibly",
      "teamleaderleo/stensibly ",
      "ＴeamLeaderLeo/Stensibly",
      "https://ｇithub.com/TeamLeaderLeo/Stensibly.git",
    ]) {
      expect(() => mapGitHubDelegatedReadToOfficialMcp({
        tool: "get_repo",
        arguments: {},
        repositoryFullName,
      })).toThrow(
        "must use exact printable ASCII without whitespace",
      );
    }

    const mixedCase = mapGitHubDelegatedReadToOfficialMcp({
      tool: "get_repo",
      arguments: {},
      repositoryFullName: "TeamLeaderLeo/Stensibly",
    });
    expect(mixedCase.repositoryFullName).toBe(repository);
    expect(mixedCase.authorizesProviderCall).toBe(false);

    const asciiUrl = mapGitHubDelegatedReadToOfficialMcp({
      tool: "GET_REPO",
      arguments: {},
      repositoryFullName: "https://github.com/TeamLeaderLeo/Stensibly.git",
    });
    expect(asciiUrl.repositoryFullName).toBe(repository);
    expect(asciiUrl.authorizesProviderCall).toBe(false);
  });

  test("rejects caller repository selectors inside delegated arguments", () => {
    expect(() => map("fetch_file", {
      path: "README.md",
      ref: commitSha,
      owner: "attacker",
    })).toThrow("cannot override the accepted repository binding");
  });

  test("re-admits top-level input without invoking accessors", () => {
    let reads = 0;
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "tool", {
      enumerable: true,
      get() {
        reads += 1;
        return "get_repo";
      },
    });
    Object.defineProperty(input, "arguments", {
      enumerable: true,
      value: {},
    });
    Object.defineProperty(input, "repositoryFullName", {
      enumerable: true,
      value: repository,
    });

    expect(() => mapGitHubDelegatedReadToOfficialMcp(input)).toThrow(
      "contains an unknown or invalid field",
    );
    expect(reads).toBe(0);
  });

  test("hides arbitrary top-level field names in admission diagnostics", () => {
    const privateField = "secret://github/private-key";
    const input = {
      tool: "get_repo",
      arguments: {},
      repositoryFullName: repository,
      [privateField]: "credential",
    };
    let error: unknown;
    try {
      mapGitHubDelegatedReadToOfficialMcp(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(
      "GitHub official MCP read mapping input contains an unknown or invalid field",
    );
    expect((error as Error).message).not.toContain(privateField);
  });

  test("re-admits caller arguments without invoking accessors", () => {
    let reads = 0;
    const argumentsValue = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(argumentsValue, "path", {
      enumerable: true,
      get() {
        reads += 1;
        return "README.md";
      },
    });
    Object.defineProperty(argumentsValue, "ref", {
      enumerable: true,
      value: commitSha,
    });

    expect(() => mapGitHubDelegatedReadToOfficialMcp({
      tool: "fetch_file",
      arguments: argumentsValue,
      repositoryFullName: repository,
    })).toThrow("must be an enumerable data property");
    expect(reads).toBe(0);
  });
});
