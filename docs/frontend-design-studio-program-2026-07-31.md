# Parallel frontend design studio programme

**Date:** 2026-07-31  
**Parent:** #605  
**Product direction:** #556  
**Initial audit and prototype:** draft PR #597  
**Status:** active exploration and implementation

## Purpose

Stensibly should explore several complete frontend directions at the same time, expose them through stable preview routes, and compare them against the same operator tasks before choosing what reaches the live root.

The goal is wider than a redesign. It includes:

- task usability;
- information hierarchy;
- interaction and keyboard behavior;
- visual craft and typography;
- personality and emotional tone;
- data visualization and motion;
- accessibility and responsive behavior;
- performance and implementation cost;
- privacy, authority, recovery, and truthful state.

The live dashboard remains coherent while experimental routes make divergent ideas easy to inspect.

## Evidence classes

Keep these source types separate:

1. **Product documentation and interaction guidance** — intended behavior and supported patterns.
2. **Award pages and juries** — peer recognition for craft, novelty, impact, or technical execution.
3. **Controlled research and standards** — stronger evidence about cognition, accessibility, or measured behavior.
4. **Marketing pages and demos** — useful for product thesis and visual language; limited evidence of ordinary use.
5. **Community threads and reviews** — lived preference, frustration, fatigue, and delight; anecdotal and selection-biased.
6. **Our own task tests** — direct evidence for Stensibly's operator and work model.

A beautiful award winner may be unusable for routine work. A plain product may be deeply effective. Each reference needs an adopt, adapt, test, or reject disposition.

## Current award scan

### Apple Design Awards 2026

Source: <https://developer.apple.com/design/awards/>

The categories are a useful balanced rubric:

- Delight and Fun;
- Inclusivity;
- Innovation;
- Interaction;
- Social Impact;
- Visuals and Graphics.

Two relevant signals:

- **grug** demonstrates that a product can build a memorable voice and coherent visual joke around very small daily interactions;
- **Tide Guide** demonstrates dense live data, rich full-screen charts, animation, widgets, and a strong theme while preserving comprehension.

Apply to Stensibly:

- personality should be coherent and specific rather than generic friendliness;
- dense operational data can carry a strong visual theme when hierarchy remains crisp;
- delight, inclusivity, interaction, and visual craft deserve independent evaluation.

### Webby Awards 2026

Sources:

- <https://winners.webbyawards.com/>
- <https://winners.webbyawards.com/winners/websites-and-mobile-sites/features-design/best-user-interface>
- <https://winners.webbyawards.com/winners/websites-and-mobile-sites>

Relevant categories and examples:

- Best User Interface: DICH Fashion and Google Store;
- Best Home Page: Shopify's Renaissance Edition;
- Best Data Visualization: WWF Blue Corridors and Searching for Birds;
- nominees and honorees include Reuters, Climate TRACE, Spotify Wrapped, McKinsey Global Publishing, National Geographic, CSIS, and Desmos;
- the broader awards include AI tools such as Claude Code, Gemini, ElevenLabs, and Waymo experiences.

Apply to Stensibly:

- inspect homepage, application UI, data visualization, accessibility, editorial, immersive, AI, and “weird” categories separately;
- visual storytelling and task UI should have different budgets and success criteria;
- data visualization must make a question easier to answer, not merely fill a dashboard;
- strong homepages usually establish one immediate promise and one clear next action.

### D&AD, FWA, Awwwards, interaction and accessibility awards

Sources:

- <https://www.dandad.org/>
- <https://thefwa.org/>
- <https://awards.ixda.org/entries/>
- <https://webawards.com.au/winners/2025/>

D&AD expands the scan beyond UI into typography, motion, craft, editorial systems, experience, and concept. FWA and Awwwards expose experimental web techniques and art direction. Interaction Awards emphasize concepts and consequences. Australian Web Awards explicitly recognize accessibility.

Apply to Stensibly:

- use experimental sites to discover motion, layout, and typographic ideas;
- preserve native scrolling, visible navigation, and predictable controls;
- treat accessibility awards as a first-class taste source rather than a compliance appendix;
- learn from print, motion, and information-design awards because the Signal Atlas and Studio Canvas lanes depend on those disciplines.

## Community signal

A current web-design discussion asking for sites that are both beautiful and usable repeatedly praised obvious navigation and native scrolling and criticized scroll hijacking and animation-heavy award sites. Linear was cited as a useful balance: a few strong moments without sacrificing navigation.

Source: <https://www.reddit.com/r/web_design/comments/1v6b4vc/whats_your_favorite_most_aesthetically_pleasing/>

This is anecdotal, yet it matches a durable product rule:

> Pick a small number of memorable moments. Keep ordinary navigation ordinary.

Community research should continue across:

- web design and UI design;
- productivity and note-taking apps;
- cozy games and self-care tools;
- accessibility;
- data visualization and mapping;
- developer tools and CLIs.

Record concrete praise and complaints: discoverability, fatigue, speed, wrong turns, mobile behavior, trust, comfort, and delight.

## Functional references

### Apple

Use for legibility, inclusive defaults, coherent visual theme, careful motion, and platform-quality details. Avoid importing platform ornament without the product behavior that justifies it.

### Figma UI3

Use for:

- selected work or artifact at the center;
- contextual tools;
- collapsible regions;
- stable spatial memory;
- iterative correction from actual use.

### Linear

Use for:

- ranked focus;
- compact readable rows;
- keyboard movement;
- commands and quick switching;
- contextual actions near selection.

Avoid gray-on-gray compression and expert-only discovery.

### GitHub Primer

Use for:

- clear application regions;
- list/detail layouts;
- familiar controls;
- explicit degraded, empty, and error states;
- strong accessibility and responsive reflow.

### Discord

Use for quick switching, keyboard region navigation, persistent place, and visible connection/presence state. Avoid excessive density and notification pressure.

### ChatGPT, Canvas, Claude, Claude Code, and Codex CLI

Use for:

- explicit mode and current-context visibility;
- separating conversation, artifact, command, and progress surfaces;
- concise action progress;
- reversible history;
- command-driven navigation;
- progressive technical detail.

### Felt and Mapbox

Sources:

- <https://felt.com/product>
- <https://docs.mapbox.com/help/dive-deeper/map-design/>
- <https://demos.mapbox.com/scrollytelling/>

Use for:

- maps that begin legible before customization;
- live data and selected-object coordination;
- layers, permissions, and collaboration;
- fly-to chapters and narrative progression;
- data-driven styling.

### Palantir Gotham and Anduril Lattice

Sources:

- <https://www.palantir.com/platforms/gotham/>
- <https://www.anduril.com/lattice/command-and-control>

Use as references for situational awareness, object identity, map/detail coordination, health, timeline, and action hierarchy.

Reject:

- militarized branding;
- faux classified markings;
- constant alarm styling;
- gratuitous neon;
- tiny labels;
- dramatic maps without a text-first equivalent.

## Editorial map and motion research

### Vox Atlas and Johnny Harris workflows

Sources:

- <https://www.storybench.org/vox-atlas-producer-sam-ellis-on-his-map-animations/>
- <https://www.mindsbehindmaps.com/episode/jason-boone-animating-maps-for-a-living-working-with-johnny-harris-amp-joining-a-tech-startup-mbm56>
- <https://www.mindsbehindmaps.com/episode/creating-the-most-used-map-animation-tool-geolayers-markus-bergelt-mbm65>

Maps work because they answer “where is this and how is it related?” Vox's map practice starts from an explanatory question rather than a desire for a map. Johnny Harris–style workflows use scripts, research, scene breakdowns, layers, routes, labels, and camera moves.

A recent MapStory research paper describes a script-first process: write the narrative, tag visual milestones and camera actions, gather geographic evidence, then author animation steps.

Source: <https://doi.org/10.1145/3746059.3747664>

Apply to Stensibly:

- a Signal Atlas sequence begins with the question and exact evidence;
- every move explains a relationship, state transition, or dependency;
- selected source, time, and freshness remain visible;
- reduced-motion and static timeline forms contain the complete explanation;
- routine actions remain outside cinematic sequences.

### Visualization atlases

Research on visualization atlases identifies the combination of exploratory visualization, narration, and structured navigation as a distinct genre.

Source: <https://arxiv.org/abs/2408.07483>

This maps directly to project histories, incident recovery, provider topology, and evidence lineage.

## Visual directions

### Quiet Control — #620

A calm, restrained operator console. This is the functional baseline.

- Attention, Active, Ready, Recover;
- compact ranked rows;
- persistent detail and evidence;
- sparse purple accent;
- direct language;
- little routine ornament.

### Soft Companion — #608

A warm pastel desk influenced by cozy games, journaling, digital stationery, plush characters, and cute productivity tools.

- small original companion reflecting state;
- tactile controls and sticker-like status;
- gentle celebrations and recovery feedback;
- project rooms or desks;
- serious states stay explicit and readable;
- no guilt loops, fake friendship, infantilizing copy, or decoration over urgent work.

### Field Console — #610

A dense operational treatment.

- map/topology plus text list;
- exact object identity, time, owner, health, evidence, and next action;
- alert triage and event playback;
- comfortable and compact density;
- command and keyboard navigation;
- no military theater.

### Signal Atlas — #611

Editorial map, timeline, and causal storytelling.

- guided incident or project chapters;
- coordinated text, map/topology, timeline, and evidence;
- purposeful camera-like transitions;
- source and freshness visible;
- complete reduced-motion and static forms.

### Studio Canvas — #612

Artifact-first creative work.

- artifact at the center;
- work navigation, comments, evidence, activity, versions, and commands around it;
- compare and restore revisions;
- explicit local/proposed/attached/accepted/stale states;
- support text, code, image, diagram, and decision artifacts.

### Additional bounded experiments

Eligible after the first routes exist:

- editorial print;
- brutalist;
- pixel-art / retro computer;
- terminal-native;
- scrapbook;
- neo-skeuomorphic;
- monochrome typographic;
- maximalist graphic;
- retro-futurist.

Each still completes the shared tasks.

## Multiple-version architecture

### Recommended first architecture

Keep `/` unchanged and add route-isolated static variants:

```text
/labs/
/labs/quiet-control/
/labs/soft-companion/
/labs/field-console/
/labs/signal-atlas/
/labs/studio-canvas/
```

Advantages:

- independent direct links and browser tabs;
- no runtime assignment or analytics;
- no effect on the current root bundle;
- easy deletion and rollback;
- variants may own radically different layouts;
- same-origin preview and deployment behavior;
- suitable for the existing `site/` Vercel root.

The `/labs/` catalogue reads one bounded manifest and can offer a sandboxed side-by-side comparison.

### Branch previews

Vercel generates unique deployment URLs and supports preview environments and controlled promotion. Repository history shows Stensibly uses a guarded static deployment with `site/` as the Vercel root. Branch previews are useful for exact candidate review, while stable `/labs/` routes make retained variants easy to revisit.

Sources:

- <https://vercel.com/docs/deployments/environments>
- <https://vercel.com/docs/deployments/overview>

### Themes versus variants

CSS custom properties are suitable for presentation tokens and explicit theme switching. They cannot turn a list/detail application into a map-led atlas or artifact canvas by themselves.

Sources:

- <https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Cascading_variables/Using_custom_properties>
- <https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Properties_and_values_API/Registering_properties>

Use:

- themes for color, type, radius, icons, texture, and some density;
- layout variants for region arrangement and interaction model;
- separate product changes for capabilities and semantics.

### Feature flags

Avoid automated user assignment and remote flag dependencies in the first slice. Explicit routes provide cleaner evidence and fewer hidden states. A vendor-neutral flag contract such as OpenFeature becomes relevant only when a production rollout needs contextual assignment.

Source: <https://openfeature.dev/docs/reference/intro/>

### Storybook

Storybook supports theme switching and visual testing, and can become useful when repeated components and state matrices outweigh the zero-build frontend's simplicity.

Sources:

- <https://storybook.js.org/docs/essentials/themes>
- <https://storybook.js.org/docs/writing-tests/index>

Do not migrate merely to obtain a gallery.

## Shared comparison tasks

Every variant must prove:

1. Find the one item needing a human decision.
2. Identify active workers and an unhealthy lease.
3. Explain why the top ready item is recommended.
4. Find an ambiguous operation and its safe reconciliation action.
5. Open source, evidence, activity, and next action.
6. Determine GitHub, API, and MCP connection health.
7. Change project without losing selection or useful context.
8. Complete the flow by keyboard.
9. Complete the flow at narrow width and 200% zoom.
10. Distinguish healthy, degraded, stale, blocked, failed, ambiguous, and recovered states without color.

Record:

- completion time;
- wrong turns;
- scroll distance;
- target misses;
- terminology confusion;
- subjective comfort, trust, and delight;
- visual preference after task completion.

## Shared technical boundaries

- no gradients under `STENSIBLY.md`;
- invented, bounded, content-minimised fixtures;
- no credentials or real private payloads;
- no network calls in first concept variants;
- ordinary URLs, native scrolling, semantic HTML, and visible focus;
- complete reduced-motion paths;
- no status conveyed only by color;
- theme changes cannot hide capabilities or change action meaning;
- production promotion requires exact-head review, deterministic browser evidence, accessibility checks, and a reversible rollout.

## Delegated work

- #606 — route-isolated labs catalogue;
- #607 — shared fixture and usability harness;
- #608 — Soft Companion;
- #610 — Field Console;
- #611 — Signal Atlas;
- #612 — Studio Canvas;
- #615 — awards, product, and community inspiration index;
- #616 — theme tokens and capability parity;
- #618 — browser, screenshot, keyboard, responsive, and accessibility evidence;
- #620 — Quiet Control baseline;
- #596 — repair the current signed-out rendering defect.

## Immediate order

1. Build #606 without changing `/`.
2. Move Quiet Control into the labs route.
3. Establish the shared fixture contract.
4. Start Soft Companion and Field Console in parallel.
5. Start Signal Atlas and Studio Canvas once the shared scenario vocabulary is stable enough.
6. Add deterministic browser evidence before promoting any experiment.
7. Continue the inspiration index as an input to prototypes, not a substitute for them.

— Cinder · frontend design studio
