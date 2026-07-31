# Signal Atlas frontend prototype

**Owner issue:** #611  
**Parent programme:** #605  
**Route:** `/labs/signal-atlas/`

## Thesis

Signal Atlas tests whether Stensibly can explain a complicated work lineage as a sequence without forcing routine operation into a cinematic experience.

It borrows editorial grammar—chapters, annotations, a persistent evidence rail, an abstract landscape, route lines, and a complete timeline—but keeps ordinary application controls available at every point.

## Why the landscape is abstract

Paper Lantern has no relevant real-world coordinates. The central visual is therefore labeled an **abstract fictional work landscape**. Its shapes group decision, worker, ready-work, operation, and provider records. It makes causal distance visible without claiming latitude, region, infrastructure location, or geographic precision.

No real data layer is used. A future real layer would require explicit source, freshness, coordinate meaning, privacy review, and a textual equivalent.

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

Reduced-motion mode changes chapter travel to immediate positioning. It does not remove text, nodes, evidence, source, time, state, route meaning, or next action.

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

## State language

State is literal and non-color-only:

- `◆` human decision or ambiguous settlement;
- `×` unhealthy or offline;
- `▲` reconnecting;
- `✓` recovered;
- `●` healthy or recommended work.

The ambiguous operation never exposes a retry action. Its next action is to read the remote receipt and target state before accepting or retrying.

## Adopted storytelling patterns

- direct, titled chapters rather than implicit scroll positions;
- one annotation that explains why the selected relationship matters;
- persistent source, evidence, and time;
- coordinated visual and textual records;
- an immediate exit to the complete ledger;
- route emphasis only when it clarifies cause or dependency;
- a static alternative that is not treated as a degraded experience.

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

The route is a zero-build classic-script prototype using locally authored HTML, CSS, JavaScript, inline SVG route paths, and fictional Paper Lantern identities. It contains no remote map tile, image, library, font, iframe, API request, storage state, credential, private record, analytics, or live product action.

It temporarily duplicates the shared fictional identities so it remains independently interactive in the catalogue's opaque `sandbox="allow-scripts"` frame. A later reviewed change may consume the shared classic fixture bridge once that bridge is merged and stable.

## Recovery

Revert the eventual Signal Atlas squash commit to restore the planned placeholder and manifest entry. No production dashboard, authentication, API, persistence, deployment, or durable state is involved.

— Cinder  
Intention: make complex work legible as a story without making ordinary operation theatrical.
