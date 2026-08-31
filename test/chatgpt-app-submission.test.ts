import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  compileMcpCapabilitySubmissionAnnotations,
  requireMcpCapabilityPolicy,
} from "../src/mcp-capability-policy.ts";

interface Submission {
  schema_version: number;
  app_info: { subtitle: string };
  tools: Record<string, {
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      openWorldHint: boolean;
    };
  }>;
  test_cases: Array<{ tools_triggered: string | null }>;
  negative_test_cases: Array<{ tools_triggered: string | null }>;
}

const submissionPath = new URL("../chatgpt-app-submission.json", import.meta.url);
const actionSnapshotPath = new URL("../docs/chatgpt-app-actions.json", import.meta.url);

describe("ChatGPT app submission artifact", () => {
  test("matches the reviewed published tool surface and canonical risk annotations", () => {
    const submission = JSON.parse(readFileSync(submissionPath, "utf8")) as Submission;
    const actionSnapshot = JSON.parse(readFileSync(actionSnapshotPath, "utf8")) as {
      tools: string[];
    };

    expect(submission.schema_version).toBe(1);
    expect(submission.app_info.subtitle.length).toBeLessThanOrEqual(30);
    expect(Object.keys(submission.tools).sort()).toEqual([...actionSnapshot.tools].sort());

    for (const [name, tool] of Object.entries(submission.tools)) {
      expect(tool.annotations).toEqual(
        compileMcpCapabilitySubmissionAnnotations(requireMcpCapabilityPolicy(name)),
      );
    }
  });

  test("contains the exact review test-case counts and valid published action names", () => {
    const submission = JSON.parse(readFileSync(submissionPath, "utf8")) as Submission;
    const published = new Set(Object.keys(submission.tools));

    expect(submission.test_cases).toHaveLength(5);
    expect(submission.negative_test_cases).toHaveLength(3);
    for (const testCase of submission.test_cases) {
      expect(testCase.tools_triggered).not.toBeNull();
      for (const name of testCase.tools_triggered!.split(",").map((value) => value.trim())) {
        expect(published.has(name)).toBe(true);
      }
    }
    for (const testCase of submission.negative_test_cases) {
      expect(testCase.tools_triggered).toBeNull();
    }
  });
});
