# Application lane bindings

Owner: #1729  
Elatura counterpart: teamleaderleo/elatura#116  
Elatura product record: teamleaderleo/elatura#119 and `docs/application-lanes.md`

## Purpose

Attach one current Stensibly work/responsibility generation to one opaque Elatura application lane generation.

The binding is a cross-reference. Stensibly owns work, wake policy, dispatch, continuation, and authority. Elatura owns the live application and its browser/runtime projection.

```text
itemId + itemGeneration
        |
        | ApplicationWorkBindingV1
        v
provider = elatura
laneRef + laneGeneration
```

## Durable fields

`ApplicationWorkBindingV1` stores:

- binding id and generation;
- project;
- item id and current item/responsibility generation;
- provider `elatura`;
- opaque `laneRef`;
- exact `laneGeneration`;
- capabilities the binding expects to use;
- creation/retirement time;
- deterministic fingerprint;
- explicit zero work/application authority flags.

Browser tab ids, process ids, profile ids/paths, selectors, DOM handles, extension ports, provider UI controls, and visual runtime state have no fields in this contract.

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
itemId + itemGeneration
confidence + freshness
sourceRefs
binding id + generation
grantsWorkAuthority = false
authorizesDispatch = false
fingerprint + idempotencyKey
```

The adapter performs zero materiality classification, priority assignment, continuation creation, dispatch, application action, or authority grant.

Exact replay produces the same observation and idempotency identity.

## Existing Stensibly owners

### Same-item wake

#46 owns durable current-generation wake conditions. A bound `provider_observation` can satisfy an exact application-event condition such as `lane.changed`, `lane.possible_completion`, or `lane.recovery_needed` after the owning intake path classifies its relevance to current work.

### Cross-item wake

#327 owns deterministic cross-item wake intents. Use it when an explicit relation connects one application event to a different target item. The source object should remain the opaque Elatura lane reference instead of inventing a fake source work item.

### Worker brief

#1616 may surface the binding as one current tool/source reference in a worker brief. The brief gains zero authority from the binding.

### Application operations

An authorised run may ask the Elatura adapter for `status`, `observe`, `activate`, or `screenshot`. Existing Stensibly capability/command/receipt owners remain responsible for whether the current run may make the request and what later effect is allowed.

## Identity rule

The work generation and lane generation fence different facts:

- item generation changes when Stensibly responsibility/work continuity changes;
- lane generation changes when Elatura semantically retargets the managed application locus;
- browser projection replacement stays inside Elatura and leaves both durable identities intact.

A Stensibly consumer revalidates the current item/responsibility generation before continuation or dispatch. Elatura revalidates the current lane generation before serving an operation.

## Dogfood path

```text
Elatura lane.changed
    -> bound provider observation
    -> Stensibly #46 wake eligibility
    -> current generation re-read
    -> bounded observe
    -> screenshot when useful
    -> activate genuine application when interaction/verification is needed
```

The application observation can justify a later action. Permission for that action comes from the current Stensibly authority owner.

— Vesper 🔥
