import { describe, expect, test } from "bun:test";
import {
  executeProviderMembershipAuditCli,
  parseProviderMembershipAuditArgs,
  providerMembershipAuditFailure,
  providerMembershipAuditFunctionName,
  runProviderMembershipAudit,
  type ProviderMembershipAuditArguments,
  type ProviderMembershipAuditInvoker,
  type ProviderMembershipAuditResult,
} from "../src/provider-membership-audit-cli.ts";

const serviceSecret = "membership-audit-service-secret";
const environment = {
  CONVEX_URL: "https://careful-tern-123.convex.cloud",
  STENSIBLY_SERVICE_SECRET: serviceSecret,
};

function absentResult(): ProviderMembershipAuditResult {
  return {
    version: 1,
    workspace: "default",
    provider: "github",
    status: "identity_absent",
    membership: null,
    cleanBootstrapEligible: true,
    requiresSeparateMembershipPlan: false,
    containsSecrets: false,
    readOnly: true,
    grantsMembershipChange: false,
    grantsMembership: false,
    grantsLogin: false,
    grantsOAuthEnablement: false,
  };
}

function activeResult(): ProviderMembershipAuditResult {
  return {
    version: 1,
    workspace: "default",
    provider: "github",
    status: "membership_active",
    membership: {
      role: "viewer",
      projectScope: "bounded",
      projects: ["alpha", "oauth-dogfood"],
      projectCount: 2,
      revocationState: "active",
      revokedAt: null,
    },
    cleanBootstrapEligible: false,
    requiresSeparateMembershipPlan: true,
    containsSecrets: false,
    readOnly: true,
    grantsMembershipChange: false,
    grantsMembership: false,
    grantsLogin: false,
    grantsOAuthEnablement: false,
  };
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

describe("copy-safe provider membership audit CLI", () => {
  test("uses the fixed query contract and keeps the service secret out of output", async () => {
    let capturedUrl = "";
    const capturedArgs: ProviderMembershipAuditArguments[] = [];
    const invoke: ProviderMembershipAuditInvoker = async (url, args) => {
      capturedUrl = url;
      capturedArgs.push(args);
      return absentResult();
    };
    const capture = captureIo();

    const exitCode = await executeProviderMembershipAuditCli([
      "--",
      "--workspace",
      "Default",
      "--provider",
      "GitHub",
      "--subject",
      "13091533",
    ], environment, capture.io, invoke);

    expect(exitCode).toBe(0);
    expect(providerMembershipAuditFunctionName).toBe(
      "providerMembershipAudit:auditProviderMembership",
    );
    expect(capturedUrl).toBe("https://careful-tern-123.convex.cloud");
    expect(capturedArgs).toEqual([{
      serviceSecret,
      workspace: "default",
      provider: "github",
      subject: "13091533",
    }]);
    expect(capture.stderr).toEqual([]);
    expect(capture.stdout).toEqual([`${JSON.stringify(absentResult())}\n`]);
    expect(capture.stdout.join("")).not.toContain(serviceSecret);
    expect(capture.stdout.join("")).not.toContain("subject");
  });

  test("prints one canonical bounded existing-membership result", async () => {
    const result = await runProviderMembershipAudit(
      { workspace: " default ", provider: " GITHUB ", subject: " 13091533 " },
      environment,
      async () => activeResult(),
    );

    expect(result).toEqual(activeResult());
    expect(Object.keys(result)).toEqual([
      "version",
      "workspace",
      "provider",
      "status",
      "membership",
      "cleanBootstrapEligible",
      "requiresSeparateMembershipPlan",
      "containsSecrets",
      "readOnly",
      "grantsMembershipChange",
      "grantsMembership",
      "grantsLogin",
      "grantsOAuthEnablement",
    ]);
    expect(result.membership?.projects).toEqual(["alpha", "oauth-dogfood"]);
  });

  test("rejects missing or unsafe environment values before invoking Convex", async () => {
    let calls = 0;
    const invoke: ProviderMembershipAuditInvoker = async () => {
      calls += 1;
      return absentResult();
    };
    for (const env of [
      { STENSIBLY_SERVICE_SECRET: serviceSecret },
      { CONVEX_URL: "http://careful-tern-123.convex.cloud", STENSIBLY_SERVICE_SECRET: serviceSecret },
      { CONVEX_URL: "https://example.com", STENSIBLY_SERVICE_SECRET: serviceSecret },
      { CONVEX_URL: "https://user:password@careful-tern-123.convex.cloud", STENSIBLY_SERVICE_SECRET: serviceSecret },
      { CONVEX_URL: environment.CONVEX_URL },
      { CONVEX_URL: environment.CONVEX_URL, STENSIBLY_SERVICE_SECRET: "short" },
    ]) {
      const capture = captureIo();
      expect(await executeProviderMembershipAuditCli([
        "--workspace", "default",
        "--provider", "github",
        "--subject", "13091533",
      ], env, capture.io, invoke)).toBe(1);
      expect(capture.stdout).toEqual([]);
      expect(capture.stderr).toEqual([`${providerMembershipAuditFailure}\n`]);
    }
    expect(calls).toBe(0);
  });

  test("rejects duplicate, unknown, and secret-bearing arguments without echoing them", async () => {
    const secretArgument = "do-not-print-this-secret";
    const cases = [
      [
        "--workspace", "default",
        "--workspace", "other",
        "--provider", "github",
        "--subject", "13091533",
      ],
      [
        "--workspace", "default",
        "--provider", "github",
        "--subject", "13091533",
        "--unknown", "value",
      ],
      [
        "--workspace", "default",
        "--provider", "github",
        "--subject", "13091533",
        `--service-secret=${secretArgument}`,
      ],
      [
        "--workspace", "default",
        "--provider", "github",
        "--subject", `bad\u0000${secretArgument}`,
      ],
    ];

    for (const args of cases) {
      const capture = captureIo();
      expect(await executeProviderMembershipAuditCli(
        args,
        environment,
        capture.io,
        async () => absentResult(),
      )).toBe(1);
      const output = `${capture.stdout.join("")}${capture.stderr.join("")}`;
      expect(output).toBe(`${providerMembershipAuditFailure}\n`);
      expect(output).not.toContain(secretArgument);
    }
  });

  test("rejects malformed or authority-bearing backend output", async () => {
    const malformed = [
      { ...absentResult(), grantsLogin: true },
      { ...absentResult(), readOnly: false },
      { ...absentResult(), grantsMembershipChange: true },
      { ...absentResult(), subject: "13091533" },
      { ...absentResult(), cleanBootstrapEligible: false },
      { ...absentResult(), status: "membership_active", membership: null },
      {
        ...activeResult(),
        membership: {
          ...activeResult().membership,
          projects: ["oauth-dogfood", "alpha"],
        },
      },
      {
        ...activeResult(),
        membership: {
          ...activeResult().membership,
          projectScope: "uninspectable",
          projects: ["oauth-dogfood"],
        },
      },
    ];

    for (const result of malformed) {
      const capture = captureIo();
      expect(await executeProviderMembershipAuditCli([
        "--workspace", "default",
        "--provider", "github",
        "--subject", "13091533",
      ], environment, capture.io, async () => result)).toBe(1);
      expect(capture.stdout).toEqual([]);
      expect(capture.stderr).toEqual([`${providerMembershipAuditFailure}\n`]);
    }
  });

  test("suppresses upstream error text and remains deterministic", async () => {
    const upstreamText = `network failed with ${serviceSecret}`;
    const capture = captureIo();
    expect(await executeProviderMembershipAuditCli([
      "--workspace", "default",
      "--provider", "github",
      "--subject", "13091533",
    ], environment, capture.io, async () => {
      throw new Error(upstreamText);
    })).toBe(1);
    const output = `${capture.stdout.join("")}${capture.stderr.join("")}`;
    expect(output).toBe(`${providerMembershipAuditFailure}\n`);
    expect(output).not.toContain(upstreamText);
    expect(output).not.toContain(serviceSecret);

    const first = await runProviderMembershipAudit(
      parseProviderMembershipAuditArgs([
        "--workspace", "default",
        "--provider", "github",
        "--subject", "13091533",
      ]),
      environment,
      async () => activeResult(),
    );
    const second = await runProviderMembershipAudit(
      parseProviderMembershipAuditArgs([
        "--workspace", "default",
        "--provider", "github",
        "--subject", "13091533",
      ]),
      environment,
      async () => activeResult(),
    );
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
