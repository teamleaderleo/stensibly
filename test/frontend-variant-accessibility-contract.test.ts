import { describe, expect, test } from "bun:test";
import {
  compileFrontendVariantCss,
  parseFrontendVariantContract,
} from "../site/labs/variant-contract.js";

function contract() {
  return {
    version: 1,
    id: "accessibility-check",
    themes: {
      light: {
        border: "#b8b0c0",
        danger: "#9a3e2f",
        focus: "#5d5478",
        statusActive: "#1f6f5b",
        statusBlocked: "#9a3e2f",
        statusDone: "#4d6a3d",
        statusReady: "#5d5478",
        success: "#1f6f5b",
        surface: "#f5f2ec",
        surfaceRaised: "#ffffff",
        text: "#24212b",
        textMuted: "#625d6b",
      },
      dark: null,
    },
    presentation: {
      fontFamily: "system",
      iconTreatment: "line",
      illustration: "none",
      panelArrangement: "rows",
      radius: "small",
      texture: "none",
    },
    invariants: {
      density: 1,
      focusContrast: 3,
      focusWidth: 2,
      minimumTargetSize: 32,
      motionDuration: 180,
      nonColorCues: true,
      textContrast: 4.5,
    },
    capabilities: [],
    experiment: {
      issue: 616,
      owner: "Aster",
      promotionStatus: "draft",
      revision: null,
      stateCoverage: [],
      thesis: "A focused accessibility control fixture.",
    },
  };
}

type RaisedSurfaceToken =
  | "danger"
  | "statusActive"
  | "statusBlocked"
  | "statusDone"
  | "statusReady"
  | "success";

function raisedSurfaceFailure(token: RaisedSurfaceToken) {
  const candidate = contract();
  const theme = candidate.themes.light!;
  theme.surface = "#ffffff";
  theme.surfaceRaised = "#808080";
  theme.text = "#000000";
  theme.textMuted = "#000000";
  theme.focus = "#000000";
  theme.statusReady = "#000000";
  theme.statusActive = "#000000";
  theme.statusBlocked = "#000000";
  theme.statusDone = "#000000";
  theme.danger = "#000000";
  theme.success = "#000000";
  theme[token] = theme.surfaceRaised;
  return candidate;
}

describe("frontend variant accessibility invariants", () => {
  test("generates a script-free reduced-motion override for every theme", () => {
    const css = compileFrontendVariantCss(contract());
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(
      ':root[data-stensibly-variant="accessibility-check"] {\n'
        + "    --stn-motion-duration: 0ms;\n",
    );
    expect(css).not.toContain("localStorage");
    expect(css).not.toContain("sessionStorage");
  });

  test("applies the declared text contrast floor to muted text", () => {
    const weakMutedText = contract();
    weakMutedText.themes.light!.textMuted = "#777777";
    expect(() => parseFrontendVariantContract(weakMutedText)).toThrow(
      "muted text/surface contrast",
    );
  });

  test("requires every status indicator to remain visible on both surfaces", () => {
    for (const status of ["statusReady", "statusBlocked"] as const) {
      const invisibleStatus = contract();
      invisibleStatus.themes.light![status] = invisibleStatus.themes.light!.surface;
      expect(() => parseFrontendVariantContract(invisibleStatus)).toThrow(
        `${status}/surface contrast`,
      );
    }

    for (const status of ["statusActive", "statusDone"] as const) {
      expect(() => parseFrontendVariantContract(raisedSurfaceFailure(status))).toThrow(
        `${status}/raised surface contrast`,
      );
    }
  });

  test("requires danger and success feedback to remain visible on raised surfaces", () => {
    for (const token of ["danger", "success"] as const) {
      expect(() => parseFrontendVariantContract(raisedSurfaceFailure(token))).toThrow(
        `${token}/raised surface contrast`,
      );
    }
  });
});
