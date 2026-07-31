# Frontend inspiration index

Snapshot: **2026-07-31**  
Owner issue: [#615](https://github.com/teamleaderleo/stensibly/issues/615)  
Prototype programme: [#605](https://github.com/teamleaderleo/stensibly/issues/605)

This index converts visual research into testable product decisions. It links or describes source work; it contains no copied award imagery or screenshots.

## How to use this index

Evidence classes stay separate:

- `award-catalogue`: recognition of craft, novelty, or peer esteem;
- `product-doc`: intended interaction or system behavior;
- `product-changelog`: a shipped design decision and its stated rationale;
- `standard-or-study`: normative guidance or controlled research;
- `community-thread`: lived preference or friction from a self-selected discussion;
- `marketing-page`: intended positioning or selected product presentation.

Dispositions are `adopt`, `adapt`, `test`, or `reject`. An award never proves usability. A marketing page never proves shipped behavior. A community thread identifies a question to test, not a population-wide conclusion.

## Changed recommendations in this synthesis

1. **Use maps only when location or topology changes the decision.** Field Console and Signal Atlas should offer a map/topology mode, while ordinary work queues stay list- and evidence-led.
2. **Give every chart a synchronized plain-language summary and data table.** Color, hover, and visual geometry may enrich the view; they never carry the only explanation.
3. **Treat command menus as accelerators.** Visible actions, contextual menus, and documented shortcuts remain available to newcomers and pointer users.
4. **Keep personality beside operational truth.** Companion expression and celebratory motion can warm the experience; status, authority, timestamps, and recovery instructions remain literal.
5. **Make major mode changes explicit.** Opening an artifact canvas, map story, or immersive view should preserve orientation and offer a clear return path.
6. **Offer density and motion controls.** A single fixed density or animation treatment fails across casual review, sustained operations, zoomed layouts, and accessibility needs.

## Award and recognition sources

### INSP-001 — Apple Design Awards 2026: Tide Guide
- Source: [Apple, 2026 Design Award winners](https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: data visualization, visual craft, motion.
- Pattern: full-screen charts use a cohesive theme and animation while keeping hour-by-hour data readable.
- Application: Signal Atlas provider history and time-bounded capacity views.
- Disposition: `adapt` — reserve animated chart surfaces for selected detail, with text and table parity.
- Limit: Apple’s editorial award summary describes exemplary presentation; it does not report task-completion testing.

### INSP-002 — Apple Design Awards 2026: grug
- Source: [Apple, 2026 Design Award winners](https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: personality, typography, delight.
- Pattern: a tiny, coherent verbal and hand-drawn premise creates a memorable daily ritual.
- Application: Soft Companion empty states, completions, and gentle return prompts.
- Disposition: `test` — prototype one original companion voice with strict separation from operational labels.
- Limit: delight in a focused consumer app does not establish suitability for high-stakes operator copy.

### INSP-003 — Apple Design Awards 2026: NBA multi-game Vision Pro view
- Source: [Apple, 2026 Design Award winners](https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: immersive interaction, data density, anti-pattern.
- Pattern: several live feeds, floating leaderboards, and a 3D court coexist in one spatial scene.
- Application: Field Console multi-worker awareness.
- Disposition: `reject` — avoid simultaneous spectacle by default; reveal one selected worker and bounded comparisons.
- Limit: an entertainment viewing context rewards abundance differently from coordination work.

### INSP-004 — Webby 2026: WWF Blue Corridors
- Source: [Webby Best Data Visualization winners](https://winners.webbyawards.com/winners/websites-and-mobile-sites/features-design/best-data-visualization)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: data visualization, mapping, storytelling.
- Pattern: movement corridors turn a large spatial system into a traceable route and conservation story.
- Application: Signal Atlas dependency, deployment, and handoff paths.
- Disposition: `adapt` — animate only a selected path and retain a static event list beside it.
- Limit: the award listing establishes recognition and category, while detailed usability evidence is absent.

### INSP-005 — Webby 2026: Searching for Birds
- Source: [Webby Best Data Visualization winners](https://winners.webbyawards.com/winners/websites-and-mobile-sites/features-design/best-data-visualization)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: data visualization, exploration, personality.
- Pattern: a culturally approachable subject invites exploration before exposing deeper data relationships.
- Application: Signal Atlas guided incident chapters and Soft Companion learning views.
- Disposition: `test` — lead with a concrete question, then offer deeper filters.
- Limit: the award page gives category-level evidence and little detail about long-session use.

### INSP-006 — Webby 2026: The Way Meditation App
- Source: [Webby 2026 winners announcement](https://www.webbyawards.com/press/press-releases/30th-annual-webby-awards-announce-2026-winners/)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: visual function, pacing, calm interaction.
- Pattern: visual design supports a repeated reflective activity instead of competing with it.
- Application: Quiet Control review and recovery moments.
- Disposition: `adapt` — lower visual intensity after a task enters a stable state.
- Limit: award recognition says little about complex multi-user operational density.

### INSP-007 — D&AD 2026: Vaseline Verified
- Source: [Creative Bloq summary of 2026 D&AD winners](https://www.creativebloq.com/creative-inspiration/d-and-ad-pencils-2026-winners-reveal-a-geographic-shift-in-global-creativity)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: verification, trust, information hierarchy.
- Pattern: a verification mechanism answers misinformation with a recognizable, repeatable proof cue.
- Application: Quiet Control evidence heads, acceptance receipts, and source provenance.
- Disposition: `adapt` — use a consistent proof marker that opens the exact receipt and authority source.
- Limit: this is secondary award reporting about a campaign, not product usability research.

### INSP-008 — Awwwards current nominee catalogue
- Source: [Awwwards nominees](https://www.awwwards.com/websites/)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: visual craft, motion, anti-pattern.
- Pattern: many showcased sites foreground cinematic transitions, cursor effects, and novelty navigation.
- Application: all frontend lanes.
- Disposition: `reject` — do not import motion-first navigation, hidden cursors, scroll hijacking, or delayed content into the product shell.
- Limit: the catalogue selects expressive public websites and is weak evidence for sustained application work.

### INSP-009 — CSS Design Awards: MLB Live Scorebug
- Source: [CSS Design Awards project page](https://www.cssdesignawards.com/sites/mlb-live-scorebug/48948/)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: live data, hierarchy, performance.
- Pattern: a compact score surface presents changing state and supporting statistics without becoming a full dashboard.
- Application: Quiet Control active-work strip and provider-capacity summary.
- Disposition: `adapt` — use a compact live summary that links to complete evidence.
- Limit: jury and public recognition do not establish accessibility or reliability under degraded data.

### INSP-010 — iF Design ranking taxonomy
- Source: [iF Design ranking 2022–2026](https://ifdesign.com/en/if-design-ranking)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: taxonomy, interface design, service design.
- Pattern: product interfaces, data visualization, UX, service design, and workplace UX remain separately legible categories.
- Application: evaluation rubric for every labs variant.
- Disposition: `test` — score visual craft, interaction, and service recovery independently.
- Limit: ranking categories organize recognition; they do not provide a product evaluation method by themselves.

## Product systems and interaction patterns

### INSP-011 — Figma UI3: work takes center stage
- Source: [Figma, behind the UI3 redesign](https://www.figma.com/blog/behind-our-redesign-ui3/)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: hierarchy, artifact-first interaction.
- Pattern: the product chrome recedes while the selected work occupies the visual center.
- Application: Studio Canvas artifact editor and evidence review.
- Disposition: `adopt` — center the selected artifact and keep coordination controls close but subordinate.
- Limit: Figma describes its design intent; Stensibly still needs task-based evaluation with its own fixtures.

### INSP-012 — Figma UI3: minimal labels accessibility correction
- Source: [Figma, approach to designing UI3](https://www.figma.com/blog/our-approach-to-designing-ui3/)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: accessibility, hierarchy, anti-pattern.
- Pattern: an early minimal labeling system appeared elegant but harmed wayfinding and accessibility.
- Application: every labs navigation and icon-only action.
- Disposition: `reject` — avoid icon-only minimalism where labels carry orientation, authority, or recovery meaning.
- Limit: Figma reports its own design process, without publishing the complete study protocol.

### INSP-013 — Figma canvas accessibility
- Source: [Figma, building accessibility into a canvas product](https://www.figma.com/blog/building-accessibility-into-a-canvas-based-product/)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: accessibility, canvas interaction, announcements.
- Pattern: a visual canvas gains keyboard controls, screen-reader adaptation, and announcements for non-navigational changes.
- Application: Studio Canvas and any topology/map surface.
- Disposition: `adapt` — maintain a semantic DOM summary and announce selected-object and mode changes.
- Limit: implementation details reflect Figma’s domain and require a smaller Stensibly-specific contract.

### INSP-014 — Linear command menu
- Source: [Linear, new command menu](https://linear.app/changelog/2019-12-18-new-command-menu)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: interaction, keyboard efficiency.
- Pattern: a searchable command surface exposes broad capability through a few keystrokes.
- Application: Quiet Control navigation and bounded operator commands.
- Disposition: `adapt` — add a command menu after visible actions and permissions are already clear.
- Limit: a power-user accelerator can obscure discoverability when used as the only path.

### INSP-015 — Linear contextual menus
- Source: [Linear, contextual command menu](https://linear.app/changelog/2019-10-07-contextual-command-menu)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: interaction, context, pointer/keyboard parity.
- Pattern: menus open near the object when invoked by pointer and remain keyboard-addressable.
- Application: work-row, evidence, worker, and artifact actions.
- Disposition: `adopt` — bind commands to the selected object and show shortcut hints in the menu.
- Limit: contextual placement still needs zoom, viewport, and assistive-technology testing.

### INSP-016 — Linear shortcut onboarding
- Source: [Linear, first-time user experience](https://linear.app/changelog/2019-05-09-first-time-user-experience)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: onboarding, learnability.
- Pattern: first-use education introduces the command menu and searchable shortcuts instead of expecting prior knowledge.
- Application: Quiet Control and Studio Canvas first-use flows.
- Disposition: `test` — teach one useful shortcut after the user completes the corresponding visible action.
- Limit: onboarding copy must remain dismissible and should not interrupt recovery work.

### INSP-017 — GitHub Primer shared grammar
- Source: [Primer introduction](https://primer.github.io/design/guides/introduction/)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: design systems, consistency, accessibility.
- Pattern: common grammar and vocabulary support cohesive, responsive, efficient interfaces.
- Application: semantic tokens and capability parity across every labs variant.
- Disposition: `adopt` — keep product semantics and accessible component behavior shared across visual treatments.
- Limit: Primer components solve GitHub problems; Stensibly should borrow governance and semantics, not visual imitation.

### INSP-018 — GitHub accessibility annotations
- Source: [GitHub, design-system accessibility annotations](https://github.blog/engineering/user-experience/design-system-annotations-part-1-how-accessibility-gets-left-out-of-components/)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: accessibility, design handoff.
- Pattern: design annotations preserve focus order, names, semantics, and expected behavior before implementation.
- Application: labs fixture scenarios and variant review packets.
- Disposition: `adopt` — require interaction and accessibility annotations beside visual proposals.
- Limit: annotations support implementation; direct testing with assistive technology still decides acceptance.

### INSP-019 — Discord app-wide keyboard navigation
- Source: [Discord, app-wide keyboard navigation](https://discord.com/blog/how-discord-implemented-app-wide-keyboard-navigation)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: accessibility, keyboard interaction.
- Pattern: one navigation model serves keyboard users, screen-reader users, and power users, with bounded escape hatches.
- Application: all authenticated shell regions and dialogs.
- Disposition: `adapt` — define predictable region navigation before adding lane-specific shortcuts.
- Limit: Discord’s large communication hierarchy differs from Stensibly’s smaller operator workflow.

### INSP-020 — Discord display controls
- Source: [Discord, desktop display settings](https://discord.com/blog/making-discord-on-desktop-look-just-right-display-settings-to-ease-the-eyes)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: accessibility, typography, personalization.
- Pattern: text size and display controls acknowledge that one fixed density does not fit sustained use.
- Application: Quiet Control, Field Console, and 200% zoom scenarios.
- Disposition: `adopt` — keep text scaling and density compatible with reflow rather than shrinking content.
- Limit: settings add complexity and need safe defaults.

### INSP-021 — ChatGPT Canvas artifact collaboration
- Source: [OpenAI, Canvas help](https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: artifact-first interaction, versioning, contextual feedback.
- Pattern: direct editing, selected-range requests, inline suggestions, preview, and version restoration coexist beside conversation.
- Application: Studio Canvas artifact, proposal, and code review.
- Disposition: `adapt` — keep the artifact primary and attach discussion to exact selections or versions.
- Limit: product documentation describes intended capability; Stensibly requires explicit authority and durable evidence boundaries.

### INSP-022 — ChatGPT Canvas automatic mode changes
- Source: [OpenAI, Canvas help](https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: mode switching, anti-pattern.
- Pattern: the product may open a separate editing surface when it detects a long or editing-oriented task.
- Application: Studio Canvas entry and return behavior.
- Disposition: `reject` — never move an operator into a different workspace mode without a visible reason and clear return path.
- Limit: automatic opening can be convenient in conversational creation; operational context loss carries a higher cost.

### INSP-023 — Claude Code sandbox permissions
- Source: [Anthropic, Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: authority, interaction, safety.
- Pattern: safe operations can proceed inside filesystem/network controls while risky boundaries prompt for permission.
- Application: Quiet Control capability display and operator command confirmation.
- Disposition: `adopt` — show effective authority and the exact boundary a requested action would cross.
- Limit: Anthropic’s controls target a developer terminal; Stensibly remains the durable authority owner.

### INSP-024 — Claude Code checkpoints and refreshed terminal
- Source: [Anthropic, enabling Claude Code to work more autonomously](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: continuity, recovery, terminal interaction.
- Pattern: checkpoints and a refreshed terminal make longer autonomous work interruptible and recoverable.
- Application: active worker detail, handoff, and recovery views.
- Disposition: `adapt` — expose durable checkpoint identity and the next safe continuation action.
- Limit: product announcement language does not prove the visibility of every failure mode.

### INSP-025 — Felt collaborative maps
- Source: [Felt product overview](https://felt.com/product)
- Evidence: `marketing-page`; inspected 2026-07-31.
- Category: mapping, collaboration, progressive complexity.
- Pattern: a polished default map accepts direct data import and supports live collaboration before deeper customization.
- Application: Field Console topology and Signal Atlas spatial evidence.
- Disposition: `adapt` — start from a readable default and reveal layers only when they answer the selected question.
- Limit: marketing presentation demonstrates intended workflow, not independent usability evidence.

### INSP-026 — Mapbox scrollytelling chapters
- Source: [Mapbox scrollytelling example](https://docs.mapbox.com/resources/demos-and-projects/scrollytelling/)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: mapping, narrative, motion.
- Pattern: text chapters trigger bounded camera and layer changes while the reader controls progression by scrolling.
- Application: Signal Atlas incident and deployment narratives.
- Disposition: `adapt` — synchronize chapter, timeline selection, and topology state with reduced-motion fallback.
- Limit: the template accelerates presentation; it does not supply accessible narrative semantics automatically.

### INSP-027 — Grafana chart and table parity
- Source: [Grafana Saga accessibility overview](https://grafana.com/developers/saga/foundations/accessibility/accessibility-overview)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: accessibility, dashboards, data visualization.
- Pattern: chart accessibility includes color-safe palettes, patterns, and access to the data table behind a chart.
- Application: every metric, capacity, and history visualization.
- Disposition: `adopt` — synchronize chart, concise trend sentence, and machine-readable table.
- Limit: some Grafana chart accessibility work is described as planned, so Stensibly should test its own implementation directly.

### INSP-028 — Sentry selective stack-frame expansion
- Source: [Sentry, improved stack-trace legibility](https://sentry.io/changelog/2023-7-31-improved-usability-and-legibility-of-stack-traces/)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: hierarchy, debugging, progressive disclosure.
- Pattern: relevant frames stay prominent while individual hidden groups can expand without opening the entire trace.
- Application: Quiet Control evidence chains and recovery diagnostics.
- Disposition: `adopt` — keep the causal head visible and allow bounded expansion of supporting evidence.
- Limit: relevance heuristics can hide important context and need an obvious “show all” path.

### INSP-029 — Honeycomb BubbleUp comparison
- Source: [Honeycomb, BubbleUp](https://www.honeycomb.io/platform/bubbleup)
- Evidence: `marketing-page`; inspected 2026-07-31.
- Category: investigation, anomaly explanation, data visualization.
- Pattern: selecting an anomalous region produces a comparison that highlights dimensions associated with the difference.
- Application: Field Console incident triage and provider degradation analysis.
- Disposition: `test` — compare selected unhealthy evidence against a bounded healthy baseline and explain the comparison basis.
- Limit: feature marketing requires validation against Stensibly’s sparse and heterogeneous evidence.

### INSP-030 — Notion blocks and keyboard grammar
- Source: [Notion keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: composition, keyboard interaction, information architecture.
- Pattern: a common block model combines text, media, and embeds with Markdown and keyboard commands.
- Application: Studio Canvas mixed artifact and evidence documents.
- Disposition: `test` — use a small typed block set where every block preserves source and version identity.
- Limit: unrestricted block flexibility can weaken consistent operational reading order.

### INSP-031 — Craft Collections inside documents
- Source: [Craft Collections](https://support.craft.do/en/organize-and-find/collections)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: artifact organization, cards, structured content.
- Pattern: database-style collections, tables, and gallery cards live inside a narrative document.
- Application: Studio Canvas evidence sets, decisions, versions, and task collections.
- Disposition: `adapt` — embed compact structured evidence collections inside the artifact context.
- Limit: visual cards can overemphasize imagery and must retain dense text/list alternatives.

### INSP-032 — Arc Spaces
- Source: [Arc Spaces help](https://resources.arc.net/hc/en-us/articles/19228064149143-Spaces-Distinct-Browsing-Areas)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: context separation, navigation.
- Pattern: named spaces separate browsing contexts while a shared sidebar offers rapid switching.
- Application: project/workspace separation in Quiet Control.
- Disposition: `adapt` — show current workspace/project identity persistently and preserve filters per context.
- Limit: browser spaces tolerate personal customization that a shared operational product must constrain.

### INSP-033 — Arc sidebar density at scale
- Source: [Arc community thread on sidebar density](https://www.reddit.com/r/ArcBrowser/comments/1bcw7y0/is_there_a_way_to_make_the_side_bar_icons_and_text/)
- Evidence: `community-thread`; inspected 2026-07-31.
- Category: density, navigation, anti-pattern.
- Pattern: large text and icons consume the sidebar quickly as saved objects accumulate.
- Application: Quiet Control project/work navigation.
- Disposition: `reject` — avoid fixed roomy navigation for large workspaces; provide compact mode, grouping, and search.
- Limit: a self-selected thread identifies friction and does not measure its prevalence.

## Editorial, mapping, and explanatory systems

### INSP-034 — Reuters newsroom Datawrapper guide
- Source: [Reuters Graphics newsroom guide](https://reuters-graphics.github.io/newsroom-datawrapper-guide/)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: data visualization, editorial consistency.
- Pattern: shared chart defaults, color rules, and chart-choice guidance support consistent production across a newsroom.
- Application: Signal Atlas and Field Console visualization registry.
- Disposition: `adopt` — define a small approved chart vocabulary tied to question types.
- Limit: newsroom publishing and operational interaction have different update and input requirements.

### INSP-035 — New York Times Visual Investigations
- Source: [NYT Visual Investigations](https://vi.web-platforms-vi.nyti.nyt.net/spotlight/visual-investigations)
- Evidence: `marketing-page`; inspected 2026-07-31.
- Category: evidence, timeline, causal storytelling.
- Pattern: video, satellite imagery, documents, and 3D reconstruction are synchronized to establish a sequence and support a claim.
- Application: Signal Atlas incident progression and disputed handoff review.
- Disposition: `adapt` — link every explanatory chapter to exact evidence and preserve uncertainty.
- Limit: published investigations are curated narratives, while Stensibly must expose live and incomplete states.

### INSP-036 — The Pudding visual essays and open data
- Source: [The Pudding resources](https://pudding.cool/resources/)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: data storytelling, personality, reproducibility.
- Pattern: focused cultural questions combine original data, concise prose, and interactive visuals; supporting resources and datasets are published separately.
- Application: Signal Atlas guided analyses and prototype explanation pages.
- Disposition: `adapt` — begin with one question and keep method/data links adjacent.
- Limit: editorial stories are intentionally authored and do not replace free-form operator exploration.

### INSP-037 — Financial Times Visual Vocabulary
- Source: [FT Chart Doctor visual vocabulary](https://github.com/Financial-Times/chart-doctor/blob/main/visual-vocabulary/README.md)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: data visualization, chart selection, shared language.
- Pattern: chart families are selected according to the relationship the reader needs to understand.
- Application: every labs metric and history experiment.
- Disposition: `adopt` — require each chart proposal to name its analytical question and matching visual family.
- Limit: the vocabulary guides selection; accessibility, uncertainty, and interaction still require separate controls.

### INSP-038 — Reuters “Where does the US get its goods?” quiz
- Source: [Webby 2026 data-visualization nominees](https://winners.webbyawards.com/winners/websites-and-mobile-sites/features-design/best-data-visualization)
- Evidence: `award-catalogue`; inspected 2026-07-31.
- Category: interaction, learning, data visualization.
- Pattern: a prediction or quiz creates a reason to compare prior belief with the data.
- Application: onboarding and retrospective review of queue or provider assumptions.
- Disposition: `test` — use prediction only in low-stakes learning or retrospectives, never as friction before urgent facts.
- Limit: award nomination establishes recognition, not the accuracy of every interpretation.

### INSP-039 — Mapbox 3D storytelling as default
- Source: [Mapbox 3D storytelling template](https://www.mapbox.com/blog/interactive-storytelling-3d-maps-with-mapbox-gl-js-v2)
- Evidence: `product-doc`; inspected 2026-07-31.
- Category: mapping, motion, anti-pattern.
- Pattern: 3D camera movement can create immersion and geographic context.
- Application: Signal Atlas and Field Console.
- Disposition: `reject` — avoid 3D or literal geography when topology, sequence, or ownership is the actual question.
- Limit: a presentation template optimizes expressive stories, not dense operational comparison.

### INSP-040 — Grafana blank-dashboard overwhelm
- Source: [Grafana community release discussion](https://www.reddit.com/r/grafana/comments/1rerxxd/grafana_124_release_faster_and_easier_data/)
- Evidence: `community-thread`; inspected 2026-07-31.
- Category: onboarding, dashboards, templates.
- Pattern: starting from an empty dashboard can overwhelm new users; contextual starter views reduce time to a useful result.
- Application: Field Console first-use and new project setup.
- Disposition: `test` — start from a bounded operational view based on connected data, with visible provenance and editability.
- Limit: the thread reproduces product-release framing and community reaction rather than an independent controlled study.

## Accessibility, research, and community cautions

### INSP-041 — WCAG 2.2
- Source: [W3C Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/)
- Evidence: `standard-or-study`; inspected 2026-07-31.
- Category: accessibility, focus, targets, reflow.
- Pattern: perceivable, operable, understandable, and robust interaction is specified through testable success criteria.
- Application: every production and labs surface.
- Disposition: `adopt` — treat WCAG 2.2 AA as a floor and keep deterministic checks plus human assistive-technology review.
- Limit: conformance does not by itself establish ease, delight, or domain fitness.

### INSP-042 — WAI Authoring Practices
- Source: [WAI ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/)
- Evidence: `standard-or-study`; inspected 2026-07-31.
- Category: accessibility, keyboard patterns, semantics.
- Pattern: common widgets pair semantic roles with expected keyboard interaction and focus behavior.
- Application: menus, dialogs, tabs, grids, toolbars, and composite canvas controls.
- Disposition: `adopt` — begin from native HTML and use APG patterns when a composite widget is necessary.
- Limit: examples require adaptation and testing; copying ARIA attributes alone can produce broken interaction.

### INSP-043 — Figma UI rollout inconsistency
- Source: [Figma community thread, June 2026](https://www.reddit.com/r/FigmaDesign/comments/1tvxez7/has_anyone_else_noticed_that_the_new_left/)
- Evidence: `community-thread`; inspected 2026-07-31.
- Category: compatibility, onboarding, anti-pattern.
- Pattern: teams reported different interface versions during shared demos, complicating documentation and onboarding.
- Application: labs promotion and production rollout.
- Disposition: `reject` — avoid long-lived silent UI splits; expose variant/version identity and publish a migration window.
- Limit: thread participants are self-selected and report individual team experiences.

### INSP-044 — Accessibility plug-ins as complete proof
- Source: [Accessibility community thread on Figma tools](https://www.reddit.com/r/accessibility/comments/1k7fl8v/does_anyone_know_what_figma_plugins_will_help_to/)
- Evidence: `community-thread`; inspected 2026-07-31.
- Category: accessibility, testing, anti-pattern.
- Pattern: participants caution that automated design plug-ins cover a minority of interaction and cannot validate focus, announcements, or coded behavior alone.
- Application: labs acceptance evidence.
- Disposition: `reject` — never treat a plug-in score as accessibility acceptance; combine annotation, code checks, keyboard review, and assistive-technology testing.
- Limit: community estimates are informal, though the identified coverage gap is directly testable.

### INSP-045 — Operational charts without data-state explanation
- Source: [Grafana community thread on healthy/critical counts](https://www.reddit.com/r/grafana/comments/1v2nabj/dashboard_help/)
- Evidence: `community-thread`; inspected 2026-07-31.
- Category: dashboards, uncertainty, anti-pattern.
- Pattern: an empty or quiet metric can mean health, missing data, or a configuration problem.
- Application: provider capacity, worker health, and queue summaries.
- Disposition: `reject` — never display zero/empty without freshness, coverage, and missing-data semantics.
- Limit: one support discussion highlights ambiguity rather than measuring its frequency.

### INSP-046 — Arc spaces beyond a small set
- Source: [Arc community thread on 20+ spaces](https://www.reddit.com/r/ArcBrowser/comments/1qyahtf/feature_request_the_ux_for_spaces_breaks_after_10/)
- Evidence: `community-thread`; inspected 2026-07-31.
- Category: navigation, scale, anti-pattern.
- Pattern: icon-only horizontal space switching becomes difficult when contexts exceed a small number.
- Application: multi-workspace and multi-project navigation.
- Disposition: `reject` — avoid icon-only project switching; provide text labels, search, recency, and a scalable list.
- Limit: the reported 20-company workflow is an edge case, yet it usefully stress-tests navigation scale.

### INSP-047 — Data-visualization portfolio feedback
- Source: [DataIsBeautiful community feedback](https://www.reddit.com/r/dataisbeautiful/comments/1mi3nlw/feedback_on_data_visualization_portfolio/)
- Evidence: `community-thread`; inspected 2026-07-31.
- Category: data visualization, hierarchy, explanation.
- Pattern: reviewers ask each visualization to state the key insight and how the encoding reveals it.
- Application: every chart and topology proposal.
- Disposition: `adopt` — pair each visual with one bounded question and a plain-language finding or current state.
- Limit: portfolio critique is informal and context-specific.

### INSP-048 — Accessibility gaps in urgent dashboards
- Source: [Study: Accessibility Gaps in U.S. Government Dashboards](https://arxiv.org/abs/2511.06688)
- Evidence: `standard-or-study`; inspected 2026-07-31.
- Category: accessibility, dashboards, anti-pattern.
- Pattern: urgent operational dashboards may provide fewer accessible affordances; useful controls include synchronized text, semantic labels, keyboard access, and matching tables/CSV.
- Application: Field Console and provider/incident dashboards.
- Disposition: `reject` — urgency never excuses hover-only charts, unlabeled metrics, or missing text/table equivalents.
- Limit: the study audits a small public-sector sample and should guide controls rather than universal prevalence claims.

### INSP-049 — Dashboard design patterns by genre
- Source: [Study: Dashboard Design Patterns](https://arxiv.org/abs/2205.00757)
- Evidence: `standard-or-study`; inspected 2026-07-31.
- Category: dashboards, layout, evaluation.
- Pattern: narrative, analytical, and embedded dashboards combine different pattern groups and tradeoffs.
- Application: separate Quiet Control, Field Console, and Signal Atlas evaluation rubrics.
- Disposition: `adapt` — judge each lane against its intended task genre instead of one universal dashboard score.
- Limit: pattern catalogues support design discussion and still require task testing with Stensibly users and fixtures.

### INSP-050 — Discord light-theme system repair
- Source: [Discord, Light Theme Redeemed](https://discord.com/blog/light-theme-redeemed)
- Evidence: `product-changelog`; inspected 2026-07-31.
- Category: color systems, accessibility, maintainability.
- Pattern: theme repair becomes a token and testing system so future additions inherit contrast behavior.
- Application: theme-safe tokens and light/dark parity across labs variants.
- Disposition: `adopt` — validate semantic color roles across themes and prevent one-off component colors.
- Limit: Discord reports its own repair process; Stensibly needs automated contrast and interaction checks in its implementation.

## Lane reading lists and applied experiments

### Quiet Control

Read: INSP-014, 015, 017, 018, 023, 028, 041, 042, 045, 049.  
Experiments:

1. Compare a visible action bar plus command menu against command-menu-only completion for one recovery task.
2. Show one evidence head with selective expansion and measure whether users can identify authority, freshness, and next action.
3. Test compact, comfortable, and 200%-zoom layouts with the same product semantics.

### Soft Companion

Read: INSP-002, 006, 020, 041, 043, 050.  
Experiments:

1. Pair an original companion reaction with literal status and ask users to report the actual state and next action.
2. Compare restrained completion motion with reduced motion and no motion.
3. Test whether warmth improves return-to-work confidence without slowing error recognition.

### Field Console

Read: INSP-003, 009, 025, 027, 029, 040, 045, 048, 049.  
Experiments:

1. Compare a ranked list-first overview with a map/topology-first overview for the same incident fixture.
2. Require every metric card to expose coverage, freshness, missing-data meaning, text summary, and table.
3. Measure selection and recovery at wide, medium, narrow, and 200% zoom-equivalent layouts.

### Signal Atlas

Read: INSP-001, 004, 005, 026, 034–039, 047–049.  
Experiments:

1. Build one chaptered incident narrative synchronized across text, timeline, topology, and evidence.
2. Compare 2D topology, literal map, and list-only views; retain the map only where geography changes the answer.
3. Add reduced-motion and free-exploration modes without losing chapter identity.

### Studio Canvas

Read: INSP-011–013, 021, 022, 030, 031, 041, 042.  
Experiments:

1. Place one selected artifact at center with exact-version comments and a nearby evidence collection.
2. Test explicit canvas entry/return against automatic mode switching.
3. Provide semantic summary, keyboard navigation, and announcements for selected-object and version changes.

## Update protocol

For each recurring synthesis:

1. check current award winners, product documentation/changelogs, standards, research, and recent community discussions;
2. update the inspection date or replace a stale source with a stable snapshot when available;
3. name recommendations that changed and the evidence responsible;
4. revise or retire entries instead of appending duplicates;
5. keep at least ten explicit cautions;
6. link each adopted/tested lesson to an experiment or implementation issue;
7. preserve evidence class and limitations;
8. copy no raw third-party imagery into the repository without permission.
