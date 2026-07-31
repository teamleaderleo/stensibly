import { describe, expect, test } from "bun:test";
import {
  assertFrontendVariantParity,
  compileFrontendVariantCss,
  frontendVariantCapabilityGaps,
  frontendVariantProductReviewFields,
  frontendVariantProductSemantics,
  frontendVariantStateGaps,
  frontendVariantStatuses,
  parseFrontendVariantContract,
  requiredFrontendVariantCapabilities,
  requiredFrontendVariantStates,
} from "../site/labs/variant-contract.js";
import type {
  FrontendVariantContract,
} from "../site/labs/variant-contract.js";

const revision = "a".repeat(40);

const quietControl = {
  version: 1,
  id: "quiet-control",
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
    dark: {
      border: "#5f5668",
      danger: "#ef8c79",
      focus: "#b8a8e0",
      statusActive: "#70c6a8",
      statusBlocked: "#ef8c79",
      statusDone: "#9bc982",
      statusReady: "#b8a8e0",
      success: "#70c6a8",
      surface: "#17151c",
      surfaceRaised: "#24212b",
      text: "#f2eef7",
      textMuted: "#b9b1c4",
    },
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
    density: 0.9,
    focusContrast: 3,
    focusWidth: 2,
    minimumTargetSize: 32,
    motionDuration: 140,
    nonColorCues: true,
    textContrast: 4.5,
  },
  capabilities: [...requiredFrontendVariantCapabilities],
  experiment: {
    issue: 620,
    owner: "Cinder",
    promotionStatus: "candidate",
    revision,
    stateCoverage: [...requiredFrontendVariantStates],
    thesis: "A restrained operator console with ranked attention and persistent evidence.",
  },
};

const softCompanion = {
  version: 1,
  id: "soft-companion",
  themes: {
    light: {
      border: "#cbb7c6",
      danger: "#a53f5c",
      focus: "#8a4672",
      statusActive: "#29725f",
      statusBlocked: "#a53f5c",
      statusDone: "#527044",
      statusReady: "#8a4672",
      success: "#29725f",
      surface: "#fff7fb",
      surfaceRaised: "#ffffff",
      text: "#3e2f3c",
      textMuted: "#6d5869",
    },
    dark: {
      border: "#725d6c",
      danger: "#f18aa3",
      focus: "#e4a7cc",
      statusActive: "#78d0b3",
      statusBlocked: "#f18aa3",
      statusDone: "#abd38f",
      statusReady: "#e4a7cc",
      success: "#78d0b3",
      surface: "#241a22",
      surfaceRaised: "#352731",
      text: "#fff2fa",
      textMuted: "#d1b9c8",
    },
  },
  presentation: {
    fontFamily: "rounded",
    iconTreatment: "mixed",
    illustration: "companion",
    panelArrangement: "cards",
    radius: "large",
    texture: "paper",
  },
  invariants: {
    density: 1.1,
    focusContrast: 3,
    focusWidth: 3,
    minimumTargetSize: 40,
    motionDuration: 220,
    nonColorCues: true,
    textContrast: 4.5,
  },
  capabilities: requiredFrontendVariantCapabilities.filter(
    (capability) => capability !== "item.handoff" && capability !== "recovery.read",
  ),
  experiment: {
    issue: 608,
    owner: "unclaimed",
    promotionStatus: "draft",
    revision: null,
    stateCoverage: requiredFrontendVariantStates.filter(
      (state) => state !== "degraded" && state !== "error",
    ),
    thesis: "A warm productivity desk with gentle feedback and a companion character.",
  },
};

const fieldConsole = {
  version: 1,
  id: "field-console",
  themes: {
    light: null,
    dark: {
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
    },
  },
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
  capabilities: [...requiredFrontendVariantCapabilities].reverse(),
  experiment: {
    issue: 610,
    owner: "unclaimed",
    promotionStatus: "candidate",
    revision,
    stateCoverage: [...requiredFrontendVariantStates].reverse(),
    thesis: "A dense operational view with exact state, topology, timeline, and detail.",
  },
};

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

const clone = (value: unknown): Mutable<FrontendVariantContract> =>
  JSON.parse(JSON.stringify(value)) as Mutable<FrontendVariantContract>;

describe("frontend variant contract", () => {
  test("compiles three visually different variants through one semantic contract", () => {
    const quietCss = compileFrontendVariantCss(quietControl);
    const companionCss = compileFrontendVariantCss(softCompanion);
    const fieldCss = compileFrontendVariantCss(fieldConsole);

    expect(new Set([quietCss, companionCss, fieldCss]).size).toBe(3);
    for (const css of [quietCss, companionCss, fieldCss]) {
      for (const token of [
        "--stn-text:",
        "--stn-surface:",
        "--stn-focus:",
        "--stn-status-ready:",
        "--stn-status-active:",
        "--stn-status-blocked:",
        "--stn-status-done:",
        "--stn-target-size:",
        "--stn-focus-width:",
      ]) {
        expect(css).toContain(token);
      }
      expect(css).not.toContain("localStorage");
      expect(css).not.toContain("sessionStorage");
      expect(css).not.toContain("<script");
    }

    expect(quietCss).toContain("@media (prefers-color-scheme: dark)");
    expect(quietCss).toContain('[data-stensibly-theme="light"]');
    expect(quietCss).toContain('[data-stensibly-theme="dark"]');
    expect(fieldCss).not.toContain("prefers-color-scheme");
    expect(fieldCss).toContain("color-scheme: dark;");
  });

  test("canonicalizes capability and state order for deterministic CSS and records", () => {
    const parsed = parseFrontendVariantContract(fieldConsole);
    expect(parsed.capabilities).toEqual(requiredFrontendVariantCapabilities);
    expect(parsed.experiment.stateCoverage).toEqual(requiredFrontendVariantStates);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.themes.dark)).toBe(true);
    expect(Object.isFrozen(parsed.capabilities)).toBe(true);

    const reordered = clone(fieldConsole);
    reordered.capabilities.reverse();
    reordered.experiment.stateCoverage.reverse();
    expect(compileFrontendVariantCss(reordered)).toBe(
      compileFrontendVariantCss(fieldConsole),
    );
  });

  test("makes incomplete draft parity explicit and blocks incomplete reviewed variants", () => {
    expect(frontendVariantCapabilityGaps(softCompanion)).toEqual([
      "item.handoff",
      "recovery.read",
    ]);
    expect(frontendVariantStateGaps(softCompanion)).toEqual([
      "degraded",
      "error",
    ]);
    expect(() => assertFrontendVariantParity(softCompanion)).toThrow(
      "Frontend variant parity failed",
    );
    expect(compileFrontendVariantCss(softCompanion)).toContain(
      'data-stensibly-variant="soft-companion"',
    );

    const incompleteCandidate = clone(softCompanion);
    incompleteCandidate.experiment.promotionStatus = "candidate";
    incompleteCandidate.experiment.revision = revision;
    expect(() => compileFrontendVariantCss(incompleteCandidate)).toThrow(
      "Frontend variant parity failed",
    );
  });

  test("rejects unknown fields, unsafe values, incomplete themes, and injected CSS", () => {
    const extraContract = { ...clone(quietControl), unexpected: true };
    expect(() => parseFrontendVariantContract(extraContract)).toThrow(
      "must use the exact fields",
    );

    const extraTheme = clone(quietControl);
    Object.assign(extraTheme.themes.light!, { shadow: "#000000" });
    expect(() => parseFrontendVariantContract(extraTheme)).toThrow(
      "must use the exact fields",
    );

    const injected = clone(quietControl);
    injected.themes.light!.focus = "#ffffff; color: red";
    expect(() => compileFrontendVariantCss(injected)).toThrow(
      "six-digit hex color",
    );

    const unsafeOwner = clone(quietControl);
    unsafeOwner.experiment.owner = "Unsafe\nOwner";
    expect(() => parseFrontendVariantContract(unsafeOwner)).toThrow(
      "safe characters",
    );

    const noThemes = clone(quietControl);
    noThemes.themes.light = null;
    noThemes.themes.dark = null;
    expect(() => parseFrontendVariantContract(noThemes)).toThrow(
      "must define a light or dark theme",
    );
  });

  test("enforces contrast, focus, target, motion, and non-color minimums", () => {
    const weakText = clone(quietControl);
    weakText.themes.light!.text = "#777777";
    expect(() => parseFrontendVariantContract(weakText)).toThrow(
      "text/surface contrast",
    );

    const weakFocus = clone(quietControl);
    weakFocus.themes.light!.focus = "#bbbbbb";
    expect(() => parseFrontendVariantContract(weakFocus)).toThrow(
      "focus/surface contrast",
    );

    for (const [field, value] of [
      ["focusWidth", 1],
      ["minimumTargetSize", 23],
      ["motionDuration", 1_001],
      ["textContrast", 4.4],
      ["focusContrast", 2.9],
    ] as const) {
      const invalid = clone(quietControl);
      invalid.invariants[field] = value;
      expect(() => parseFrontendVariantContract(invalid)).toThrow();
    }

    const colorOnly = clone(quietControl);
    colorOnly.invariants.nonColorCues = false as true;
    expect(() => parseFrontendVariantContract(colorOnly)).toThrow(
      "require non-color status cues",
    );
  });

  test("keeps product meaning fixed outside presentation choices", () => {
    expect(frontendVariantStatuses).toEqual(["ready", "active", "blocked", "done"]);
    expect(frontendVariantProductSemantics).toEqual({
      statuses: ["ready", "active", "blocked", "done"],
      authority: "server-issued",
      actionMeaning: "shared",
      confirmation: "required-for-destructive-or-authority-expanding-actions",
      evidence: "source-linked",
      recovery: "explicit",
      connectionBehavior: "shared",
    });
    expect(Object.isFrozen(frontendVariantProductSemantics)).toBe(true);
    expect(Object.isFrozen(frontendVariantProductSemantics.statuses)).toBe(true);
    expect(frontendVariantProductReviewFields).toContain("authority");
    expect(frontendVariantProductReviewFields).toContain("recovery behavior");
  });

  test("requires exact revisions for reviewed variants and disables retired CSS", () => {
    const missingRevision = clone(quietControl);
    missingRevision.experiment.revision = null;
    expect(() => parseFrontendVariantContract(missingRevision)).toThrow(
      "require an exact revision",
    );

    const retired = clone(quietControl);
    retired.experiment.promotionStatus = "retired";
    expect(() => compileFrontendVariantCss(retired)).toThrow(
      "Retired frontend variants",
    );
  });
});