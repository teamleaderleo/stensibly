import { expect, test } from "bun:test";
import { compileGitHubActionsCiReceiptV1 } from "../src/github-actions-ci-receipt.js";

const candidate = "a".repeat(40);
const base = "b".repeat(40);
const workflow = "c".repeat(40);

function job(name: string, id: number): Record<string, unknown> {
  return {
    id,
    runId: 30638086970,
    runAttempt: 1,
    headSha: candidate,
    workflowName: "CI",
    name,
    status: "completed",
    conclusion: "success",
    createdAt: "2026-07-31T10:00:01Z",
    startedAt: "2026-07-31T10:01:00Z",
    completedAt: "2026-07-31T10:20:00Z",
    labels: ["ubuntu-latest"],
    steps: [{
      number: 1,
      name: "Set up job",
      status: "completed",
      conclusion: "success",
    }],
  };
}

function bundle(): Record<string, unknown> {
  return {
    version: 1,
    repository: "teamleaderleo/stensibly",
    receivedAt: "2026-07-31T10:31:00Z",
    workflowRevision: workflow,
    validationProfile: "full_parallel",
    run: {
      id: 30638086970,
      attempt: 1,
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      headSha: candidate,
      createdAt: "2026-07-31T10:00:00Z",
      completedAt: "2026-07-31T10:30:00Z",
      pullRequests: [{ number: 704, headSha: candidate, baseSha: base }],
    },
    jobs: [
      job("browser-evidence", 5),
      job("test", 10),
      job("runtime-parity", 20),
      job("serial-full", 30),
    ],
    diagnosticsArtifacts: [],
  };
}

const compile = (input: unknown) => compileGitHubActionsCiReceiptV1(
  input,
  () => new Date("2026-07-31T10:31:00Z"),
);

test("rejects record fields hidden after descriptor capture", () => {
  const input = bundle();
  Object.defineProperty(input, "escapedAdmission", {
    configurable: true,
    enumerable: true,
    value: true,
  });
  let reads = 0;
  const hostile = new Proxy(input, {
    ownKeys(target) {
      reads += 1;
      const keys = Reflect.ownKeys(target);
      return reads === 1
        ? keys
        : keys.filter((key) => key !== "escapedAdmission");
    },
  });

  expect(() => compile(hostile)).toThrow("contains unknown fields");
});

test("rejects array fields hidden during key validation", () => {
  const input = bundle();
  const jobs = input.jobs as Record<string, unknown>[] & {
    escapedAdmission?: boolean;
  };
  Object.defineProperty(jobs, "escapedAdmission", {
    configurable: true,
    enumerable: true,
    value: true,
  });
  let reads = 0;
  input.jobs = new Proxy(jobs, {
    ownKeys(target) {
      reads += 1;
      const keys = Reflect.ownKeys(target);
      return reads === 1
        ? keys.filter((key) => key !== "escapedAdmission")
        : keys;
    },
  });

  expect(() => compile(input)).toThrow("contains unsupported fields");
});
