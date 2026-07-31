# Field Console frontend prototype

**Owner issue:** #610  
**Parent programme:** #605  
**Route:** `/labs/field-console/`

## Thesis

Field Console tests whether Stensibly benefits from a denser operational view when every visual object still carries exact identity, literal state, owner, evidence, time, and one safe next action.

The central surface is a **dependency topology**, not a geographic map. Paper Lantern has no meaningful fictional coordinates, and inventing a world map would add drama without improving a decision. Nodes show work, workers, operations, and connections. SVG lines show modeled dependencies. Every line is repeated as ordinary text below the topology.

## Shared task translation

The route uses the same fictional identities as the shared frontend-lab fixture:

- human decision: `approve-release-note`;
- workers and unhealthy lease: `moss`, `ember`;
- top recommendation: `repair-focus-order`;
- ambiguous operation: `deploy-amber`;
- connection health: `github`, `api`, `mcp`.

Each target is available through the object list and the topology. Connection health is also written in the top bar and selected-object detail. Timeline entries supplement those paths but never replace them.

## Interaction model

- `/` focuses object search.
- `J`, `K`, Arrow Down, and Arrow Up move through the visible text list.
- `1` focuses the object list, `2` the topology, `3` selected detail, and `4` the timeline.
- `D` switches between comfortable and compact density.
- Filters isolate needs-action, workers, ready work, operations, and connections.
- Selecting an object synchronizes list, topology, text relationships, detail, and timeline.
- At narrow width, opening an object moves to detail; the explicit return control restores list focus.
- Reduced-motion preferences remove nonessential timing.

## State and action boundary

State is never color-only. Every chip combines a symbol and literal text:

- `◆` human decision or ambiguity;
- `×` unhealthy or failed;
- `●` healthy or ready;
- `▲` degraded, reconnecting, or offline;
- `✓` recovered.

Every primary control is labelled **Read next action** or **Read safe next action**. Activating it announces fixture guidance only. The ambiguous publication detail retains **Reconcile before retry** guidance and performs no retry, write, network request, or simulated settlement.

## Local scenarios

`?scenario=default|empty|degraded|error` selects deterministic, reversible fixture presentation.

- **empty:** no projected objects; project identity and reset control remain.
- **degraded:** delayed review evidence is explicit while healthy reads remain usable.
- **error:** object and topology projections are unavailable; no automatic retry occurs.

The selector updates the URL without navigation. Every non-default scenario includes a local recovery control.

## Adopted patterns

- coordinated object selection from operational and geospatial tools;
- observability-style literal health and event chronology;
- compact, precise metadata from issue trackers and incident consoles;
- topology only where relationship changes the decision;
- synchronized visual and text representations;
- density as a user choice rather than permanently tiny text.

## Deliberately rejected patterns

- invented geography when no location exists;
- faux classified labels, weapon imagery, military language, or command theater;
- neon alarm styling and constant visual urgency;
- map-only navigation;
- tiny status text;
- cinematic movement for routine actions;
- color-only priority;
- automatic retry after ambiguous settlement;
- gradients, remote fonts, copied product imagery, analytics, or trackers.

## Fixture and asset boundary

The route is a classic-script, zero-build prototype using locally authored HTML, CSS, JavaScript, and inline SVG relationship lines. It contains no external image, map tile, font, library, iframe, API call, credential, private record, storage state, or live product authority.

The shared classic fixture bridge loads before the route. `fixture-bridge.js` combines exact shared identities, titles, state, detail, and operation actions with local topology positions, timestamps, and evidence labels. One cached scenario projection feeds list, topology, connection health, text relationships, selected detail, and action copy synchronously.

## Recovery

Revert the eventual Field Console squash commit to restore the planned route placeholder. No production dashboard, authentication, API, deployment, or durable state is involved.

— Cinder  
Intention: gain operational precision and relationship awareness without fake geography or manufactured urgency.
