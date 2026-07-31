# Frontend variant contract

Owner issue: [#616](https://github.com/teamleaderleo/stensibly/issues/616)  
Parent studio: [#605](https://github.com/teamleaderleo/stensibly/issues/605)

`site/labs/variant-contract.js` defines the version-1 boundary shared by visually different frontend experiments. It keeps presentation choices local while product meaning and operator capability remain common.

## Contract layers

### Semantic themes

A variant supplies a `light` theme, a `dark` theme, or both. Each theme uses the same fixed semantic colors:

- text and muted text;
- base and raised surfaces;
- border and focus;
- ready, active, blocked, and done statuses;
- danger and success.

Theme colors are lowercase six-digit hex values. Arbitrary CSS values and extra token names fail validation. Text, muted text, focus, danger, and success colors must meet the declared contrast minima against their relevant surfaces.

### Interaction invariants

Every contract declares bounded values for:

- density: `0.5–2`;
- text and muted-text contrast: at least `4.5:1`;
- focus contrast: at least `3:1`;
- focus width: `2–8px`;
- minimum target size: `24–64px`;
- routine motion duration: `0–1000ms`;
- non-color status cues: required.

Generated CSS always includes a `prefers-reduced-motion: reduce` rule that sets routine motion duration to zero. A variant may remove additional nonessential transitions; it may never restore routine motion inside that preference.

### Presentation choices

The contract accepts safe enums for:

- font family;
- radius;
- icon treatment;
- illustration treatment;
- texture;
- panel arrangement.

These choices may create substantial visual range. They may rearrange regions and change emphasis. They carry no authority, action, evidence, or recovery semantics.

### Product semantics

Every variant uses the same status set:

- `ready`;
- `active`;
- `blocked`;
- `done`.

The shared record also fixes server-issued authority, action meaning, confirmation expectations, source-linked evidence, explicit recovery, and connection behavior. A proposal that changes any of these requires a separate reviewed product issue.

### Capability parity

The required capability registry covers connection inspection/editing, project filtering, item creation and lifecycle actions, evidence inspection, worker inspection, recovery, and refresh.

Draft variants may declare missing capabilities and states. `frontendVariantCapabilityGaps()` and `frontendVariantStateGaps()` make those omissions explicit. Candidate and promoted variants must pass `assertFrontendVariantParity()` before their CSS can compile.

Required state coverage includes loading, empty, ready, active, blocked, done, degraded, error, disconnected, and unauthorized views.

### Experiment metadata

Each variant declares:

- a lowercase route ID;
- owner issue;
- bounded thesis and owner;
- promotion status: `draft`, `candidate`, `promoted`, or `retired`;
- exact revision for every reviewed state;
- state coverage.

Retired variants remain inspectable as records and no longer compile active CSS.

## Theme selection

Generated CSS supports explicit `data-stensibly-theme="light"` and `data-stensibly-theme="dark"` selection. When both themes exist and no explicit attribute is present, a `prefers-color-scheme` media query selects the default before script execution. The contract uses no browser storage and adds no runtime dependency.

A labs implementation may keep an optional local preference. The initial document should set an explicit attribute when one is already known; otherwise the media-query default avoids a script-dependent first paint.

## Promotion checklist

A variant moves from draft to candidate only when:

1. every required capability is present and has equivalent meaning;
2. every required state is represented through the shared fixture model;
3. focus, contrast, target size, non-color cues, and reduced motion pass deterministic checks;
4. wide, medium, narrow, light/dark where supported, keyboard, loading, empty, degraded, and error evidence exists;
5. action confirmation, authority, evidence, recovery, and connection behavior match the live product contract;
6. the exact revision is recorded in the labs manifest;
7. any intentional product difference has its own reviewed issue.

Promotion to the live root remains a separate decision under the parent studio and authenticated-shell work. Adding or removing a labs theme changes no live route by itself.

## Examples covered by tests

The focused tests compile:

- Quiet Control: restrained rows, system type, small radius, light and dark themes;
- Soft Companion: rounded cards, companion illustration, paper texture, light and dark themes, with explicit draft gaps;
- Field Console: dense mono presentation, map arrangement, square geometry, dark theme.

All three produce the same semantic CSS variable names. Their visual choices differ while the product contract remains stable.
