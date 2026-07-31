import { describe, expect, test } from "bun:test";
import {
  compileFrontendVariantCss,
  requiredFrontendVariantCapabilities,
  requiredFrontendVariantStates,
} from "../site/labs/variant-contract.js";

const theme = {
  border: "#40515e",
  danger: "#ef826e",
  focus: "#65a9d8",
  statusActive: "#58bc8b",
  statusBlocked: "#ef826e",
  statusDone: "#9fc46d",
  statusReady: "#65a9d8",
  success: "#58bc8b",
  surface: "#10161b",
  surfaceRaised: "#1b252d",
  text: "#f1f6fa",
  textMuted: "#afbec9",
};

function variant(id: string, light: typeof theme | null, dark: typeof theme | null) {
  return {
    version: 1,
    id,
    themes: { light, dark },
    presentation: {
      fontFamily: "mono",
      iconTreatment: "solid",
      illustration: "diagram",
      panelArrangement: "map",
      radius: "none",
      texture: "grid",
    },
    invariants: {
      density: 0.75,
      focusContrast: 3,
      focusWidth: 2,
      minimumTargetSize: 28,
      motionDuration: 90,
      nonColorCues: true,
      textContrast: 4.5,
    },
    capabilities: [...requiredFrontendVariantCapabilities],
    experiment: {
      issue: 616,
      owner: "Kestrel",
      promotionStatus: "candidate",
      revision: "b".repeat(40),
      stateCoverage: [...requiredFrontendVariantStates],
      thesis: "A single-theme selector must retain its complete semantic token set.",
    },
  };
}

describe("single-theme frontend variant CSS", () => {
  test("uses the base selector for a dark-only variant", () => {
    const css = compileFrontendVariantCss(variant("dark-only", null, theme));

    expect(css).toContain(
      ':root[data-stensibly-variant="dark-only"] {\n  color-scheme: dark;',
    );
    expect(css).not.toContain(":not([data-stensibly-theme])");
    expect(css).not.toContain('[data-stensibly-theme="light"]');
    expect(css).not.toContain('[data-stensibly-theme="dark"]');
  });

  test("uses the base selector for a light-only variant", () => {
    const css = compileFrontendVariantCss(variant("light-only", theme, null));

    expect(css).toContain(
      ':root[data-stensibly-variant="light-only"] {\n  color-scheme: light;',
    );
    expect(css).not.toContain(":not([data-stensibly-theme])");
    expect(css).not.toContain('[data-stensibly-theme="light"]');
    expect(css).not.toContain('[data-stensibly-theme="dark"]');
  });

  test("retains explicit and system selection for paired themes", () => {
    const css = compileFrontendVariantCss(variant("paired", theme, theme));

    expect(css).toContain(":not([data-stensibly-theme])");
    expect(css).toContain('[data-stensibly-theme="light"]');
    expect(css).toContain('[data-stensibly-theme="dark"]');
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });
});