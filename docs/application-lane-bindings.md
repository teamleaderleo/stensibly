# Application lane bindings

Owner: #1729  
Implementation: #1730  
Elatura product experiment: teamleaderleo/elatura#116  
Elatura product record: teamleaderleo/elatura#119 and `docs/application-lanes.md`  
Elatura lane protocol: teamleaderleo/elatura#127  
Elatura residency owner: teamleaderleo/elatura#132  
Elatura exact-response matcher: teamleaderleo/elatura#134

## Purpose

Attach one durable Stensibly work item to one opaque Elatura application lane generation.

The binding is a durable cross-reference between two owner domains. Stensibly owns work, responsibility, wake policy, dispatch, continuation, and authority. Elatura owns the live application, lane lifecycle, and browser/runtime projection.

```text
Stensibly itemId
        |
        | ApplicationWorkBindingV1
        v
provider = elatura
laneRef + laneGeneration
```

The binding deliberately carries **no claim/responsibility generation**. A worker claim may renew, expire, hand off, or be replaced while the same live application locus continues to back the same work item. Exact current-responsibility fencing belongs to the wake/dispatch owner when an observation actually makes work eligible.

## Durable fields

`ApplicationWorkBindingV1` stores:

- binding id and binding generation;
- project;
- durable item id;
- provider `elatura`;
- opaque `laneRef`;
- exact semantic `laneGeneration`;
- capabilities the relation expects to consume;
- creation/retirement time;
- deterministic fingerprint;
- explicit zero work/application authority flags.

Browser tab ids, target ids, process ids, profile ids/paths, selectors, DOM handles, extension ports, provider UI controls, browser residency, and visual runtime state have no fields in this contract.

Claim generation, run generation, authority generation, and wake target generation also have no fields here. Their current owners re-read those facts at the transition that consumes them.

## Event admission

`matchApplicationLaneEventV1` accepts one binding and one Elatura `application-lane/v1` event.

A match requires:

- exact lane reference;
- exact lane generation;
- event time within the binding lifetime.

The admitted event vocabulary mirrors Elatura's application-local signal vocabulary:

```text
changed
generating
idle
possible_completion
error
drifted
discarded_or_unavailable
recovery_needed
available
```

Each event also carries Elatura's application-local confidence and freshness. Stensibly preserves those facts without turning them into work priority or authority.

A successful match emits `ApplicationLaneBoundObservationV1`:

```text
kind = provider_observation
provider = elatura
sourceObjectRef = laneRef
sourceObjectGeneration = laneGeneration
eventType = lane.<elatura-event-type>
itemId
confidence + freshness
sourceRefs
binding id + generation
grantsWorkAuthority = false
authorizesDispatch = false
fingerprint + idempotencyKey
```

The observation identifies **which durable work item is related to the application fact**. It does not claim which current responsibility generation should wake or which run should start.

Exact replay produces the same observation and idempotency identity.

## Existing Stensibly owners

### Same-item wake

#46 owns durable exact current-generation wake conditions. A bound `provider_observation` can feed an exact application-event condition such as `lane.changed`, `lane.possible_completion`, or `lane.recovery_needed` after the owning intake/materiality path classifies its relevance.

At consumption time #46/#47 should re-read and fence the current responsibility generation. This is the point where application evidence becomes work eligibility. The relation itself survives ordinary claim renewal or worker replacement.

Current `PromiseWakeCondition.after_event` is intentionally weaker: it keys by item-local event type plus delay and cannot fence `laneRef + laneGeneration`. Do not lower an external lane event into that form until #46 owns a source-exact mapping.

### Cross-item wake

#327 owns deterministic cross-item wake intents. Use it only when an explicit relation connects one application event to a *different* target item. Keep the source object as the opaque Elatura lane reference instead of inventing a fake source work item.

### Worker brief

#1616 may surface the binding as one current tool/source reference in a worker brief. The brief gains zero authority from the binding.

### Application operations

An authorised run may ask Elatura for `status`, `observe`, `activate`, or `screenshot`. Elatura #134 now provides a pure response matcher that binds replies to exact `requestId + laneRef + laneGeneration + operation` and rechecks requested observation budgets before consumption.

Stensibly remains responsible for current capability/authority before issuing a request and for any later work/provider effect after receiving evidence.

### Application residency

Elatura #132 owns `responsive | suspended | reclaimable` residency requests and browser-resource planning. Stensibly may eventually request a posture when current work policy calls for it; browser freeze/discard/recovery eligibility and the resulting lifecycle plan remain Elatura application-local decisions.

A `changed` or `possible_completion` event can motivate a warmer posture request. The event itself grants zero lifecycle or work permission.

## Durable identity rule

Three lifetimes stay separate:

1. **Stensibly work item** — durable outcome/locus of responsibility. The application relation may survive worker churn and claim renewal.
2. **Elatura `laneRef + laneGeneration`** — durable managed application locus. Semantic retargeting changes the lane generation and fences the old binding.
3. **Elatura browser projection** — profile/session/tab/target/window/process/DOM/runtime realization. Elatura may replace it while preserving the lane identity.

Current responsibility, run, wake, and authority generations are read from their own Stensibly owners immediately before the transition that needs them.

## Persistence requirement

The pure contract in #1730 does not choose storage yet.

Do **not** make generic item event history or artifact history the only canonical current binding store:

- hosted `getItem()` deliberately exposes a bounded event window and can report `eventsTruncated`;
- hosted artifact history is also bounded and has an explicit overflow condition;
- a fresh worker must be able to resolve current bindings without replaying or scanning an incomplete historical window.

A persistence slice should therefore expose direct current binding lookup plus append-only generation/revocation history with local/hosted parity. The existing GitHub provider-binding store is a useful replay/current-generation pattern, while its repository/installation authority semantics stay GitHub-specific.

## Dogfood path

```text
Elatura lane.changed
    -> exact work↔lane binding match
    -> authority-free provider observation for itemId
    -> #46 exact current-generation wake evaluation
    -> #47 current-generation/capability/authority re-read before dispatch
    -> bounded observe
    -> exact #134 response match
    -> screenshot when useful
    -> activate genuine application when interaction/verification is needed
```

The application observation can justify attention or a later action. Permission for that action comes from the current Stensibly owner.

— Vesper 🔥
