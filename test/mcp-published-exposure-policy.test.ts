import { expect, test } from "bun:test";
import { mcpCapabilityPolicyRegistry } from "../src/mcp-capability-policy.ts";
import { compileMcpCapabilityExposureSelection } from "../src/mcp-exposure-selection.ts";

const publishedDefault = [
  "block_work",
  "claim_work",
  "complete_work",
  "create_item",
  "dispatch_work",
  "get_brief",
  "get_item",
  "get_project_attachment",
  "github_add_issue_comment",
  "github_ci_diagnose",
  "github_create_issue",
  "github_get_issue",
  "github_land_pr",
  "github_publish_change",
  "github_repo_health",
  "github_search_issues",
  "github_update_issue",
  "handoff_work",
  "list_work",
  "unblock_work",
];

const deferredDiscovery = [
  "get_continuation",
  "get_github_project_context",
  "github_branch_tidy",
  "github_call_tool",
  "github_get_tool",
  "github_list_issues",
  "github_list_toolsets",
  "github_search_tools",
  "list_continuation_inbox",
  "list_continuations",
  "propose_continuation",
  "remember_project_repository_setup",
];

const internalOrRunner = [
  "attach_artifact",
  "edit_continuation",
  "enrol_worker",
  "get_github_provider_receipt",
  "get_github_repository_write_receipt",
  "get_operation_receipt",
  "get_operation_workflow",
  "get_runner_context",
  "github_create_branch",
  "github_create_file",
  "github_create_pull_request",
  "github_update_file",
  "list_artifacts",
  "queue_continuation_for_supervisor",
  "reconcile_github_publish_change",
  "record_event",
  "release_work",
  "renew_claim",
  "resolve_continuation",
  "run_continuation_supervisor_policy",
  "survey_workspace",
];

test("curated ChatGPT exposure stays explicit without changing full capability coverage", () => {
  const core = mcpCapabilityPolicyRegistry.policies
    .filter((policy) => policy.defaultExposure === "core")
    .map((policy) => policy.toolName);
  const searchable = mcpCapabilityPolicyRegistry.policies
    .filter((policy) => policy.defaultExposure === "searchable")
    .map((policy) => policy.toolName);
  const hidden = mcpCapabilityPolicyRegistry.policies
    .filter((policy) => policy.defaultExposure === "hidden")
    .map((policy) => policy.toolName);

  expect(core).toEqual(publishedDefault);
  expect(searchable).toEqual(deferredDiscovery);
  expect(hidden).toEqual(internalOrRunner);
  expect([core.length, searchable.length, hidden.length]).toEqual([20, 12, 21]);
  expect(mcpCapabilityPolicyRegistry.policies).toHaveLength(53);

  const published = compileMcpCapabilityExposureSelection(
    mcpCapabilityPolicyRegistry,
    "published_default",
  );
  const discoverable = compileMcpCapabilityExposureSelection(
    mcpCapabilityPolicyRegistry,
    "published_plus_searchable",
  );
  const full = compileMcpCapabilityExposureSelection(
    mcpCapabilityPolicyRegistry,
    "full_internal",
  );

  expect(published.toolNames).toEqual(publishedDefault);
  expect(discoverable.toolNames).toEqual(
    [...publishedDefault, ...deferredDiscovery].sort(),
  );
  expect(full.toolNames).toHaveLength(53);
  expect(full.toolNames).toEqual(
    [...publishedDefault, ...deferredDiscovery, ...internalOrRunner].sort(),
  );
  expect(published.authorizesToolRegistration).toBe(false);
  expect(discoverable.authorizesToolRegistration).toBe(false);
  expect(full.authorizesToolRegistration).toBe(false);
});
