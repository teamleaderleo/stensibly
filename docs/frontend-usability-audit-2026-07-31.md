# Frontend usability audit and control-room design direction

**Issue:** #556  
**Audit date:** 2026-07-31  
**Auditor:** Cinder  
**Baseline:** `main` at `bd3924a8c1c555ec28996bf7b3f99286ac47f183`

## Executive finding

Stensibly already has useful authenticated behavior, strong data boundaries, and several careful accessibility details. The current browser experience still presents those capabilities in the order they were implemented rather than the order an operator thinks.

The product needs a clear transition from sign-in to an operational application, then a compact focus order:

1. what needs attention;
2. what is moving;
3. what can run next;
4. what needs recovery;
5. the selected work record and its evidence;
6. connection, account, and technical detail on demand.

The recommended personality is a **quiet operator console**: warm, restrained, precise, slightly literary in labels, and confident enough to leave empty space. Personality should come from copy, callsigns, status verbs, and small crafted details. Decoration should stay subordinate to work.

## Current strengths worth preserving

- The frontend remains small static HTML, CSS, and browser modules. It is easy to inspect, deploy, and recover.
- The palette already supports light and dark modes, uses one restrained purple accent, and keeps status text alongside color.
- Controls have visible focus treatment and generally generous pointer height.
- Native dialogs, explicit labels, `aria-live`, reduced-motion handling, and full-screen narrow dialogs show accessibility intent.
- Item cards expose title, summary, next action, owner, lease, priority, and project without another network request.
- Recent adaptive refresh work reduces hidden-tab traffic and prevents browser storage failures from rejecting accepted API results.
- The no-gradient rule and the direction in #556 are good constraints. They protect the product from generic launch-page styling.

## Critical and high-impact findings

### 1. The signed-out fallback can throw

`showConnectionForm()` writes to `#disconnected-state span`, while `site/index.html` currently contains only a paragraph inside that section. No loaded script creates the missing span. A signed-out or failed-initial-connection path can therefore throw while trying to explain recovery.

**Repair:** add the missing secondary line or make the renderer tolerate its absence. Add a focused browser-contract test for the signed-out, failed-session, and bearer-token fallback paths.

### 2. Authentication never becomes a distinct application mode

`showConnectedState()` hides the connection form and reveals the dashboard. The hero, connection card, and login-oriented page composition remain in normal flow. The result reads as a sign-in page with an application appended beneath it.

**Repair:** model explicit modes — `signed-out`, `connecting`, `authenticated`, `degraded`, and `connection-editing` — on a stable root element. In authenticated mode, remove the login hero from layout and render a compact app header with workspace, connection health, command access, and account controls.

### 3. The first screen answers implementation questions before operator questions

The authenticated reading order is currently:

1. connection mechanics;
2. account and write identity;
3. four status totals;
4. a strip of active actor IDs;
5. the four-column board.

The operator first needs decisions, incidents, unhealthy runs, ready recommendations, and recoverable work. Account scopes and endpoint details are secondary until something goes wrong.

**Repair:** make `Attention`, `Active`, `Ready`, and `Recover` first-level views. Move identity, scopes, endpoint, and connection management into a compact secondary surface with visible health in the header.

### 4. The kanban board is the default mental model even where it is weakest

A four-column board treats all statuses as equally important, spends width on empty columns, and makes comparison harder when cards contain long summaries and next actions. Under 900px the layout remains four fixed 18rem columns, producing horizontal browsing rather than a useful narrow-screen mode.

**Repair:** use a dense ranked list as the default and keep the board as an optional view. On narrow screens, use one navigable list and a separate detail view. The list should show one-line rationale for rank or urgency.

### 5. There is no persistent selected-object workspace

Item detail opens in a modal. The operator loses surrounding list context, cannot move directly to the next item, and cannot keep evidence visible while comparing work. Selection is neither route-addressable nor restored as a meaningful app state.

**Repair:** adopt a list-detail layout on wide screens. Keep the selected row visible and expose detail/evidence in the adjacent pane. On compact screens, detail becomes a navigable page with a clear back path. Preserve selection per project and view when safe.

### 6. Keyboard use stops at native tab order

There is no command menu, quick switcher, row navigation, next/previous selection, or direct view shortcut. Replacing the full board HTML during refresh can also discard focus.

**Repair:** support visible and documented shortcuts:

- `/` or `Cmd/Ctrl+K`: command and quick switcher;
- `1–4`: Attention, Active, Ready, Recover when focus is outside text entry;
- `J/K` and arrow keys: move list selection;
- `Enter`: open selected detail;
- `E`: evidence/activity;
- `R`: refresh or recover depending on context;
- `Esc`: close transient surfaces or return from detail.

Every command must remain available through visible controls.

### 7. Primary metadata is frequently too small

The current CSS uses many `.65rem`, `.68rem`, `.69rem`, `.7rem`, `.72rem`, and `.76rem` values. At a 16px root these produce roughly 10–12px text in routine metadata, controls, and status. That density looks tidy in a screenshot and becomes tiring during sustained use, zoom, and low-contrast conditions.

**Repair:** define a small type scale and keep routine metadata at 12–13px minimum, body/list text at 14–16px, and important state at 14px or larger. Use weight and placement before shrinking text.

### 8. The token system is partial and page-specific

Colors are tokenized, while spacing, radius, typography, control height, icon size, and elevation use many one-off values. The interface will drift as more panels arrive.

**Repair:** adopt one explicit token set.

Recommended starting values, to test rather than canonize blindly:

```css
--space-1: 0.25rem;  /* 4 */
--space-2: 0.5rem;   /* 8 */
--space-3: 0.75rem;  /* 12 */
--space-4: 1rem;     /* 16 */
--space-5: 1.5rem;   /* 24 */
--space-6: 2rem;     /* 32 */
--space-7: 3rem;     /* 48 */

--radius-1: 0.375rem;
--radius-2: 0.5rem;
--radius-3: 0.75rem;
--radius-4: 1rem;

--text-xs: 0.75rem;
--text-sm: 0.8125rem;
--text-body: 0.875rem;
--text-ui: 1rem;
--text-title: 1.25rem;
--text-display: clamp(1.75rem, 3vw, 2.5rem);

--control-compact: 2.25rem;
--control-touch: 2.75rem;
--icon-sm: 1rem;
--icon-md: 1.25rem;
```

### 9. Routine copy exposes internal concepts too early

Examples include “Authenticated authority,” “Declared scopes,” “Active write actor,” “claim generation,” and long explanatory notes above the work. These concepts are important, yet most operator tasks need the consequence first.

**Repair:** use consequence-first language in the scan path:

- “Can edit this project” before scope strings;
- “Lease healthy for 12m” before timestamps;
- “Result may have completed — reconcile before retry” before ambiguity enums;
- “Working as Cinder” before actor-record mechanics.

Keep exact technical values in disclosure panels and copyable evidence fields.

### 10. Some current labels can weaken trust

“Tokens are not saved” is broader than actual behavior: bearer credentials are stored in `sessionStorage` for the browser session. “People and agents working here” is derived from unique `claimedBy` values on active items, which can be mistaken for a live worker roster.

**Repair:** use exact language:

- “Token stays in this browser session and is cleared when the session ends.”
- “Actors holding active items” unless live run/heartbeat data is actually present.

### 11. Dynamic board replacement creates accessibility and continuity risks

The entire board is replaced with `innerHTML` on every render and is inside an `aria-live="polite"` region. This can create excessive announcements, discard focus, and make selection unstable. Card buttons contain headings and paragraphs, which do not fit the HTML content model for a button.

**Repair:** update rows incrementally where useful, preserve focus and selection, limit live announcements to a concise status message, and use an article/list row with a separate button or link for activation.

### 12. Details are technically rich and visually flat

The item-detail dialog gives dependencies, reservations, runs, events, artifacts, and raw values similar visual weight. The operator must decode the record instead of receiving a summary and then choosing depth.

**Repair:** lead with:

- current disposition;
- why it is here;
- owner and lease health;
- next action;
- exact source/evidence head;
- one primary action.

Then disclose timeline, receipts, raw payloads, and diagnostics in grouped sections.

## Inspiration findings

### Apple Human Interface Guidelines

Useful references:

- <https://developer.apple.com/design/human-interface-guidelines/design-principles>
- <https://developer.apple.com/design/human-interface-guidelines/layout>
- <https://developer.apple.com/design/human-interface-guidelines/typography>
- <https://developer.apple.com/design/human-interface-guidelines/branding>

Adopt:

- every element earns its place;
- purpose and content lead branding;
- hierarchy remains legible when type grows;
- full layouts collapse into genuinely compact layouts when they stop fitting;
- familiar patterns carry personality better than invented interaction.

Avoid copying platform materials or glass effects. The relevant lesson is the separation of navigation/control layers from content, not Apple’s visual finish.

### Figma UI3

Useful references:

- <https://www.figma.com/blog/our-approach-to-designing-ui3/>
- <https://www.figma.com/blog/behind-our-redesign-ui3/>
- <https://help.figma.com/hc/en-us/articles/23954856027159-Navigating-UI3>

Adopt:

- keep the user’s work at the center;
- make panels collapsible and resizable where that improves focus;
- group controls by context;
- test redesigns with real users and reverse decisions when evidence warrants it;
- stage change so active users can finish work.

A Stensibly prototype should preserve the current board as an optional view during migration instead of removing it immediately.

### Linear

Useful references:

- <https://linear.app/docs/my-issues>
- <https://linear.app/docs/select-issues>

Adopt:

- curated focus order;
- compact rows with strong selection state;
- consistent keyboard movement across lists and boards;
- contextual actions near selection;
- filters and saved views that stay out of the way until needed.

Stensibly should remain semantically distinct: authority, recovery, evidence, and ambiguity must remain visible where a generic issue tracker would omit them.

### GitHub Primer

Useful references:

- <https://primer.style/product/getting-started/foundations/layout/>
- <https://primer.style/product/components/page-layout/accessibility/>
- <https://primer.style/accessibility/tools-and-resources/checklists/designer-checklist/>

Adopt:

- explicit header, navigation, main, list, and detail regions;
- responsive reflow based on task continuity;
- logical focus order and visible focus;
- degraded, empty, loading, and error states as designed states;
- checklists that designers and implementers can run before review.

### Discord

Useful references:

- <https://support.discord.com/hc/en-us/articles/31232432266647-Discord-Commands-Shortcuts-and-Navigation-Guide>
- <https://support.discord.com/hc/en-us/articles/1500000056121-Keyboard-Navigation-FAQ>
- <https://discord.com/accessibility-statement>

Adopt:

- a quick switcher for a deep information hierarchy;
- arrow-key movement within regions and Tab movement between regions;
- a highly visible focus ring when keyboard mode begins;
- shortcuts that are discoverable in the interface.

Avoid Discord’s density and icon-only complexity as a visual target.

### ChatGPT and Canvas

Useful references:

- <https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt>
- <https://help.openai.com/en/articles/10169521-projects-in-chatgpt>

Adopt:

- persistent project context in navigation;
- conversation/workspace split when a selected artifact needs direct editing or review;
- targeted actions on selected content;
- version recovery and visible collaboration history;
- a small set of context-sensitive actions instead of a permanent wall of controls.

For Stensibly, the right-side workspace is the selected work/evidence record rather than a document editor.

### Claude Code and Codex CLI

Useful references:

- <https://docs.anthropic.com/en/docs/claude-code/cli-usage>
- <https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously>
- <https://github.com/openai/codex>
- <https://github.com/openai/codex/blob/main/docs/slash_commands.md>

Adopt:

- always-visible current mode and status;
- searchable history and reusable commands;
- slash/command discovery;
- inline review of proposed actions and evidence;
- concise progress that makes a long-running agent feel alive without flooding the interface.

Translate these patterns into a command palette, action timeline, current run state, and evidence head.

### Real-product reference libraries

Useful research libraries:

- <https://mobbin.com/>
- <https://refero.design/>
- <https://pageflows.com/>

Use these to study complete flows — sign-in, empty state, list selection, command menu, degraded connection, recovery, and mobile detail — instead of collecting isolated attractive screens. A reference should answer “how does the user finish the task?”

## What agent teams do to improve frontend results

The strongest pattern is to give the agent a **design brief and evaluation loop**, not merely “make this prettier.” Anthropic’s public frontend-design skill asks the agent to choose a clear aesthetic direction, use coherent typography and color, and refine details instead of producing a generic template:

- <https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design>

Stensibly should use a narrower product-specific brief:

```text
Design an operational control room for one human coordinating many agents.
Prioritize decisions, active work, ready work, recovery, and evidence.
Use flat warm surfaces, fine borders, one restrained purple accent, system UI type,
and monospace only for identifiers, receipts, and timestamps.
No gradients, marketing hero, faux-paper decoration, floating ornamental cards,
or animation without a state-change purpose.
Preserve keyboard use, visible focus, 200% zoom, reduced motion, narrow screens,
privacy boundaries, authority wording, and recovery paths.
Prototype complete task flows before polishing isolated screens.
```

Recommended agent workflow:

1. read current product and UI instructions;
2. identify the exact operator task and evidence needed;
3. collect three real-product flow references;
4. write the information hierarchy before CSS;
5. produce a low-fidelity flow and one high-fidelity direction;
6. implement working states, including loading, empty, degraded, error, and recovery;
7. exercise keyboard-only and narrow-screen flows;
8. capture deterministic screenshots at wide, medium, and narrow widths;
9. run accessibility and visual regression checks;
10. record what was copied conceptually and what was deliberately rejected.

## Recommended layout

### Wide screens

```text
┌────────────────────────────────────────────────────────────────────┐
│ Stensibly / workspace     Search or command      Connected · Cinder│
├──────────────┬──────────────────────────┬───────────────────────────┤
│ Attention  2 │ selected view list       │ selected work             │
│ Active     4 │ compact ranked rows      │ summary + next action      │
│ Ready      9 │                          │ evidence + activity         │
│ Recover    1 │                          │ contextual actions          │
│ Projects     │                          │ progressive technical detail│
│ Connections  │                          │                            │
└──────────────┴──────────────────────────┴───────────────────────────┘
```

Starting proportions to test:

- navigation: 13–16rem;
- list: 22–28rem;
- detail: remaining width, with a useful minimum near 32rem;
- outer page max width should disappear in authenticated mode; the app should use available screen width.

### Medium screens

Use compact navigation plus a 40/60 list-detail split. Let the operator collapse either pane.

### Narrow screens

Use one pane at a time:

- top-level view tabs or a compact menu;
- list rows;
- selected detail as a separate navigable state;
- sticky back/title/action header;
- no four-column horizontal board as the routine path.

## Recommended row anatomy

Each row should answer six questions in one scan:

1. what is it;
2. why is it in this view;
3. who owns it;
4. whether the lease/run is healthy;
5. what happens next;
6. what source or evidence is current.

Example:

```text
[needs decision] Approve hosted GitHub write scope             12m
#585 · scrapbook · owner Juniper
One capability grant remains before delegated dispatch can begin.
Evidence a5e72e81 · Next: review exact tool catalogue diff
```

## Authentic personality

Use:

- callsign and small sigil in the operator menu;
- clear verbs: “needs you,” “moving,” “ready,” “recover”;
- concise status lines with rhythm;
- warm neutral surfaces and a restrained aubergine accent;
- occasional humane empty-state copy;
- subtle motion only for selection, completion, and live-state transitions.

Avoid:

- random gradients, neon, glass panels, or generic AI purple;
- every card having the same rounded floating treatment;
- giant slogans after sign-in;
- decorative tape, rotation, stickers, or faux stationery;
- excessive monospace;
- cute copy in errors, ambiguity, authority, or recovery states.

## Accessibility and quality gates

Target WCAG 2.2 AA. In particular:

- focus never becomes obscured;
- focus indication remains visible and high contrast;
- pointer targets meet or exceed 24×24 CSS pixels with adequate spacing, with 36–44px routine controls preferred;
- text and layout remain useful at 200% zoom;
- status uses text/icon plus color;
- keyboard operation covers every action;
- live regions announce concise changes instead of whole regenerated views;
- reduced motion removes nonessential transitions;
- dialogs, menus, and list/detail navigation return focus predictably.

Reference: <https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/>

## Tooling recommendation

Keep the static frontend for the first shell and list-detail slices. A framework migration would add risk before the product model is settled.

After the prototype direction is accepted, add a bounded frontend quality lane:

- Playwright for real browser task flows and deterministic screenshots;
- `@axe-core/playwright` for automated accessibility checks;
- screenshots at approximately 1440×900, 1024×768, and 390×844;
- keyboard-only task scripts;
- visual receipts for signed-out, connecting, authenticated, degraded, empty, populated, selected-detail, and command-menu states.

Radix, React, Storybook, and a full component framework can be reconsidered when the number of shared interactive primitives justifies the build and migration cost. Lucide or another icon set may be useful later; the first slice can use a tiny reviewed inline SVG set.

## Delivery sequence

### Slice 0 — correctness and trust

- repair the missing disconnected-state node;
- correct token-storage and active-actor copy;
- add focused signed-out/degraded tests.

### Slice 1 — explicit app shell

- add root app modes;
- remove login hero from authenticated flow;
- add persistent header and navigation;
- keep existing board as a selectable view.

### Slice 2 — read-only focus views

- derive Attention, Active, Ready, and Recover from existing item data where truthful;
- render compact rows;
- add wide list-detail and narrow list-to-detail navigation;
- preserve selected project/view/item.

### Slice 3 — keyboard and command layer

- add quick switcher, visible shortcut help, row movement, and contextual actions;
- preserve focus through refresh.

### Slice 4 — richer product projections

- connect real decisions, runs, lease health, ambiguity, recovery, GitHub context, and connection health as those read models land;
- replace approximations with explicit server-owned projections.

### Slice 5 — visual and task evaluation

- add browser screenshots, accessibility checks, and operator task receipts;
- compare completion time, wrong turns, scroll distance, and terminology confusion against the current UI.

## Prototype boundary

The companion standalone prototype is intentionally disconnected from production data and auth. It demonstrates layout, hierarchy, responsive behavior, selection, keyboard movement, and a command menu. It introduces no dependency, deployment, API, credential, or runtime change.
