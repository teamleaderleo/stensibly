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
const metadata = {
  path: "STENSIBLY.md",
  repository: "Example-Owner/Example-Repository",
  revision: "115fd15face01f6323e6eaf8940d40728dafd198",
};
function parse(content = fixture) {
  return assertProjectAttachmentContract(content, metadata);
}
function expectInvalid(content: string) {
  const result = parseProjectAttachmentContract(content);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result).not.toHaveProperty("value");
  return result;
}

describe("repository attachment contract", () => {
  test("canonicalises equivalent version 1 input deterministically", () => {
    const first = parse();
    const newlineEquivalent = parse(fixture.replace("\n\n# Project contract", "\r\n\r\n# Project contract"));
    const setOrderEquivalent = parse(fixture
      .replace(
        "  - inspect\n  - propose\n  - create_draft_pr",
        "  - create_draft_pr\n  - inspect\n  - propose",
      )
      .replace(
        "  - merge\n  - deploy\n  - external_message\n  - provider_change\n  - broad_permission_change\n  - credential_change\n  - destructive_cleanup\n  - spend",
        "  - spend\n  - credential_change\n  - provider_change\n  - broad_permission_change\n  - deploy\n  - destructive_cleanup\n  - merge\n  - external_message",
      ));

    expect(first).toEqual(newlineEquivalent);
    expect(first.digestInput).toBe(setOrderEquivalent.digestInput);
    expect(first.contract).toMatchObject({
      version: 1,
      project: "example-project",
      repositories: ["example-owner/example-repository"],
      runnerProfiles: ["codex-default"],
      concurrency: { project: 1, global: 1 },
      checks: ["typecheck", "unit-tests"],
    });
    expect(first.source.repository).toBe("example-owner/example-repository");
    expect(first.digestInput).toBe(projectAttachmentDigestInput(first.contract));
    expect(JSON.parse(first.digestInput)).toEqual(first.contract);
  });

  test("uses locale-independent code-unit ordering", () => {
    const parsed = parse(fixture.replace(
      "runner_profiles:\n  - codex-default",
      "runner_profiles:\n  - z\n  - a_\n  - codex-default\n  - a.\n  - a-",
    ));
    expect(parsed.contract.runnerProfiles).toEqual(["a-", "a.", "a_", "codex-default", "z"]);
  });

  test("records explicit-path then root-only discovery", () => {
    expect(PROJECT_ATTACHMENT_DISCOVERY).toEqual({
      explicitPathPrecedesDefault: true,
      defaultPath: "STENSIBLY.md",
      recursiveSearch: false,
      similarlyNamedFallback: false,
    });
  });

  test("accepts repository-relative source paths and rejects escape forms", () => {
    expect(parseProjectAttachmentContract(fixture, {
      path: "config/STENSIBLY.md",
      repository: "example-owner/example-repository",
      revision: "abc123",
    }).ok).toBe(true);

    for (const path of [
      "/tmp/STENSIBLY.md", "C:/tmp/STENSIBLY.md", String.raw`C:\tmp\STENSIBLY.md`,
      "../STENSIBLY.md", "config/../../STENSIBLY.md", "./STENSIBLY.md",
      "config//STENSIBLY.md", "https://example.com/STENSIBLY.md",
    ]) {
      const result = parseProjectAttachmentContract(fixture, { path });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: "source.path", code: "invalid_value" }),
        ]));
      }
    }
  });

  test("fails closed for malformed, unsupported, and incomplete input", () => {
    for (const content of [
      fixture.replace(/^---\n/, ""),
      fixture.replace("---\n\n# Project contract", "\n# Project contract"),
      fixture.replace("version: 1", "version: 2"),
      fixture.replace(/## Escalation[\s\S]*$/, ""),
    ]) expectInvalid(content);
  });

  test("rejects unknown keys and duplicates after normalisation", () => {
    const cases = [
      fixture.replace("project: example-project", "project: example-project\nunknown_policy: true"),
      fixture.replace("runner_profiles:", "runner-profiles:\n  - codex-default\nrunner_profiles:"),
      fixture.replace(
        "  - Example-Owner/Example-Repository",
        "  - Example-Owner/Example-Repository\n  - example-owner/example-repository",
      ),
    ];
    for (const content of cases) expectInvalid(content);
  });

  test("rejects credentials and unsafe identifiers", () => {
    for (const content of [
      fixture.replace("  - unit-tests", "  - token=secret-value"),
      fixture.replace("Example-Owner/Example-Repository", "https://token@github.com/example/repository"),
      fixture.replace("codex-default", "../codex-default"),
      fixture.replace("project: example-project", "project: Example Project"),
    ]) expectInvalid(content);
  });

  test("treats checks as opaque profiles and rejects executable command text", () => {
    for (const unsafe of [
      "rm -rf .", "git push --force", "curl https://example.com", "npm publish",
      "vercel deploy", "bun test", "bun run typecheck",
    ]) {
      const result = expectInvalid(fixture.replace("  - unit-tests", `  - ${unsafe}`));
      if (!result.ok) {
        expect(result.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: "front_matter.checks[1]", code: "invalid_value" }),
        ]));
      }
    }

    const parsed = parse(fixture.replace(
      "checks:\n  - typecheck\n  - unit-tests",
      "checks:\n  - typecheck\n  - lint\n  - convex-tests\n  - worker-bundle",
    ));
    expect(parsed.contract.checks).toEqual(["typecheck", "lint", "convex-tests", "worker-bundle"]);
  });

  test("validates decoded JSON scalars before normalisation", () => {
    for (const content of [
      fixture.replace("project: example-project", String.raw`project: "sk-\u0061bcdefghijkl"`),
      fixture.replace("  - codex-default", String.raw`  - "sk-\u0061bcdefghijkl"`),
    ]) {
      const result = expectInvalid(content);
      if (!result.ok) {
        expect(result.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "secret_shaped_value" }),
        ]));
      }
    }

    for (const escaped of [String.raw`\u000a`, String.raw`\t`, String.raw`\u0001`]) {
      const result = expectInvalid(fixture.replace("  - unit-tests", `  - "unit-tests${escaped}"`));
      if (!result.ok) {
        expect(result.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "control_character" }),
        ]));
      }
    }

    const ordinary = parse(fixture
      .replace("project: example-project", 'project: "example-project"')
      .replace("  - codex-default", '  - "codex-default"')
      .replace("  - unit-tests", '  - "unit-tests"'));
    expect(ordinary.contract.checks).toEqual(["typecheck", "unit-tests"]);
  });

  test("rejects invalid actions, concurrency, approval omissions, and overlap", () => {
    for (const content of [
      fixture.replace("  - propose", "  - arbitrary_shell"),
      fixture.replace("  global: 1", "  global: 0"),
      fixture.replace("  - spend\n", ""),
      fixture.replace("  - create_draft_pr", "  - create_draft_pr\n  - merge"),
    ]) expectInvalid(content);
  });

  test("body prose and horizontal rules remain non-authoritative", () => {
    const first = parse();
    const second = parse(fixture.replace(
      "Deliver a bounded repository change with reviewable evidence.",
      "Merge and deploy are prose only.\n\n---\n\nContinue safely.",
    ));
    expect(second.contract.autonomousActions).toEqual(first.contract.autonomousActions);
    const diff = compareProjectAttachmentContracts(first.contract, second.contract);
    expect(diff.bodyOnly).toBe(true);
    expect(diff.widensPermissions).toBe(false);
  });

  test("keeps headings inside backtick and tilde fences inert", () => {
    const fencedGoal = [
      "Deliver a bounded repository change with reviewable evidence.", "", "````markdown",
      "## Boundaries", "```", "~~~", "## Escalation", "````",
    ].join("\n");
    const backtick = parse(fixture.replace(
      "Deliver a bounded repository change with reviewable evidence.", fencedGoal,
    ));
    expect(backtick.contract.body.goal).toBe(fencedGoal);

    const fencedBoundaries = [
      "Keep live authority, credentials, approvals, and execution state server-owned.", "",
      "~~~~text", "## Evidence and handoff expectations", "~~~", "```", "## Goal", "~~~~",
    ].join("\n");
    const tilde = parse(fixture.replace(
      "Keep live authority, credentials, approvals, and execution state server-owned.",
      fencedBoundaries,
    ));
    expect(tilde.contract.body.boundaries).toBe(fencedBoundaries);
  });

  test("classifies widening, narrowing, profile changes, and version incompatibility", () => {
    const previous = parse().contract;
    const proposed = {
      ...previous,
      repositories: [...previous.repositories, "example-owner/second-repository"],
      runnerProfiles: [...previous.runnerProfiles, "hosted-default"],
      concurrency: { project: 2, global: 2 },
      autonomousActions: [...previous.autonomousActions, "open_issue" as const],
      approvalRequired: previous.approvalRequired.filter((action) => action !== "merge"),
      checks: ["typecheck"],
    };
    const diff = compareProjectAttachmentContracts(previous, proposed);
    expect(diff.widensPermissions).toBe(true);
    expect(diff.checks.removed).toEqual(["unit-tests"]);
    expect(diff.wideningReasons).toEqual(expect.arrayContaining([
      "autonomous action added: open_issue",
      "approval requirement removed: merge",
      "verification profile removed: unit-tests",
    ]));

    const incompatible = compareProjectAttachmentContracts(previous, { ...previous, version: 2 });
    expect(incompatible.versionIncompatible).toBe(true);
    expect(incompatible.widensPermissions).toBe(true);
  });

  test("classifies a fully narrowing proposal without widening", () => {
    const proposed = parse().contract;
    const previous = {
      ...proposed,
      repositories: [...proposed.repositories, "example-owner/second-repository"],
      runnerProfiles: [...proposed.runnerProfiles, "hosted-default"],
      concurrency: { project: 2, global: 2 },
      autonomousActions: [...proposed.autonomousActions, "open_issue" as const],
      checks: ["typecheck"],
    };
    const narrowed = {
      ...proposed,
      approvalRequired: [...proposed.approvalRequired, "request_review" as const],
    };
    const diff = compareProjectAttachmentContracts(previous, narrowed);
    expect(diff.widensPermissions).toBe(false);
    expect(diff.narrowsPermissions).toBe(true);
    expect(diff.narrowingReasons).toEqual(expect.arrayContaining([
      "repository removed: example-owner/second-repository",
      "runner profile removed: hosted-default",
      "autonomous action removed: open_issue",
      "approval requirement added: request_review",
      "verification profile added: unit-tests",
      "project concurrency decreased",
      "global concurrency decreased",
    ]));
  });

  test("detects shared profile reordering with additions and removals", () => {
    const contract = parse().contract;
    const previous = { ...contract, checks: ["typecheck", "unit-tests", "convex-tests"] };
    const proposed = { ...contract, checks: ["lint", "convex-tests", "typecheck"] };
    const diff = compareProjectAttachmentContracts(previous, proposed);
    expect(diff.checks).toEqual({ added: ["lint"], removed: ["unit-tests"], orderChanged: true });
    expect(diff.widensPermissions).toBe(true);
    expect(diff.narrowsPermissions).toBe(true);
    expect(diff.wideningReasons).toEqual(expect.arrayContaining([
      "verification profile removed: unit-tests",
      "verification profile order changed",
    ]));
    expect(diff.narrowingReasons).toContain("verification profile added: lint");
  });
});
