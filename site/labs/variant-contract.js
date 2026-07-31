export const frontendVariantContractVersion = 1;

export const frontendVariantStatuses = Object.freeze([
  "ready",
  "active",
  "blocked",
  "done",
]);

export const requiredFrontendVariantStates = Object.freeze([
  "loading",
  "empty",
  "ready",
  "active",
  "blocked",
  "done",
  "degraded",
  "error",
  "disconnected",
  "unauthorized",
]);

export const requiredFrontendVariantCapabilities = Object.freeze([
  "connection.read",
  "connection.edit",
  "project.filter",
  "item.create",
  "item.read",
  "item.claim",
  "item.progress",
  "item.block",
  "item.complete",
  "item.handoff",
  "evidence.read",
  "worker.read",
  "recovery.read",
  "refresh",
]);

export const frontendVariantProductSemantics = deepFreeze({
  statuses: [...frontendVariantStatuses],
  authority: "server-issued",
  actionMeaning: "shared",
  confirmation: "required-for-destructive-or-authority-expanding-actions",
  evidence: "source-linked",
  recovery: "explicit",
  connectionBehavior: "shared",
});

export const frontendVariantProductReviewFields = Object.freeze([
  "status names or meanings",
  "authority",
  "available actions or read projections",
  "action meaning",
  "confirmation requirements",
  "evidence semantics",
  "recovery behavior",
  "connection behavior",
]);

const contractKeys = [
  "capabilities",
  "experiment",
  "id",
  "invariants",
  "presentation",
  "themes",
  "version",
];
const themeSetKeys = ["dark", "light"];
const themeKeys = [
  "border",
  "danger",
  "focus",
  "statusActive",
  "statusBlocked",
  "statusDone",
  "statusReady",
  "success",
  "surface",
  "surfaceRaised",
  "text",
  "textMuted",
];
const statusColorKeys = [
  "statusActive",
  "statusBlocked",
  "statusDone",
  "statusReady",
];
const presentationKeys = [
  "fontFamily",
  "iconTreatment",
  "illustration",
  "panelArrangement",
  "radius",
  "texture",
];
const invariantKeys = [
  "density",
  "focusContrast",
  "focusWidth",
  "minimumTargetSize",
  "motionDuration",
  "nonColorCues",
  "textContrast",
];
const experimentKeys = [
  "issue",
  "owner",
  "promotionStatus",
  "revision",
  "stateCoverage",
  "thesis",
];

const fontFamilies = new Set(["system", "serif", "mono", "rounded"]);
const iconTreatments = new Set(["line", "solid", "mixed"]);
const illustrations = new Set(["none", "diagram", "companion", "editorial"]);
const panelArrangements = new Set(["rows", "cards", "split", "canvas", "map"]);
const radii = new Set(["none", "small", "medium", "large", "pill"]);
const textures = new Set(["none", "paper", "grid", "noise"]);
const promotionStatuses = new Set(["draft", "candidate", "promoted", "retired"]);
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;
const colorPattern = /^#[0-9a-f]{6}$/u;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

const cssTokenNames = Object.freeze({
  border: "--stn-border",
  danger: "--stn-danger",
  focus: "--stn-focus",
  statusActive: "--stn-status-active",
  statusBlocked: "--stn-status-blocked",
  statusDone: "--stn-status-done",
  statusReady: "--stn-status-ready",
  success: "--stn-success",
  surface: "--stn-surface",
  surfaceRaised: "--stn-surface-raised",
  text: "--stn-text",
  textMuted: "--stn-text-muted",
});

const fontFamilyCss = Object.freeze({
  system: "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, serif",
  mono: "ui-monospace, SFMono-Regular, Consolas, monospace",
  rounded: '"Arial Rounded MT Bold", ui-rounded, system-ui, sans-serif',
});

const radiusCss = Object.freeze({
  none: "0px",
  small: "4px",
  medium: "8px",
  large: "16px",
  pill: "999px",
});

export function parseFrontendVariantContract(value) {
  const record = exactRecord(value, contractKeys, "Frontend variant contract");
  if (record.version !== frontendVariantContractVersion) {
    throw new TypeError(`Frontend variant contract version must be ${frontendVariantContractVersion}`);
  }

  const id = safeText(record.id, 48, "Frontend variant id");
  if (!idPattern.test(id)) {
    throw new TypeError("Frontend variant id must be a lowercase hyphenated slug");
  }

  const invariants = parseInvariants(record.invariants);
  const themesRecord = exactRecord(record.themes, themeSetKeys, "Frontend variant themes");
  const light = themesRecord.light === null
    ? null
    : parseTheme(themesRecord.light, "Frontend variant light theme", invariants);
  const dark = themesRecord.dark === null
    ? null
    : parseTheme(themesRecord.dark, "Frontend variant dark theme", invariants);
  if (!light && !dark) {
    throw new TypeError("Frontend variant must define a light or dark theme");
  }

  const presentationRecord = exactRecord(
    record.presentation,
    presentationKeys,
    "Frontend variant presentation",
  );
  const presentation = Object.freeze({
    fontFamily: knownValue(
      presentationRecord.fontFamily,
      fontFamilies,
      "Frontend variant font family",
    ),
    iconTreatment: knownValue(
      presentationRecord.iconTreatment,
      iconTreatments,
      "Frontend variant icon treatment",
    ),
    illustration: knownValue(
      presentationRecord.illustration,
      illustrations,
      "Frontend variant illustration",
    ),
    panelArrangement: knownValue(
      presentationRecord.panelArrangement,
      panelArrangements,
      "Frontend variant panel arrangement",
    ),
    radius: knownValue(
      presentationRecord.radius,
      radii,
      "Frontend variant radius",
    ),
    texture: knownValue(
      presentationRecord.texture,
      textures,
      "Frontend variant texture",
    ),
  });

  const capabilities = parseKnownArray(
    record.capabilities,
    requiredFrontendVariantCapabilities,
    "Frontend variant capabilities",
  );

  const experimentRecord = exactRecord(
    record.experiment,
    experimentKeys,
    "Frontend variant experiment",
  );
  const promotionStatus = knownValue(
    experimentRecord.promotionStatus,
    promotionStatuses,
    "Frontend variant promotion status",
  );
  const revision = experimentRecord.revision === null
    ? null
    : safeText(experimentRecord.revision, 40, "Frontend variant revision");
  if (revision !== null && !revisionPattern.test(revision)) {
    throw new TypeError("Frontend variant revision must be a full lowercase Git revision");
  }
  if (promotionStatus !== "draft" && revision === null) {
    throw new TypeError("Reviewed frontend variants require an exact revision");
  }

  const experiment = Object.freeze({
    issue: positiveInteger(experimentRecord.issue, "Frontend variant issue"),
    owner: safeText(experimentRecord.owner, 80, "Frontend variant owner"),
    promotionStatus,
    revision,
    stateCoverage: parseKnownArray(
      experimentRecord.stateCoverage,
      requiredFrontendVariantStates,
      "Frontend variant state coverage",
    ),
    thesis: safeText(experimentRecord.thesis, 320, "Frontend variant thesis"),
  });

  return deepFreeze({
    version: frontendVariantContractVersion,
    id,
    themes: { light, dark },
    presentation,
    invariants,
    capabilities,
    experiment,
  });
}

export function frontendVariantCapabilityGaps(value) {
  const contract = parseFrontendVariantContract(value);
  return Object.freeze(requiredFrontendVariantCapabilities.filter(
    (capability) => !contract.capabilities.includes(capability),
  ));
}

export function frontendVariantStateGaps(value) {
  const contract = parseFrontendVariantContract(value);
  return Object.freeze(requiredFrontendVariantStates.filter(
    (state) => !contract.experiment.stateCoverage.includes(state),
  ));
}

export function assertFrontendVariantParity(value) {
  const contract = parseFrontendVariantContract(value);
  const capabilityGaps = requiredFrontendVariantCapabilities.filter(
    (capability) => !contract.capabilities.includes(capability),
  );
  const stateGaps = requiredFrontendVariantStates.filter(
    (state) => !contract.experiment.stateCoverage.includes(state),
  );
  if (capabilityGaps.length || stateGaps.length) {
    const details = [
      capabilityGaps.length ? `capabilities: ${capabilityGaps.join(", ")}` : null,
      stateGaps.length ? `states: ${stateGaps.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    throw new TypeError(`Frontend variant parity failed (${details})`);
  }
  return contract;
}

export function compileFrontendVariantCss(value) {
  const parsed = parseFrontendVariantContract(value);
  const contract = parsed.experiment.promotionStatus === "draft"
    ? parsed
    : assertFrontendVariantParity(parsed);
  if (contract.experiment.promotionStatus === "retired") {
    throw new TypeError("Retired frontend variants do not compile active CSS");
  }

  const selector = `:root[data-stensibly-variant="${contract.id}"]`;
  const blocks = [];
  if (contract.themes.light && contract.themes.dark) {
    blocks.push(cssRule(
      `${selector}:not([data-stensibly-theme])`,
      "light",
      contract.themes.light,
      contract,
    ));
    blocks.push(cssRule(
      `${selector}[data-stensibly-theme="light"]`,
      "light",
      contract.themes.light,
      contract,
    ));
    blocks.push(cssRule(
      `${selector}[data-stensibly-theme="dark"]`,
      "dark",
      contract.themes.dark,
      contract,
    ));
    blocks.push([
      "@media (prefers-color-scheme: dark) {",
      indent(cssRule(
        `${selector}:not([data-stensibly-theme])`,
        "dark",
        contract.themes.dark,
        contract,
      )),
      "}",
    ].join("\n"));
  } else {
    const themeName = contract.themes.light ? "light" : "dark";
    blocks.push(cssRule(
      selector,
      themeName,
      contract.themes[themeName],
      contract,
    ));
  }
  blocks.push([
    "@media (prefers-reduced-motion: reduce) {",
    `  ${selector} {`,
    "    --stn-motion-duration: 0ms;",
    "  }",
    "}",
  ].join("\n"));

  return `${blocks.join("\n\n")}\n`;
}

function parseInvariants(value) {
  const record = exactRecord(value, invariantKeys, "Frontend variant invariants");
  const invariants = {
    density: boundedNumber(record.density, 0.5, 2, "Frontend variant density"),
    focusContrast: boundedNumber(
      record.focusContrast,
      3,
      21,
      "Frontend variant focus contrast",
    ),
    focusWidth: boundedInteger(record.focusWidth, 2, 8, "Frontend variant focus width"),
    minimumTargetSize: boundedInteger(
      record.minimumTargetSize,
      24,
      64,
      "Frontend variant minimum target size",
    ),
    motionDuration: boundedInteger(
      record.motionDuration,
      0,
      1_000,
      "Frontend variant motion duration",
    ),
    nonColorCues: record.nonColorCues,
    textContrast: boundedNumber(
      record.textContrast,
      4.5,
      21,
      "Frontend variant text contrast",
    ),
  };
  if (invariants.nonColorCues !== true) {
    throw new TypeError("Frontend variants require non-color status cues");
  }
  return Object.freeze(invariants);
}

function parseTheme(value, label, invariants) {
  const record = exactRecord(value, themeKeys, label);
  const theme = {};
  for (const key of themeKeys) {
    if (typeof record[key] !== "string" || !colorPattern.test(record[key])) {
      throw new TypeError(`${label} ${key} must be a lowercase six-digit hex color`);
    }
    theme[key] = record[key];
  }

  requireContrast(theme.text, theme.surface, invariants.textContrast, `${label} text/surface`);
  requireContrast(
    theme.text,
    theme.surfaceRaised,
    invariants.textContrast,
    `${label} text/raised surface`,
  );
  requireContrast(
    theme.textMuted,
    theme.surface,
    invariants.textContrast,
    `${label} muted text/surface`,
  );
  requireContrast(
    theme.textMuted,
    theme.surfaceRaised,
    invariants.textContrast,
    `${label} muted text/raised surface`,
  );
  requireContrast(theme.focus, theme.surface, invariants.focusContrast, `${label} focus/surface`);
  requireContrast(
    theme.focus,
    theme.surfaceRaised,
    invariants.focusContrast,
    `${label} focus/raised surface`,
  );
  for (const statusKey of statusColorKeys) {
    requireContrast(theme[statusKey], theme.surface, 3, `${label} ${statusKey}/surface`);
    requireContrast(
      theme[statusKey],
      theme.surfaceRaised,
      3,
      `${label} ${statusKey}/raised surface`,
    );
  }
  requireContrast(theme.danger, theme.surface, 3, `${label} danger/surface`);
  requireContrast(
    theme.danger,
    theme.surfaceRaised,
    3,
    `${label} danger/raised surface`,
  );
  requireContrast(theme.success, theme.surface, 3, `${label} success/surface`);
  requireContrast(
    theme.success,
    theme.surfaceRaised,
    3,
    `${label} success/raised surface`,
  );
  return Object.freeze(theme);
}

function cssRule(selector, themeName, theme, contract) {
  const declarations = [
    `color-scheme: ${themeName};`,
    ...themeKeys.map((key) => `${cssTokenNames[key]}: ${theme[key]};`),
    `--stn-font-family: ${fontFamilyCss[contract.presentation.fontFamily]};`,
    `--stn-radius: ${radiusCss[contract.presentation.radius]};`,
    `--stn-density: ${canonicalNumber(contract.invariants.density)};`,
    `--stn-motion-duration: ${contract.invariants.motionDuration}ms;`,
    `--stn-target-size: ${contract.invariants.minimumTargetSize}px;`,
    `--stn-focus-width: ${contract.invariants.focusWidth}px;`,
  ];
  return `${selector} {\n${declarations.map((line) => `  ${line}`).join("\n")}\n}`;
}

function exactRecord(value, expectedKeys, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== expectedKeys.join(",")) {
    throw new TypeError(`${label} must use the exact fields: ${expectedKeys.join(", ")}`);
  }
  return value;
}

function parseKnownArray(value, allowedValues, label) {
  if (!Array.isArray(value) || value.length > allowedValues.length) {
    throw new TypeError(`${label} must be an array of known unique values`);
  }
  const selected = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !allowedValues.includes(item)) {
      throw new TypeError(`${label} contains an unsupported value`);
    }
    if (selected.has(item)) throw new TypeError(`${label} values must be unique`);
    selected.add(item);
  }
  return Object.freeze(allowedValues.filter((item) => selected.has(item)));
}

function knownValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`${label} is unsupported`);
  }
  return value;
}

function safeText(value, maximum, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || unsafeTextPattern.test(value)
  ) {
    throw new TypeError(`${label} must contain 1-${maximum} safe characters`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boundedNumber(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireContrast(foreground, background, minimum, label) {
  const ratio = contrastRatio(foreground, background);
  if (ratio + Number.EPSILON < minimum) {
    throw new TypeError(`${label} contrast ${ratio.toFixed(2)} is below ${minimum}`);
  }
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/gu).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function canonicalNumber(value) {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/u, "").replace(/\.$/u, "");
}

function indent(value) {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function isPlainRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
