import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  browserEvidenceValidationProfile,
  browserEvidenceValidationProfileVersion,
} from "../scripts/browser-evidence-validation-profile.ts";

const repositoryRoot = join(import.meta.dir, "..");
const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
const guide = readFileSync(join(repositoryRoot, "docs", "frontend-browser-validation-profile.md"), "utf8");

const fullParallelCondition = "if: ${{ github.event_name != 'workflow_dispatch' || inputs.validation_profile == 'full_parallel' }}";
const browserJob = workflow.slice(
  workflow.indexOf("  browser-evidence:"),
  workflow.indexOf("\n  test:"),
);
const testJob = workflow.slice(
  workflow.indexOf("  test:"),
  workflow.indexOf("\n  runtime-parity:"),
);
const runtimeParityJob = workflow.slice(
  workflow.indexOf("  runtime-parity:"),
  workflow.indexOf("\n  serial-full:"),
);
const serialFullJob = workflow.slice(workflow.indexOf("  serial-full:"));

describe("browser evidence validation profile", () => {
  test("publishes one exact adjunct command identity", () => {
    expect(browserEvidenceValidationProfileVersion).toBe(1);
    expect(browserEvidenceValidationProfile).toEqual({
      id: "browser-evidence/v1",
      commands: ["browser-typecheck", "browser-tests", "browser-artifacts"],
      fullParallelJob: "browser-evidence",
      serialFullJob: "serial-full",
    });
    expect(Object.isFrozen(browserEvidenceValidationProfile)).toBe(true);
    expect(Object.isFrozen(browserEvidenceValidationProfile.commands)).toBe(true);
    expect(guide).toContain("`browser-evidence/v1`");
    for (const command of browserEvidenceValidationProfile.commands) {
      expect(guide).toContain(`\`${command}\``);
    }
  });

  test("runs the adjunct in parallel only for the full-parallel topology", () => {
    expect(browserJob).toContain(fullParallelCondition);
    expect(testJob).toContain(fullParallelCondition);
    expect(runtimeParityJob).toContain(fullParallelCondition);
    expect(browserJob).toContain("bun run typecheck:browser");
    expect(browserJob).toContain("bun run test:browser");
    expect(browserJob).toContain("bun run verify:browser-artifacts");
    expect(browserJob).toContain("steps.browser-test.outcome == 'success'");
    expect(browserJob).toContain("steps.browser-artifacts.outcome == 'success'");
  });

  test("runs the complete adjunct on the single serial-full runner", () => {
    expect(serialFullJob).toContain("github.event_name == 'workflow_dispatch' && inputs.validation_profile == 'serial_full'");
    expect(serialFullJob).toContain("bunx playwright install --with-deps chromium");
    for (const gate of [
      "run_gate browser-typecheck browser-typecheck-output.txt bun run typecheck:browser",
      "run_gate browser-tests browser-test-output.txt bun run test:browser",
      "run_gate browser-artifacts browser-artifact-output.txt bun run verify:browser-artifacts",
    ]) expect(serialFullJob).toContain(gate);
    expect(serialFullJob).toContain("name: frontend-browser-evidence-${{ github.sha }}-serial");
    expect(serialFullJob).toContain("browser-typecheck-output.txt");
    expect(serialFullJob).toContain("browser-test-output.txt");
    expect(serialFullJob).toContain("browser-artifact-output.txt");
  });
});
