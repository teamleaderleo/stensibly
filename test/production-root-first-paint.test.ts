import { describe, expect, test } from "bun:test";

const readSiteFile = (name: string) => Bun.file(
  new URL(`../site/${name}`, import.meta.url),
).text();

describe("production root first paint", () => {
  test("installs the local session marker before revealing the root", async () => {
    const bridge = await readSiteFile("hosted-session-bridge.js");

    expect(bridge).toContain(
      "installFrontendLabsEntry();\npersistEndpoint(savedEndpoint);\ninstallSessionMarker(savedEndpoint);\ninstallRootModeObserver();",
    );
    expect(bridge).toContain("root.dataset.appMode = isPlausibleToken(savedMarker) ? 'connecting' : 'signed-out';");
    expect(bridge).toContain("root.dataset.rootReady = 'true';");
    expect(bridge).toContain("root.dataset.appMode = 'editing';");
    expect(bridge).toContain("root.dataset.appMode = errorVisible ? 'degraded' : 'connected';");
    expect(bridge).toContain("attributeFilter: ['hidden']");
    expect(bridge).toContain("if (typeof globalThis.MutationObserver !== 'function') {");
    expect(bridge).toContain("} catch {\n    root.dataset.appMode = 'signed-out';");
    expect(bridge).not.toContain("frontend-labs-entry.css");
  });

  test("keeps the root hidden only until the local mode is known", async () => {
    const css = await readSiteFile("calm-root.css");

    expect(css).toContain('html:not([data-root-ready="true"]) body');
    expect(css).toContain('html[data-root-ready="true"] body');
    expect(css).toContain('html[data-app-mode="connecting"] .shell::after');
    expect(css).toContain('content: "Opening project desk…";');
    expect(css).toContain('html[data-app-mode="connected"] .hero-copy');
    expect(css).toContain('html[data-app-mode="connected"] .connected-summary');
  });

  test("uses neutral surfaces with restrained lavender emphasis", async () => {
    const css = await readSiteFile("calm-root.css");
    const hosted = await readSiteFile("hosted-session.css");

    expect(css).toContain("--bg: #f5f5f4;");
    expect(css).toContain("--paper: #ffffff;");
    expect(css).toContain("--text: #181817;");
    expect(css).toContain("--accent: #8f8998;");
    expect(css).toContain("--accent-soft: #f0eef2;");
    expect(css).toContain("--bg: #0f0f10;");
    expect(css).not.toContain("#e9e5dd");
    expect(css).not.toContain("#70668b");
    expect(css).not.toContain("gradient(");
    expect(hosted).toContain("--accent-solid: #181817;");
    expect(hosted).toContain("--accent-solid: #f2f2ef;");
    expect(hosted).not.toContain("box-shadow: 0 .45rem");
  });

  test("keeps manual endpoint credentials behind a quiet direct disclosure", async () => {
    const [html, css] = await Promise.all([
      readSiteFile("index.html"),
      readSiteFile("login-scrapbook.css"),
    ]);

    expect(html).toContain("<summary>Use API token</summary>");
    expect(css).toContain(".advanced-connection summary");
    expect(css).toContain("font-size: .68rem;");
    expect(css).toContain(".login-card:not(:has(.advanced-connection[open])) .connection-note");
    expect(css).not.toContain('content: "Advanced connection";');
    expect(css).not.toContain("font-size: 0;");
  });

  test("opens connection editing controls and closes them on return", async () => {
    const bridge = await readSiteFile("root-mode-status-bridge.js");

    expect(bridge).toContain('document.querySelector(".advanced-connection")');
    expect(bridge).toContain('document.querySelector("#change-connection")');
    expect(bridge).toContain('document.querySelector("#cancel-connection")');
    expect(bridge).toContain("advancedConnection.open = open;");
    expect(bridge).toContain('root.dataset.appMode === "editing"');
    expect(bridge).toContain('root.dataset.appMode === "connected"');
    expect(bridge).toContain('root.dataset.appMode === "degraded"');
    expect(bridge).toContain('attributeFilter: ["data-app-mode"]');
  });
});
