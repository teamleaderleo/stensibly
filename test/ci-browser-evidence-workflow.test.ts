import { describe, expect, test } from "bun:test";
import {
  CI_BROWSER_EVIDENCE_COMMAND_IDS_V1,
  CI_BROWSER_EVIDENCE_PROFILE_CONTRACT_V1,
  CI_BROWSER_EVIDENCE_TOPOLOGIES_V1,
} from "../src/ci-browser-evidence-profile.ts";

const workflow = await Bun.file(
  new URL("../.github/workflows/ci.yml", import.meta.url),
).text();

const browserJob = workflow.match(
  /\n  browser-evidence:\n([\s\S]*?)\n  test:\n/u,
)?.[1];
const serialJob = workflow.match(
  /\n  serial-full:\n([\s\S]*)$/u,
)?.[1];
const serialDiagnostics = serialJob?.match(
  /\n      - name: Upload serial full diagnostics\n([\s\S]*)$/u,
)?.[1];

const commandMarkers = {
  "browser-typecheck": "bun run typecheck:browser",
  "browser-tests": "bun run test:browser",
  "browser-artifacts": "bun run verify:browser-artifacts",
} as const satisfies Record<
  typeof CI_BROWSER_EVIDENCE_COMMAND_IDS_V1[number],
  string
>;

describe("CI browser evidence profile", () => {
  test("publishes one immutable three-command adjunct contract", () => {
    expect(CI_BROWSER_EVIDENCE_PROFILE_CONTRACT_V1).toBe(1);
    expect(CI_BROWSER_EVIDENCE_COMMAND_IDS_V1).toEqual([
      "browser-typecheck",
      "browser-tests",
      "browser-artifacts",
    ]);
    expect(Object.isFrozen(CI_BROWSER_EVIDENCE_COMMAND_IDS_V1)).toBe(true);
    expect(CI_BROWSER_EVIDENCE_TOPOLOGIES_V1.full_parallel).toMatchObject({
      execution: "adjunct_runner",
      jobName: "browser-evidence",
    });
    expect(CI_BROWSER_EVIDENCE_TOPOLOGIES_V1.serial_full).toMatchObject({
      execution: "same_runner",
      jobName: "serial-full",
    });
    expect(CI_BROWSER_EVIDENCE_TOPOLOGIES_V1.full_parallel.commandIds)
      .toBe(CI_BROWSER_EVIDENCE_COMMAND_IDS_V1);
    expect(CI_BROWSER_EVIDENCE_TOPOLOGIES_V1.serial_full.commandIds)
      .toBe(CI_BROWSER_EVIDENCE_COMMAND_IDS_V1);
  });

  test("runs the adjunct job for ordinary events and full_parallel exact-ref requests", () => {
    expect(browserJob).toBeDefined();
    expect(browserJob).toContain("github.event_name != 'workflow_dispatch' &&");
    expect(browserJob).toContain("github.event_name != 'workflow_call'");
    expect(browserJob).toContain("inputs.validation_profile == 'full_parallel'");
    expect(browserJob).toContain('"${GITHUB_SHA}" != "${EXPECTED_SHA}"');
    expect(browserJob).toContain("bunx playwright install --with-deps chromium");
    expect(browserJob).toContain("frontend-browser-evidence-${{ github.sha }}");
    expect(browserJob).toContain("steps.browser-test.outcome == 'success'");
    expect(browserJob).toContain("steps.browser-artifacts.outcome == 'success'");
    for (const commandId of CI_BROWSER_EVIDENCE_COMMAND_IDS_V1) {
      expect(browserJob).toContain(commandMarkers[commandId]);
    }
  });

  test("automatically follows a green parallel pull-request candidate with exact-head serial validation", () => {
    expect(serialJob).toBeDefined();
    expect(serialJob).toContain("needs: [browser-evidence, test, runtime-parity]");
    expect(serialJob).toContain("always()");
    expect(serialJob).toContain("github.event_name == 'pull_request'");
    expect(serialJob).toContain("needs.browser-evidence.result == 'success'");
    expect(serialJob).toContain("needs.test.result == 'success'");
    expect(serialJob).toContain("needs.runtime-parity.result == 'success'");
    expect(serialJob).toContain("github.event_name == 'workflow_dispatch' ||");
    expect(serialJob).toContain("github.event_name == 'workflow_call'");
    expect(serialJob).toContain("inputs.validation_profile == 'serial_full'");
    expect(serialJob).toContain("github.event.pull_request.head.sha");
    expect(serialJob).toContain("SERIAL_VALIDATION_SHA:");
    expect(serialJob).toContain("ref: ${{ env.SERIAL_VALIDATION_SHA }}");
    expect(serialJob).toContain("persist-credentials: false");
    expect(serialJob).toContain('actual_sha="$(git rev-parse HEAD)"');
    expect(serialJob).toContain('! "${SERIAL_VALIDATION_SHA}" =~ ^[0-9a-f]{40}$');
    expect(serialJob).toContain('"${actual_sha}" != "${SERIAL_VALIDATION_SHA}"');
  });

  test("executes the same browser commands on the serial profile's single runner", () => {
    expect(serialJob).toBeDefined();
    expect(serialJob?.match(/actions\/checkout@v6/gu)).toHaveLength(1);
    expect(serialJob?.match(/oven-sh\/setup-bun@v2/gu)).toHaveLength(1);
    expect(serialJob?.match(/actions\/setup-node@v6/gu)).toHaveLength(1);
    expect(serialJob?.match(/bun install --frozen-lockfile/gu)).toHaveLength(1);
    expect(serialJob?.match(/bunx playwright install --with-deps chromium/gu)).toHaveLength(1);

    let previousIndex = -1;
    for (const commandId of CI_BROWSER_EVIDENCE_COMMAND_IDS_V1) {
      const marker = commandMarkers[commandId];
      const index = serialJob?.indexOf(marker) ?? -1;
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }

    expect(serialJob).toContain("frontend-browser-evidence-${{ env.SERIAL_VALIDATION_SHA }}");
    expect(serialJob).toContain("browser-typecheck-output.txt");
    expect(serialJob).toContain("browser-test-output.txt");
    expect(serialJob).toContain("browser-artifact-output.txt");
  });

  test("retains browser outputs only after the serial privacy fence succeeds", () => {
    expect(serialDiagnostics).toBeDefined();
    expect(serialDiagnostics).toContain("serial-full-diagnostics-${{ env.SERIAL_VALIDATION_SHA }}");
    expect(serialDiagnostics).toContain("browser-typecheck-output.txt");
    expect(serialDiagnostics).not.toContain("browser-test-output.txt");
    expect(serialDiagnostics).not.toContain("browser-artifact-output.txt");
    expect(serialJob).toContain("if: steps.serial-validation.outcome == 'success'");
  });
});