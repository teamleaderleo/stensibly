import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const coderabbit = readFileSync(new URL("../.coderabbit.yaml", import.meta.url), "utf8");
const policy = readFileSync(new URL("../docs/review-capacity-gate.md", import.meta.url), "utf8");
const template = readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");

describe("scarce review capacity gate", () => {
  test("keeps automatic CodeRabbit review disabled", () => {
    expect(coderabbit).toContain("auto_review:\n    enabled: false");
    expect(coderabbit).not.toContain("auto_review:\n    enabled: true");
    expect(coderabbit).toContain("docs/review-capacity-gate.md");
  });

  test("makes execution-only pull requests categorically ineligible", () => {
    for (const marker of [
      "execution-only or one-use pull requests",
      "[execution][skip review]",
      "review-exempt",
      "never mark it ready for review",
      "close it promptly",
    ]) {
      expect(policy).toContain(marker);
    }
  });

  test("requires a named residual risk and decision-changing value", () => {
    for (const marker of [
      "A residual risk is named precisely",
      "reasonably likely to find a defect",
      "change the merge, deployment, or recovery decision",
      "Why self-review is insufficient",
      "Decision this review can change",
    ]) {
      expect(policy).toContain(marker);
    }
  });

  test("puts the no-review default in every new pull request", () => {
    expect(template).toContain("Default: do not request CodeRabbit review");
    expect(template).toContain("Review classification: `no-review`");
    expect(template).toContain("Execution-only PRs");
    expect(template).toContain("Review spend");
  });
});
