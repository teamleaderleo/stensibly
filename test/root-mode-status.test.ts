import { describe, expect, test } from "bun:test";
import {
  applyRootModeStatus,
  installRootModeStatus,
  type RootAppMode,
  type RootModeElement,
  type RootModeObserver,
  type RootModeStatusElement,
} from "../site/root-mode-status.js";

function createStatus(): RootModeStatusElement & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    dataset: {} as DOMStringMap,
    attributes,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
  };
}

class FakeObserver implements RootModeObserver {
  readonly callback: () => void;
  observed: { target: RootModeElement; options: MutationObserverInit } | null = null;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  observe(target: RootModeElement, options: MutationObserverInit) {
    this.observed = { target, options };
  }

  disconnect() {}
}

describe("production root connecting status", () => {
  test("projects only connecting as a live busy status", () => {
    const status = createStatus();

    expect(applyRootModeStatus(status, "connecting")).toBe(true);
    expect(status.dataset.active).toBe("true");
    expect(status.attributes.get("aria-busy")).toBe("true");
    expect(status.attributes.get("aria-hidden")).toBe("false");

    for (const mode of ["signed-out", "connected", "degraded", "editing"] satisfies RootAppMode[]) {
      expect(applyRootModeStatus(status, mode)).toBe(false);
      expect(status.dataset.active).toBe("false");
      expect(status.attributes.get("aria-busy")).toBe("false");
      expect(status.attributes.get("aria-hidden")).toBe("true");
    }

    expect(applyRootModeStatus(status, "unknown-mode")).toBe(false);
  });

  test("follows exact root mode changes through a bounded observer", () => {
    const root = { dataset: { appMode: "connecting" } as DOMStringMap };
    const status = createStatus();
    const observer = installRootModeStatus({
      root,
      status,
      MutationObserverImpl: FakeObserver,
    }) as FakeObserver;

    expect(status.dataset.active).toBe("true");
    expect(status.attributes.get("aria-hidden")).toBe("false");
    expect(observer.observed?.target).toBe(root);
    expect(observer.observed?.options).toEqual({
      attributes: true,
      attributeFilter: ["data-app-mode"],
    });

    for (const mode of ["signed-out", "connected", "degraded", "editing"] satisfies RootAppMode[]) {
      root.dataset.appMode = mode;
      observer.callback();
      expect(status.dataset.active).toBe("false");
      expect(status.attributes.get("aria-busy")).toBe("false");
      expect(status.attributes.get("aria-hidden")).toBe("true");
    }
  });

  test("fails open when observation is unavailable", () => {
    const root = { dataset: { appMode: "connecting" } as DOMStringMap };
    const status = createStatus();
    const observer = installRootModeStatus({
      root,
      status,
      MutationObserverImpl: null,
    });

    expect(status.dataset.active).toBe("true");
    expect(status.attributes.get("aria-hidden")).toBe("false");
    expect(() => observer.disconnect()).not.toThrow();
  });

  test("ships a real live region before the hosted-session bridge", async () => {
    const [html, css, bridge] = await Promise.all([
      Bun.file(new URL("../site/index.html", import.meta.url)).text(),
      Bun.file(new URL("../site/root-mode-status.css", import.meta.url)).text(),
      Bun.file(new URL("../site/root-mode-status-bridge.js", import.meta.url)).text(),
    ]);

    expect(html).toContain('id="root-connecting-status"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain("Opening project desk…");
    expect(html.indexOf('/root-mode-status.css')).toBeGreaterThan(
      html.indexOf('/calm-root.css'),
    );
    expect(html.indexOf('/root-mode-status-bridge.js')).toBeLessThan(
      html.indexOf('/hosted-session-bridge.js'),
    );
    expect(css).toContain('html[data-app-mode="connecting"] .root-connecting-status');
    expect(css).toContain('html[data-app-mode="connecting"] .shell::after');
    expect(css).toContain("content: none");
    for (const selector of [
      'html[data-app-mode="editing"] .hero-copy',
      'html[data-app-mode="editing"] .hero-login',
      'html[data-app-mode="editing"] .login-card',
    ]) {
      expect(css).toContain(selector);
    }
    expect(bridge).toContain('setAttribute("aria-hidden", "true")');
    expect(bridge).not.toContain("console.");
  });
});
