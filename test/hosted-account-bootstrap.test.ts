import { describe, expect, test } from "bun:test";
import {
  parseHostedAuthBootstrapProjects,
  withHostedAuthBootstrapProjects,
} from "../src/hosted-account-bootstrap.ts";
import type {
  HostedAccountContext,
  HostedAccountService,
} from "../src/hosted-account-service.ts";

describe("hosted-auth bootstrap project configuration", () => {
  test("preserves omission and canonicalizes an explicit bounded list", () => {
    expect(parseHostedAuthBootstrapProjects(undefined)).toBeUndefined();
    expect(parseHostedAuthBootstrapProjects(" Beta_Project,alpha-project ")).toEqual([
      "alpha-project",
      "beta_project",
    ]);
  });

  test("rejects empty, duplicate, unsafe, malformed, and excessive input", () => {
    expect(() => parseHostedAuthBootstrapProjects("")).toThrow("is invalid");
    expect(() => parseHostedAuthBootstrapProjects("alpha, ALPHA")).toThrow(
      "duplicate projects",
    );
    expect(() => parseHostedAuthBootstrapProjects("alpha,\nbeta")).toThrow("is invalid");
    expect(() => parseHostedAuthBootstrapProjects("-alpha")).toThrow(
      "lowercase project slugs",
    );
    expect(() => parseHostedAuthBootstrapProjects(
      Array.from({ length: 33 }, (_, index) => `project-${index}`).join(","),
    )).toThrow("at most 32 projects");
    expect(() => parseHostedAuthBootstrapProjects("a".repeat(2049))).toThrow(
      "at most 2048 UTF-8 bytes",
    );
  });

  test("injects the exact configured scope without mutating caller input", async () => {
    let captured: Parameters<HostedAccountService["upsertProviderIdentity"]>[0] | undefined;
    const service = fakeService(async (input) => {
      captured = input;
      return {} as HostedAccountContext;
    });
    const configured = ["alpha", "beta"];
    const wrapped = withHostedAuthBootstrapProjects(service, configured);
    configured.push("later-mutation");

    await wrapped.upsertProviderIdentity({
      provider: "github",
      subject: "1001",
      username: "teamleaderleo",
      displayName: "Leo",
      emailVerified: false,
      bootstrapRole: "member",
      projects: ["caller-supplied"],
    });

    expect(captured?.projects).toEqual(["alpha", "beta"]);
    expect(captured?.bootstrapRole).toBe("member");
  });

  test("returns the original service when project scoping is omitted", () => {
    const service = fakeService(async () => ({} as HostedAccountContext));
    expect(withHostedAuthBootstrapProjects(service, undefined)).toBe(service);
  });
});

function fakeService(
  upsertProviderIdentity: HostedAccountService["upsertProviderIdentity"],
): HostedAccountService {
  const unused = async (): Promise<never> => {
    throw new Error("unused fake account-service method");
  };
  return {
    createOAuthState: unused,
    consumeOAuthState: unused,
    upsertProviderIdentity,
    createSession: unused,
    authenticateSession: unused,
    touchSession: unused,
    revokeSession: unused,
  };
}
