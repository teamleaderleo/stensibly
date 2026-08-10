import { describe, expect, test } from "bun:test";
import {
  admitMcpSetupEvidence,
  emptyMcpSetupEvidence,
} from "../src/mcp-setup-evidence.ts";

const scope = { accountId: "acct_scrapbook_owner", project: "scrapbook" };

describe("MCP setup evidence admission", () => {
  test("admits one content-minimised connection and first-read projection", () => {
    const evidence = admitMcpSetupEvidence({
      version: 1,
      accountId: scope.accountId,
      project: scope.project,
      connectedAt: "2026-08-10T04:00:00.000Z",
      firstReadAt: "2026-08-10T04:01:00.000Z",
      containsSecrets: false,
    }, scope);
    expect(evidence).toEqual({
      version: 1,
      accountId: scope.accountId,
      project: scope.project,
      connectedAt: "2026-08-10T04:00:00.000Z",
      firstReadAt: "2026-08-10T04:01:00.000Z",
      containsSecrets: false,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  test("keeps an empty scoped projection explicit", () => {
    expect(emptyMcpSetupEvidence(scope)).toEqual({
      version: 1,
      accountId: scope.accountId,
      project: scope.project,
      connectedAt: null,
      firstReadAt: null,
      containsSecrets: false,
    });
  });

  test("rejects account/project substitution and impossible chronology", () => {
    const valid = {
      version: 1,
      accountId: scope.accountId,
      project: scope.project,
      connectedAt: "2026-08-10T04:00:00.000Z",
      firstReadAt: null,
      containsSecrets: false,
    } as const;
    expect(() => admitMcpSetupEvidence({ ...valid, accountId: "acct_other" }, scope))
      .toThrow("scope is invalid");
    expect(() => admitMcpSetupEvidence({ ...valid, project: "other" }, scope))
      .toThrow("scope is invalid");
    expect(() => admitMcpSetupEvidence({
      ...valid,
      connectedAt: null,
      firstReadAt: "2026-08-10T04:01:00.000Z",
    }, scope)).toThrow("requires connection evidence");
    expect(() => admitMcpSetupEvidence({
      ...valid,
      connectedAt: "2026-08-10T04:02:00.000Z",
      firstReadAt: "2026-08-10T04:01:00.000Z",
    }, scope)).toThrow("predates connection evidence");
  });

  test("rejects hidden, accessor, decorated, revoked, and credential-shaped input", () => {
    let getterCalls = 0;
    const accessor = {
      version: 1,
      accountId: scope.accountId,
      project: scope.project,
      connectedAt: "2026-08-10T04:00:00.000Z",
      firstReadAt: null,
      containsSecrets: false,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "connectedAt", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "2026-08-10T04:00:00.000Z";
      },
    });
    expect(() => admitMcpSetupEvidence(accessor, scope)).toThrow("evidence is invalid");
    expect(getterCalls).toBe(0);

    expect(() => admitMcpSetupEvidence({
      version: 1,
      accountId: scope.accountId,
      project: scope.project,
      connectedAt: null,
      firstReadAt: null,
      containsSecrets: false,
      token: "github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }, scope)).toThrow("evidence is invalid");

    expect(() => admitMcpSetupEvidence({
      version: 1,
      accountId: "acct_xgithub_pat_aaaaaaaaaaaaaaaaaaaa",
      project: scope.project,
      connectedAt: null,
      firstReadAt: null,
      containsSecrets: false,
    }, { ...scope, accountId: "acct_xgithub_pat_aaaaaaaaaaaaaaaaaaaa" }))
      .toThrow("MCP setup account is invalid");

    const { proxy, revoke } = Proxy.revocable({
      version: 1,
      accountId: scope.accountId,
      project: scope.project,
      connectedAt: null,
      firstReadAt: null,
      containsSecrets: false,
    }, {});
    revoke();
    expect(() => admitMcpSetupEvidence(proxy, scope)).toThrow("evidence is invalid");
  });
});
