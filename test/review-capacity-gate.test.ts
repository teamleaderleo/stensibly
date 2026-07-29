import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const coderabbit = readFileSync(new URL("../.coderabbit.yaml", import.meta.url), "utf8");
const policy = readFileSync(new URL("../docs/review-capacity-gate.md", import.meta.url), "utf8");
const template = readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");

describe("opt-in CodeRabbit reviews", () => {
  test("keeps automatic review disabled without skip-review machinery", () => {
    expect(coderabbit).toContain("auto_review:\n    enabled: false");
    expect(coderabbit).not.toContain("review-exempt");
    expect(coderabbit).not.toContain("[skip review]");
  });

  test("reserves manual review for consequential uncertain changes", () => {
    expect(policy).toContain("off by default");
    expect(policy).toContain("Do not request it for routine work");
    expect(policy).toContain("genuinely consequential");
    expect(policy).toContain("meaningful uncertainty remains");
    expect(policy).toContain("Use at most one review");
  });

  test("keeps the pull request template lightweight", () => {
    expect(template).toContain("CodeRabbit review is opt-in");
    expect(template).not.toContain("Review classification");
    expect(template).not.toContain("Review spend");
    expect(template).not.toContain("Execution-only PRs");
  });
});
