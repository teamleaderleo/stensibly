import { describe, expect, test } from "bun:test";

const hostedAppSource = await Bun.file(
  new URL("../src/hosted-app.ts", import.meta.url),
).text();

describe("hosted MCP setup evidence production wiring", () => {
  test("shares one Convex evidence service across OAuth capture, setup reads, first-read recording, and request lifetime", () => {
    expect(hostedAppSource).toContain("new ConvexMcpSetupEvidenceService({");
    expect(hostedAppSource).toContain("setupConnectionRecorder: setupEvidence");
    expect(hostedAppSource).toContain("mcpSetupEvidence: options.setupStatus.mcpSetupEvidence");
    expect(hostedAppSource).toContain("mcpSetupFirstReadRecorder: options.mcpSetupFirstReadRecorder");
    expect(hostedAppSource).toContain("mcpSetupFirstReadRecorder: mcpSetupEvidence");
    expect(hostedAppSource).toContain("waitUntil: (promise) => context.executionCtx.waitUntil(promise)");
    expect(hostedAppSource).toContain("mcpOAuth && mcpSetupEvidence ? { mcpSetupEvidence } : {}");
  });

  test("keeps both setup evidence readers and recorders out when MCP OAuth is not configured", () => {
    const oauthConstruction = hostedAppSource.indexOf("const mcpOAuth = mcpOAuthFromEnv");
    const gatedFirstReadRecorder = hostedAppSource.indexOf(
      "mcpOAuth && mcpSetupEvidence\n      ? { mcpSetupFirstReadRecorder: mcpSetupEvidence }",
    );
    const gatedSetupReader = hostedAppSource.indexOf(
      "mcpOAuth && mcpSetupEvidence ? { mcpSetupEvidence } : {}",
    );
    expect(oauthConstruction).toBeGreaterThan(-1);
    expect(gatedFirstReadRecorder).toBeGreaterThan(oauthConstruction);
    expect(gatedSetupReader).toBeGreaterThan(oauthConstruction);
  });
});
