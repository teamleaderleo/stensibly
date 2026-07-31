# Field Console frontend prototype

Owner: #610  
Programme: #605  
Route: `/labs/field-console/`

Field Console is the dense operational lane in the frontend design studio. It presents the shared fictional Paper Lantern fixture as an object list, an abstract dependency topology, a selected-object detail, explicit connection health, text relationships, and a timestamped event timeline.

## Shared fixture boundary

The route loads `../fixtures.classic.js` before its compatibility, projection-policy, and application scripts. `fixture-policy.js` consumes the immutable `StensiblyFrontendLabFixtures` contract, validates the route metadata against every shared identity and task, and derives decision, worker, ranked-work, operation, and connection presentation from that one source. `app.js` renders only the policy output.

Field Console keeps only route-specific presentation metadata locally: topology positions, fictional observation times, evidence labels, priority, read-only guidance labels, and task routing. It does not duplicate the shared record titles, state, summaries, or provider health.

## One projected truth

Every readable surface receives the same projected record set:

- object list;
- connection shelf and accessible connection summary;
- dependency topology;
- selected relationships in text;
- event timeline titles;
- selected detail and connection evidence.

The deterministic degraded scenario changes the `sync-violet` summary once in the projection policy. List, search, topology, relationship text, timeline, detail, and announcements then read that same projection. Empty and error scenarios retain project identity and recovery controls.

## Topology, not geography

The central visualization is a dependency topology, not a geographic map. It claims no latitude, infrastructure location, region, or real-world spatial precision. Every modeled relation is repeated as ordinary text, so the spatial layout is never the only source of meaning.

## Action truth

Primary controls expose read-only guidance:

- `Read next action`;
- `Read safe next action` for ambiguous settlement;
- `Read evidence summary`.

Activation announces the safe next action and explicitly says that no product action was performed. Ambiguous publication guidance says `No retry performed` and never exposes a retry control. The prototype never retries, approves, recovers, publishes, or mutates.

## Interaction and recovery

- `/` focuses object search.
- J/K and Arrow Up/Down move through the visible list.
- D toggles comfortable and compact density.
- Keys 1–4 focus objects, topology, detail, and timeline.
- Escape returns from narrow-screen detail.
- Timeline keyboard activation restores focus to the exact replacement event after rerender.
- Scenario URLs use the local history adapter, which absorbs only opaque-origin `SecurityError` and rethrows every other failure.
- Reduced motion removes decorative transitions without removing records or controls.

State is never color-only. Text labels and symbols accompany attention, healthy, unhealthy, ready, ambiguous, degraded, recovered, reconnecting, and offline states.

## Safety and recovery

No production dashboard, authentication, API, deployment, or durable state is changed. The route has no network client, browser storage, credential, private record, external asset, tracker, map tile, copied imagery, remote font, or gradient.

Recovery is source-only: revert the eventual Field Console squash commit or restore the planned manifest row and placeholder route. No data migration or operational rollback is required.
