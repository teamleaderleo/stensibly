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
  test("parses equivalent version 1 input into one deterministic canonical projection", () => {
    const first = parse();
    const newlineEquivalent = parse(
      fixture.replace("\n\n# Project contract", "\r\n\r\n# Project contract"),
    );
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
    });
    expect(first.source.repository).toBe("example-owner/example-repository");
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

  test("fails closed for malformed input and returns no partial result", () => {
    for (const content of [
      fixture.replace(/^---\n/, ""),
      fixture.replace("---\n\n# Project contract", "\n# Project contract"),
      fixture.replace("version: 1", "version: 2"),
      fixture.replace(
        "## Escalation\n\nEscalate permission widening, ambiguous scope, missing capabilities, and consequential actions.\n",
        "",
      ),
    ]) {
      const result = parseProjectAttachmentContract(content);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result).not.toHaveProperty("value");
        expect(result.errors.length).toBeGreaterThan(0);
      }
    }
  });

  test("rejects unknown keys and duplicates after normalisation", () => {
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

    const duplicateKey = parseProjectAttachmentContract(fixture.replace(
      "runner_profiles:",
      "runner-profiles:\n  - codex-default\nrunner_profiles:",
    ));
    expect(duplicateKey.ok).toBe(false);
    if (!duplicateKey.ok) {
      expect(duplicateKey.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_key" }),
      ]));
    }

    const duplicateValue = parseProjectAttachmentContract(fixture.replace(
      "  - Example-Owner/Example-Repository",
      "  - Example-Owner/Example-Repository\n  - example-owner/example-repository",
    ));
    expect(duplicateValue.ok).toBe(false);
    if (!duplicateValue.ok) {
      expect(duplicateValue.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_value" }),
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

  test("validates decoded JSON scalars before field normalisation", () => {
    const encodedSecretCases = [
      fixture.replace(
        "project: example-project",
        String.raw`project: "sk-\u0061bcdefghijkl"`,
      ),
      fixture.replace(
        "  - codex-default",
        String.raw`  - "sk-\u0061bcdefghijkl"`,
      ),
    ];
    for (const content of encodedSecretCases) {
      const result = parseProjectAttachmentContract(content);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "secret_shaped_value" }),
        ]));
      }
    }

    for (const escaped of [String.raw`\u000a`, String.raw`\t`, String.raw`\u0001`]) {
      const result = parseProjectAttachmentContract(
        fixture.replace("  - bun test", `  - "bun test${escaped}"`),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "control_character" }),
        ]));
      }
    }

    const ordinary = parse(fixture
      .replace("project: example-project", 'project: "example-project"')
      .replace("  - codex-default", '  - "codex-default"')
      .replace("  - bun test", '  - "bun test"'));
    expect(ordinary.contract.project).toBe("example-project");
    expect(ordinary.contract.runnerProfiles).toEqual(["codex-default"]);
    expect(ordinary.contract.checks).toEqual(["bun run typecheck", "bun test"]);
  });

  test("rejects invalid actions, concurrency, missing consequential approvals, and overlap", () => {
    expect(parseProjectAttachmentContract(
      fixture.replace("  - propose", "  - arbitrary_shell"),
    ).ok).toBe(false);
    expect(parseProjectAttachmentContract(
      fixture.replace("  global: 1", "  global: 0"),
    ).ok).toBe(false);
    expect(parseProjectAttachmentContract(
      fixture.replace("  - spend\n", ""),
    ).ok).toBe(false);
    expect(parseProjectAttachmentContract(
      fixture.replace("  - create_draft_pr", "  - create_draft_pr\n  - merge"),
    ).ok).toBe(false);
  });

  test("body prose and horizontal rules never change parsed permissions", () => {
    const first = parse();
    const second = parse(fixture.replace(
      "Deliver a bounded repository change with reviewable evidence.",
      "Merge and deploy are words in prose only; they grant no authority.\n\n---\n\nContinue safely.",
    ));
    expect(second.contract.autonomousActions).toEqual(first.contract.autonomousActions);
    expect(second.contract.approvalRequired).toEqual(first.contract.approvalRequired);
    const diff = compareProjectAttachmentContracts(first.contract, second.contract);
    expect(diff.bodyChanged).toBe(true);
    expect(diff.bodyOnly).toBe(true);
    expect(diff.widensPermissions).toBe(false);
  });

  test("keeps level-two headings inside backtick fences as inert display text", () => {
    const fencedGoal = [
      "Deliver a bounded repository change with reviewable evidence.",
      "",
      "````markdown",
      "## Boundaries",
      "```",
      "~~~",
      "## Escalation",
      "````",
    ].join("\n");
    const parsed = parse(fixture.replace(
      "Deliver a bounded repository change with reviewable evidence.",
      fencedGoal,
    ));

    expect(parsed.contract.body.goal).toBe(fencedGoal);
    expect(parsed.contract.body.boundaries).toContain("Keep live authority");
  });

  test("keeps level-two headings inside tilde fences as inert display text", () => {
    const fencedBoundaries = [
      "Keep live authority, credentials, approvals, and execution state server-owned.",
      "",
      "~~~~text",
      "## Evidence and handoff expectations",
      "~~~",
      "```",
      "## Goal",
      "~~~~",
    ].join("\n");
    const parsed = parse(fixture.replace(
      "Keep live authority, credentials, approvals, and execution state server-owned.",
      fencedBoundaries,
    ));

    expect(parsed.contract.body.boundaries).toBe(fencedBoundaries);
    expect(parsed.contract.body.evidenceAndHandoff).toContain("Record the exact head");
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
