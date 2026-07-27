import { describe, expect, test } from "bun:test";
import {
  projectSetupStatus,
  setupSteps,
  type SetupStatusInput,
  type SetupStepStates,
} from "../src/setup-status.ts";

function states(overrides: Partial<SetupStepStates> = {}): SetupStepStates {
  return {
    deployment: "missing",
    backend: "missing",
    account: "deferred",
    workspace: "missing",
    project: "missing",
    oauth_discovery: "deferred",
    mcp_connection: "missing",
    first_read: "missing",
    repository: "deferred",
    proofwake: "deferred",
    ...overrides,
  };
}

function input(overrides: Partial<SetupStatusInput> = {}): SetupStatusInput {
  return {
    mode: "local",
    observedAt: "2026-07-27T13:45:00Z",
    serviceOrigin: "http://localhost:8787",
    mcpEndpoint: "http://localhost:8787/mcp",
    steps: states(),
    ...overrides,
  };
}

describe("setup status projection", () => {
  test("projects a fresh local setup with one exact next action", () => {
    const result = projectSetupStatus(input());

    expect(result).toMatchObject({
      version: 1,
      mode: "local",
      state: "not_configured",
      observedAt: "2026-07-27T13:45:00.000Z",
      serviceOrigin: "http://localhost:8787",
      mcpEndpoint: "http://localhost:8787/mcp",
      lastVerifiedStep: null,
      nextStep: "deployment",
      requiredReady: 0,
      requiredTotal: 6,
      containsSecrets: false,
    });
    expect(result.steps).toHaveLength(setupSteps.length);
    expect(result.steps.find((entry) => entry.step === "account")?.required).toBe(false);
    expect(result.steps.find((entry) => entry.step === "oauth_discovery")?.required).toBe(false);
  });

  test("projects partial and ready local setups without making optional integrations mandatory", () => {
    const partial = projectSetupStatus(input({
      steps: states({
        deployment: "ready",
        backend: "ready",
        workspace: "ready",
      }),
      lastVerifiedStep: "workspace",
    }));
    expect(partial).toMatchObject({
      state: "partially_configured",
      nextStep: "project",
      requiredReady: 3,
      lastVerifiedStep: "workspace",
    });

    const ready = projectSetupStatus(input({
      steps: states({
        deployment: "ready",
        backend: "ready",
        workspace: "ready",
        project: "ready",
        mcp_connection: "ready",
        first_read: "ready",
        repository: "deferred",
        proofwake: "deferred",
      }),
      lastVerifiedStep: "first_read",
    }));
    expect(ready).toMatchObject({
      state: "ready",
      nextStep: null,
      requiredReady: 6,
      requiredTotal: 6,
      optionalAttentionSteps: [],
    });
  });

  test("requires account and OAuth discovery for hosted modes", () => {
    const hosted = projectSetupStatus(input({
      mode: "hosted_preview",
      serviceOrigin: "https://preview.stensibly.example",
      mcpEndpoint: "https://preview.stensibly.example/mcp",
      steps: states({
        deployment: "ready",
        backend: "ready",
        account: "missing",
        workspace: "missing",
        project: "missing",
        oauth_discovery: "missing",
        mcp_connection: "missing",
        first_read: "missing",
      }),
    }));

    expect(hosted.requiredTotal).toBe(8);
    expect(hosted.nextStep).toBe("account");
    expect(hosted.steps.find((entry) => entry.step === "account")?.required).toBe(true);
    expect(hosted.steps.find((entry) => entry.step === "oauth_discovery")?.required).toBe(true);
  });

  test("surfaces required degradation separately from optional attention", () => {
    const result = projectSetupStatus(input({
      mode: "production",
      serviceOrigin: "https://api.stensibly.example",
      mcpEndpoint: "https://api.stensibly.example/mcp",
      steps: states({
        deployment: "ready",
        backend: "degraded",
        account: "ready",
        workspace: "ready",
        project: "ready",
        oauth_discovery: "ready",
        mcp_connection: "ready",
        first_read: "ready",
        repository: "degraded",
      }),
    }));

    expect(result).toMatchObject({
      state: "degraded",
      nextStep: "backend",
      degradedSteps: ["backend", "repository"],
      optionalAttentionSteps: ["repository"],
    });
  });

  test("rejects ambiguous state, unsupported deferral, and stale verification claims", () => {
    expect(() => projectSetupStatus(input({
      steps: { ...states(), extra: "ready" } as SetupStepStates,
    }))).toThrow("exactly the supported steps");

    expect(() => projectSetupStatus(input({
      steps: states({ deployment: "deferred" }),
    }))).toThrow("cannot be deferred");

    expect(() => projectSetupStatus(input({
      lastVerifiedStep: "workspace",
    }))).toThrow("must currently be ready");
  });

  test("requires deterministic valid UTC observation timestamps", () => {
    expect(projectSetupStatus(input({
      observedAt: "2026-07-27T13:45:00.123Z",
    })).observedAt).toBe("2026-07-27T13:45:00.123Z");

    expect(() => projectSetupStatus(input({
      observedAt: "2026-07-27T13:45:00",
    }))).toThrow("ISO-8601 UTC timestamp");

    expect(() => projectSetupStatus(input({
      observedAt: "2026-07-27T13:45:00+08:00",
    }))).toThrow("ISO-8601 UTC timestamp");

    expect(() => projectSetupStatus(input({
      observedAt: "07/27/2026 13:45:00",
    }))).toThrow("ISO-8601 UTC timestamp");

    expect(() => projectSetupStatus(input({
      observedAt: "2026-02-29T13:45:00Z",
    }))).toThrow("valid calendar timestamp");
  });

  test("normalises safe public values and rejects credential-shaped or mismatched URLs", () => {
    const result = projectSetupStatus(input({
      mode: "production",
      serviceOrigin: "https://API.Stensibly.Example",
      mcpEndpoint: "https://api.stensibly.example/mcp",
      steps: states({
        account: "missing",
        oauth_discovery: "missing",
      }),
    }));
    expect(result.serviceOrigin).toBe("https://api.stensibly.example");

    expect(() => projectSetupStatus(input({
      mode: "production",
      serviceOrigin: "http://api.stensibly.example",
      mcpEndpoint: "http://api.stensibly.example/mcp",
    }))).toThrow("must use HTTPS");

    expect(() => projectSetupStatus(input({
      serviceOrigin: "http://user:secret@localhost:8787",
      mcpEndpoint: "http://localhost:8787/mcp",
    }))).toThrow("without credentials");

    expect(() => projectSetupStatus(input({
      mcpEndpoint: "http://localhost:8787/mcp?token=secret",
    }))).toThrow("service origin plus /mcp");

    expect(() => projectSetupStatus(input({
      mcpEndpoint: "http://other.local/mcp",
    }))).toThrow("service origin plus /mcp");
  });

  test("contains no arbitrary error or credential fields", () => {
    const result = projectSetupStatus(input());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("errorMessage");
    expect(Object.keys(result).sort()).toEqual([
      "containsSecrets",
      "degradedSteps",
      "lastVerifiedStep",
      "mcpEndpoint",
      "mode",
      "nextStep",
      "observedAt",
      "optionalAttentionSteps",
      "requiredReady",
      "requiredTotal",
      "serviceOrigin",
      "state",
      "steps",
      "version",
    ]);
  });
});
