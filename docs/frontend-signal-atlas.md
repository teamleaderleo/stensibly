# Signal Atlas frontend prototype

Owner: #611  
Programme: #605  
Route: `/labs/signal-atlas/`

Signal Atlas tests whether Stensibly can explain a complicated work lineage as a sequence without forcing routine operation into a cinematic experience.

It borrows editorial grammar—chapters, annotations, a persistent evidence rail, an abstract landscape, route lines, and a complete timeline—while keeping ordinary application controls available at every point.

## Why the landscape is abstract

Paper Lantern has no relevant real-world coordinates. The central visual is labeled an **abstract fictional work landscape**. Its forms group decision, worker, ready-work, operation, and provider records. It makes causal distance visible without claiming latitude, region, deployment location, or geographic precision.

No real data layer is used. A future real data layer would require explicit source, freshness, coordinate meaning, privacy review, and a textual equivalent.

## Narrative chapters

The route has five directly selectable chapters:

1. `approve-release-note` — the only human decision;
2. `moss` and `ember` — healthy work and an unhealthy lease;
3. `repair-focus-order` — the top recommendation and its shared leverage;
4. `deploy-amber` — ambiguous settlement and reconcile-before-retry behavior;
5. `github`, `api`, and `mcp` — capability-level provider health.

Users can open any chapter through ordinary buttons, keys 1–5, Arrow Left/Right, or J/K. The chapter order is explanatory, not authoritative.

## Static and reduced-motion parity

Every chapter appears in a complete static explanation beneath the landscape. A “Show all evidence” control opens a complete timestamped ledger without requiring chapter navigation or animated travel.

Reduced-motion mode changes chapter travel to immediate positioning. It preserves text, nodes, evidence, source, time, state, route meaning, and next action.

Native document scrolling remains enabled. There is no wheel interception, scroll snapping, forced autoplay, timed chapter advance, or locked progression.

## Persistent evidence

The selected evidence rail remains visible beside the narrative at wide widths and follows the story at narrower widths. It always writes:

- exact record identity;
- record kind;
- owner;
- observed fixture time;
- evidence head;
- source classification;
- safe next action;
- GitHub, API, and MCP capability state.

Selecting a landscape node updates the rail. The post-render focus adapter restores focus to the replacement node after the scene layer is rebuilt.

## Shared fixture contract

`../fixtures.classic.js` and `fixture-policy.js` load before `app.js`. The policy admits exact enumerable data metadata, rejects accessors and symbol or extra fields, validates the exact Signal Atlas record subset and shared task identities, and derives shared title, state, detail or reason, provider health, and operation guidance before the first render.

The app keeps only local chapter prose, landscape positions, evidence heads, times, routes, and safe explanatory guidance. One frozen projected record set feeds landscape nodes, evidence, provider capability, ledger titles and states, selection announcements, and chapter navigation. There is no post-render monkey patch or second initialization render.

## Ledger destinations and modal return

Every timestamped ledger event has one explicit chapter identity:

- `ember` and `moss` → worker health;
- `archive-coral` and `deploy-amber` → ambiguity;
- `api` → provider health;
- `approve-release-note` → decision.

The app validates that every event is covered exactly once and that each declared chapter contains its record before rendering the ledger. Activating an event opens that chapter and selected evidence directly.

The ledger modal admits a return target only when it is connected, visible, focusable, and outside the ledger. Keyboard-open from `body` falls back to **Show all evidence**. Closing after a chapter or landscape control returns there. Ledger-item navigation may focus selected evidence without being overridden by modal cleanup.

## State language

State is literal and non-color-only:

- `◆` human decision or ambiguous settlement;
- `×` unhealthy or offline;
- `▲` reconnecting;
- `✓` recovered;
- `●` healthy or recommended work.

The ambiguous operation never exposes a retry action. Its shared reconciliation action is paired with the exact local evidence-reading guidance.

## Adopted storytelling patterns

- direct, titled chapters instead of implicit scroll positions;
- one annotation that explains why the selected relationship is relevant;
- persistent source, evidence, and time;
- coordinated visual and textual records;
- an immediate exit to the complete ledger;
- route emphasis only when it clarifies cause or dependency;
- a static alternative treated as a complete experience.

## Deliberately rejected patterns

- invented geographic precision;
- scroll hijacking or wheel interception;
- forced autoplay or timed progression;
- disorienting zoom and camera travel;
- essential meaning only in motion;
- map decoration unrelated to a record;
- copied maps, imagery, or third-party visual assets;
- cinematic treatment of routine approvals;
- gradients, remote fonts, analytics, trackers, or network data.

## Fixture and authority boundary

The route is a zero-build classic-script prototype using locally authored HTML, CSS, JavaScript, inline SVG route paths, and shared fictional Paper Lantern data. It contains zero remote map tiles, images, libraries, fonts, iframes, API requests, storage state, credentials, private records, analytics, or live product actions.

## Recovery

Revert the eventual Signal Atlas squash commit to restore the planned placeholder and manifest entry. No production dashboard, authentication, API, persistence, deployment, or durable state is involved.

— Cinder  
Intention: make complex work legible as a story without making ordinary operation theatrical.
