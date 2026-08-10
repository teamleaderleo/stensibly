import { describe, expect, test } from "bun:test";

const hostedAppSource = await Bun.file(
  new URL("../src/hosted-app.ts", import.meta.url),
).text();

describe("hosted MCP setup evidence production wiring", () => {
  test("shares one Convex evidence service between OAuth capture and setup-status reads", () => {
    expect(hostedAppSource).toContain("new ConvexMcpSetupEvidenceService({");
    expect(hostedAppSource).toContain("setupConnectionRecorder: setupEvidence");
    expect(hostedAppSource).toContain("mcpSetupEvidence: options.setupStatus.mcpSetupEvidence");
    expect(hostedAppSource).toContain("mcpOAuth && mcpSetupEvidence ? { mcpSetupEvidence } : {}");
  });

  test("keeps the evidence reader out of setup status when MCP OAuth is not configured", () => {
    const oauthConstruction = hostedAppSource.indexOf("const mcpOAuth = mcpOAuthFromEnv");
    const gatedSetupReader = hostedAppSource.indexOf(
      "mcpOAuth && mcpSetupEvidence ? { mcpSetupEvidence } : {}",
    );
    expect(oauthConstruction).toBeGreaterThan(-1);
    expect(gatedSetupReader).toBeGreaterThan(oauthConstruction);
  });
});
