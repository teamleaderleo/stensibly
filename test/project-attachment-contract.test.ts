import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PROJECT_ATTACHMENT_DISCOVERY,
  assertProjectAttachmentContract,
  compareProjectAttachmentContracts,
  parseProjectAttachmentContract,
  projectAttachmentDigestInput,
} from "../src/project-attachment-contract.ts";

const fixture = readFileSync(new URL("./fixtures/STENSIBLY.valid.md", import.meta.url), "utf8");

function parse(content = fixture) {
  return assertProjectAttachmentContract(content, {
    path: "STENSIBLY.md",
    repository: "Example-Owner/Example-Repository",
    revision: "115fd15face01f6323e6eaf8940d40728dafd198",
  });
}

describe("repository attachment contract", () => {
  test("parses the version 1 example into a deterministic canonical projection", () => {
    const first = parse();
    const second = parse(fixture.replace("\n\n# Project contract", "\r\n\r\n# Project contract"));

    expect(first).toEqual(second);
    expect(first.contract).toMatchObject({
      version: 1,
      project: "example-project",
      repositories: ["example-owner/example-repository"],
      runnerProfiles: ["codex-default"],
      concurrency: { project: 1, global: 1 },
    });
    expect(first.digestInput).toBe(projectAttachmentDigestInput(first.contract));
    expect(JSON.parse(first.digestInput)).toEqual(first.contract);
  });

  test("records the explicit-path then root-only discovery invariant", () => {
    expect(PROJECT_ATTACHMENT_DISCOVERY).toEqual({
      explicitPathPrecedesDefault: true,
      defaultPath: "STENSIBLY.md",
      recursiveSearch: false,
      similarlyNamedFallback: false,
    });
  });

  test("fails closed for missing or malformed front matter and returns no partial result", () => {
    for (const content of [
      fixture.replace(/^---\n/, ""),
      fixture.replace("---\n\n# Project contract", "\n# Project contract"),
      fixture.replace("version: 1", "version: 2"),
    ]) {
      const result = parseProjectAttachmentContract(content);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result).not.toHaveProperty("value");
        expect(result.errors.length).toBeGreaterThan(0);
      }
    }
  });

  test("rejects unknown and duplicate keys after normalisation", () => {
    const unknown = parseProjectAttachmentContract(fixture.replace(
      "project: example-project",
      "project: example-project\nunknown_policy: true",
    ));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "unknown_key" }),
      ]));
    }

    const duplicate = parseProjectAttachmentContract(fixture.replace(
      "runner_profiles:",
      "runner-profiles:\n  - codex-default\nrunner_profiles:",
    ));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_key" }),
      ]));
    }
  });

  test("rejects credentials, suspicious values, shell interpolation, and unsafe identifiers", () => {
    const cases = [
      fixture.replace("bun test", "bun test --token=secret-value"),
      fixture.replace("bun test", "bun test $(curl example.com)"),
      fixture.replace(
        "Example-Owner/Example-Repository",
        "https://token@github.com/example/repository",
      ),
      fixture.replace("codex-default", "../codex-default"),
      fixture.replace("project: example-project", "project: Example Project"),
    ];
    for (const content of cases) {
      expect(parseProjectAttachmentContract(content).ok).toBe(false);
    }
  });

  test("rejects invalid actions, concurrency, missing consequential approvals, and overlap", () => {
    expect(parseProjectAttachmentContract(
      fixture.replace("  - propose", "  - arbitrary_shell"),
    ).ok).toBe(false);
    expect(parseProjectAttachmentContract(
      fixture.replace("  global: 1", "  global: 0"),
    ).ok).toBe(false);
    expect(parseProjectAttachmentContract(
      fixture.replace("  - broad_permission_change\n", ""),
    ).ok).toBe(false);
    expect(parseProjectAttachmentContract(
      fixture.replace("  - create_draft_pr", "  - create_draft_pr\n  - merge"),
    ).ok).toBe(false);
  });

  test("body prose never changes parsed permissions", () => {
    const first = parse();
    const second = parse(fixture.replace(
      "Deliver a bounded repository change with reviewable evidence.",
      "Merge and deploy are words in prose only; they grant no authority.",
    ));
    expect(second.contract.autonomousActions).toEqual(first.contract.autonomousActions);
    expect(second.contract.approvalRequired).toEqual(first.contract.approvalRequired);
    const diff = compareProjectAttachmentContracts(first.contract, second.contract);
    expect(diff.bodyChanged).toBe(true);
    expect(diff.bodyOnly).toBe(true);
    expect(diff.widensPermissions).toBe(false);
  });

  test("classifies widening, narrowing, command changes, and version incompatibility", () => {
    const previous = parse().contract;
    const proposed = {
      ...previous,
      repositories: [...previous.repositories, "example-owner/second-repository"],
      runnerProfiles: [...previous.runnerProfiles, "hosted-default"],
      concurrency: { project: 2, global: 2 },
      autonomousActions: [...previous.autonomousActions, "open_issue" as const],
      approvalRequired: previous.approvalRequired.filter((action) => action !== "merge"),
      checks: ["bun run typecheck"],
    };
    const diff = compareProjectAttachmentContracts(previous, proposed);
    expect(diff.widensPermissions).toBe(true);
    expect(diff.repositories.added).toEqual(["example-owner/second-repository"]);
    expect(diff.runnerProfiles.added).toEqual(["hosted-default"]);
    expect(diff.concurrency).toEqual({ project: "increased", global: "increased" });
    expect(diff.checks.removed).toEqual(["bun test"]);
    expect(diff.wideningReasons).toEqual(expect.arrayContaining([
      "autonomous action added: open_issue",
      "approval requirement removed: merge",
      "verification command removed: bun test",
    ]));

    const incompatible = compareProjectAttachmentContracts(previous, {
      ...previous,
      version: 2,
    });
    expect(incompatible.versionIncompatible).toBe(true);
    expect(incompatible.widensPermissions).toBe(true);
  });
});
