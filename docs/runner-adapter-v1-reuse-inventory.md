# Runner-adapter v1 reuse inventory

**Issue:** #619  
**Parent:** #50  
**Audit:** #600  
**Portfolio:** #614 lane 6  
**Repository snapshot:** `deddada9219b027833e72c63a0e3f1c5fef4fdd5`  
**Status:** accepted design input for the first framework-neutral adapter slice

## Decision

Stensibly already has the durable execution spine required by a runner adapter.
The v1 adapter must compose these contracts instead of introducing a second run
state machine:

- `WorkRun`, generations, leases, heartbeats, checkpoints, usage, retry, and
  terminal commands remain owned by `src/runs-core.ts` and `RunnerLedger`;
- runner admission, context delivery, and authority fencing remain owned by the
  dispatcher and runner-facing server contracts;
- effective capability observations reuse the existing tool-surface snapshot and
  conformance contracts;
- exact capability grants and approvals reuse the existing capability-grant
  contract;
- external effects continue through provider-specific command and receipt
  services until #572 establishes a generic execution-certainty contract;
- continuation identity and durable next work reuse the continuation ledger;
- causal ordering follows #149 rather than being improvised inside an adapter;
- authoritative cancellation and shutdown settlement follow #574.

The missing product seam is a small, versioned library interface that converts
runtime-specific commands and observations into these existing Stensibly
contracts. Agent SDK sessions, prompts, checkpoints, traces, and provider objects
stay behind adapter-owned references.

## Existing execution spine

| Concern | Existing owner and contract | Reuse in adapter v1 | Remaining gap |
| --- | --- | --- | --- |
| Work admission | `src/dispatcher-core.ts`: `DispatchNextWorkInput`, `DispatchResult`, idempotent `dispatchNextWork()` | Supervisor creates the durable run before invoking an adapter. Adapter start receives an already accepted run and authority fence. | The library adapter port needs one normalized start input referencing the accepted run, context packet, and execution envelope. |
| Runner claim and context | `src/runner-contracts.ts`: `RunnerLedger`; `src/runner-mcp.ts`: `claim_runner_work`; `src/context-packets.ts`: `RunnerContextPacket` | Reuse the bounded, redacted context packet and existing runner claim path. | A local library adapter should receive the same semantic packet without requiring an MCP round trip. |
| Run state | `src/runs-core.ts`: `WorkRun`, `WorkRunStatus`, `WorkRunCommand` | Canonical lifecycle stays `queued → starting → running/waiting/blocked → succeeded/failed/cancelled/abandoned`. | Adapter events need observations that request or support a transition; events must never declare durable state by themselves. |
| Authority | `src/authority-fence.ts`: `RunAuthorityFence`, `runnerAuthorityCommands` | Every adapter command binds run ID, current run generation, lease generation, holder, and expiry. | Define a compact adapter authority input and reject stale observations before applying them. |
| Heartbeat | `src/runs-core.ts`: `HeartbeatWorkRunInput`; `src/runner-mcp.ts`: `heartbeat_runner_run` | Adapter heartbeat maps directly to the durable heartbeat operation. | Add a canonical adapter observation carrying cumulative usage and an optional checkpoint reference. |
| Checkpoint | `WorkRun.checkpoint`, heartbeat and transition inputs; `RunnerContextPacket.sourceReferences` | Preserve checkpoint as a bounded external reference or opaque adapter token. | Current checkpoint fields are free text. V1 needs a typed reference envelope with kind, adapter, external ID or digest, generation, and privacy flags. |
| Usage | `RunUsage`: input/output tokens, tool calls, child agents; `ExecutionActual` adds duration, files, messages, review | Reuse cumulative usage on heartbeat and terminal transitions. | Add adapter-defined usage references for detailed provider accounting while keeping the ledger projection compact. |
| Execution plan and bounds | `src/execution-envelope.ts`: `ExecutionEnvelope`, `ExecutionActual`; `src/run-execution-store.ts` | Start input includes the immutable execution envelope. Terminal observations may carry bounded actuals. | No new adapter budget model is needed. Adapter-specific quotas remain runtime-owned references. |
| Runner profile | `runnerType` and `runnerProfile` on runs; `RunnerConcurrencyPolicy`; provider-specific profile IDs in SmolRunner receipts | Reuse durable string identity and bind it into an adapter descriptor. | Define a versioned descriptor for adapter ID/version, profile ID/version, transports, supported operations, checkpoint support, and cancellation semantics. |
| Effective capabilities | `src/effective-tool-surface.ts`: `EffectiveToolSurfaceSnapshot`; `src/effective-tool-surface-events.ts`; `src/effective-tool-surface-conformance.ts` | `inspectCapabilities()` returns the existing snapshot. Start, resume, reconnect, compact, refresh, and restart observations use the existing transition vocabulary. | Add this requirement to the shared runner conformance harness; avoid another capability model. |
| Tool authority and approval | `src/tool-capability-grant.ts`: exact request/grant/permission/approval/usage contracts | Tool proposals bind to the existing exact capability request and authorization result. | Adapter v1 needs a proposal reference and response event. Approval state remains server-owned. |
| Dispatcher command identity | `dispatch_commands`, `run_commands`, idempotency request/result records | Reuse current idempotent command application for admission, heartbeat, and transitions. | #149 should add globally attributable command/causation/correlation identities. V1 may require command IDs as references without inventing durable sequencing. |
| Generic operation receipt | `src/operation-receipt-contracts.ts` | Reuse for existing ledger mutation reconciliation. | The contract currently covers item/event/artifact results. Runner/provider effects need the generic certainty model from #572. |
| Provider effect receipt | `src/github-provider-contracts.ts`: reservation, request fingerprint, authority evidence, provider request ID, verification, recovery, reconciliation | Use as a concrete reference implementation for adapter tool effects. | Promote provider-neutral dispatch and settlement facts under #572; keep provider result bodies outside runner events. |
| External runner receipt | `src/smolrunner-receipt-intake.ts`: attempt binding, checkpoint generation, state, heartbeat, evidence references, bounded outcome and authority | Use as a code-backed example of a content-minimised adapter receipt. | SmolRunner-specific state is evidence, not the universal runner lifecycle. V1 should map it into canonical observations. |
| Continuation | `src/continuation-contracts.ts`: proposal, generation, actions, approval/delivery modes, durable result references | `resume()` consumes a durable continuation reference; pause and completion may propose continuations. | Adapter-owned resume tokens and Stensibly continuation IDs need distinct fields so one cannot impersonate the other. |
| Context retention | `src/context-packets.ts`; #49 | Start and resume receive a regenerated bounded packet. | Persist packet identity/source fingerprint when #49 adds accepted packet generations. Full prompts remain outside Stensibly. |
| Event history | item events plus specialized tool-surface events | Adapter observations can be projected into bounded item/run events. | #149 owns aggregate sequence, command ID, causation, correlation, authority fence, and runner identity. V1 should reserve those fields and avoid timestamp-derived ordering. |
| Cancellation | server-owned `cancel` run command; runner protocol intentionally excludes runner self-cancellation | Supervisor requests adapter cancellation, then separately applies durable run state after evidence. | #572 must distinguish pre-dispatch cancellation, cancellation delivery, unknown remote outcome, and terminal receipt. |
| Shutdown and settlement | #574; provider receipts already separate reconciliation from display status | Adapter shutdown returns a joinable settlement operation rather than a boolean. | Generic joinable close, child settlement records, mixed results, and prior-generation publication fencing remain to be implemented under #574. |
| Recovery | run retry budget, abandoned lease reconciliation, tool-surface recovery actions, provider receipt recovery | Conformance exercises crash, resume, stale generation, missing capability, and ambiguous effect recovery. | A generic recovery-reference type is needed, while actual retry decisions remain server policy. |

## What adapter v1 should expose

The interface should express commands sent to a runtime and observations returned
from it. Durable transitions stay in `RunnerLedger`.

```ts
interface RunnerAdapterV1 {
  describe(): RunnerAdapterDescriptorV1;
  inspectCapabilities(
    input: RunnerCapabilityProbeV1,
  ): Promise<EffectiveToolSurfaceSnapshot>;
  start(input: RunnerStartCommandV1): AsyncIterable<RunnerObservationV1>;
  resume(input: RunnerResumeCommandV1): AsyncIterable<RunnerObservationV1>;
  requestCancellation(
    input: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1>;
  requestCheckpoint(
    input: RunnerCheckpointCommandV1,
  ): Promise<RunnerExternalReferenceV1>;
}
```

The exact TypeScript API can use ports or callbacks after implementation review.
These semantics should remain stable:

1. `start` receives a durable run that is already admitted and authority-fenced.
2. `resume` receives the same canonical run identity plus a Stensibly continuation
   reference and an adapter-owned resume reference when available.
3. observations carry the run and generation they observed;
4. a consumer validates each observation against current durable state before
   applying a heartbeat, transition, approval, provider command, artifact, or
   event;
5. adapter exceptions are local observations, not proof that remote execution
   stopped;
6. cancellation request and terminal settlement remain separate facts;
7. runtime-specific content is retained externally and represented by bounded
   references.

## Descriptor requirements

`RunnerAdapterDescriptorV1` should contain only stable capability metadata:

```text
schema version
adapter ID and adapter version
supported profile IDs and versions
supported transports
supports start
supports resume
supports capability inspection
checkpoint mode: none | external_reference | opaque_token
cancellation mode: unsupported | best_effort | acknowledged | settled
supports streaming observations
supports durable replay
supports usage references
supports trace references
```

It should avoid claims such as “exactly once,” “fully durable,” or “safe” without a
conformance result bound to the exact adapter and profile version.

## Start and resume inputs

The v1 start input should reference existing canonical records:

```text
run ID
run generation
lease generation
run authority fence
item ID and project
runner profile identity
execution envelope
bounded runner context packet
required effective capabilities
capability-grant references
command ID / correlation references when available
```

The resume input adds:

```text
Stensibly continuation ID and generation
adapter-owned resume reference, if any
latest accepted checkpoint reference, if any
resume reason
current effective-capability requirements
```

Raw credentials, provider tokens, unrestricted prompts, and private trace bodies
stay outside these values.

## Observation vocabulary

V1 should use a small observation union. Each observation carries schema version,
observation ID, adapter/profile identity, run ID, run generation, lease generation,
observed time, and bounded external references.

| Observation | Meaning | Durable consumer action |
| --- | --- | --- |
| `start_accepted` | Runtime accepted the start command. | May apply `start` when the authority fence still matches. |
| `execution_started` | Runtime began useful execution. | May apply `run` after accepted start. |
| `heartbeat` | Runtime reports liveness, cumulative usage, and optional checkpoint. | Apply the existing heartbeat mutation. |
| `tool_surface_observed` | Current effective capabilities were inspected. | Persist through the existing tool-surface event and reconciliation contract. |
| `work_step` | Bounded progress or current phase. | Record a content-minimised event; no lifecycle transition follows automatically. |
| `tool_call_proposed` | Runtime proposes one exact governed effect. | Build and authorize the existing capability request before dispatch. |
| `approval_requested` | The exact proposal requires a durable decision. | Create or reference server-owned approval state. |
| `provider_dispatch_observed` | Adapter observed a provider dispatch attempt or result boundary. | Consume #572 certainty fields and provider receipt identity. |
| `checkpoint_published` | Runtime produced a reusable checkpoint or resume token. | Store only a typed bounded external reference. |
| `artifact_published` | Runtime produced a durable output reference. | Attach through existing artifact contracts after policy checks. |
| `paused` | Runtime stopped active execution pending a named wake, continuation, or decision. | Apply `wait` or `block` according to server policy and authority. |
| `completion_proposed` | Runtime believes its objective is complete and provides bounded outcome evidence. | Verify requirements, then apply `succeed`; the observation alone never completes the run. |
| `failure_observed` | Runtime reports a bounded failure class. | Classify certainty and retry eligibility before applying `fail`. |
| `interrupted` | Runtime lost its local execution context or stream. | Preserve the run, checkpoint, and reconciliation state; choose resume, handoff, or recovery. |
| `cancellation_observed` | Adapter reports cancellation request/delivery/acknowledgement facts. | Keep run state open until server policy has settlement evidence or applies an explicit fenced cancellation. |
| `settlement_observed` | Runtime reports its terminal child/resource settlement summary. | Consume #574 settlement state before exposing final closure. |

A provider error, thrown SDK exception, closed stream, or client timeout should map
to evidence in `failure_observed` or `interrupted`. It should never be translated
directly into `failed`, `cancelled`, or `succeeded` durable state.

## External reference envelope

The project already uses artifact URIs, continuation references, external run IDs,
trace IDs, provider request IDs, workspace receipt references, log references, and
checkpoint strings. V1 should normalize their public metadata without copying
private content:

```ts
interface RunnerExternalReferenceV1 {
  version: 1;
  kind:
    | "session"
    | "continuation"
    | "checkpoint"
    | "trace"
    | "usage"
    | "log"
    | "artifact"
    | "provider_receipt";
  adapterId: string;
  externalId: string | null;
  digest: string | null;
  uri: string | null;
  generation: number | null;
  createdAt: string;
  accessClass: "private" | "project" | "workspace";
  containsPrivateContent: false;
  containsCredentials: false;
}
```

Validation should require at least one of external ID, digest, or URI. URI policy
can reuse artifact and project policy rather than accepting arbitrary model-provided
URLs.

## Ownership boundaries

### Stensibly owns

- admission and runner selection;
- run identity, status, generation, lease, and responsibility;
- authority grants and approvals;
- context packet generation;
- accepted checkpoints and artifact references;
- commands, receipts, reconciliation, and recovery decisions;
- continuation and human-decision state;
- which observation causes a durable transition.

### Adapter owns

- runtime session creation;
- model/provider client configuration;
- prompts and private context internals;
- runtime-local memory;
- SDK tool-loop implementation;
- framework checkpoint payloads;
- trace and usage payloads;
- transport streaming details;
- best-effort cancellation mechanics;
- conversion from framework callbacks into bounded observations.

### Neither side may infer

- current authority from authentication alone;
- current tool availability from historical calls;
- remote non-execution from a local error;
- terminal settlement from a closed stream;
- approval from a model decision;
- safe retry from an idempotency hint;
- durable completion from an adapter callback.

## Existing conformance assets

The first shared adapter harness can compose current tests and pure evaluators:

- run lifecycle and retry tests in `test/runs.test.ts`;
- run concurrency and exact dispatch tests;
- authority-fence HTTP tests;
- execution-envelope and legacy replay tests;
- context-packet tests;
- continuation and continuation-supervisor tests;
- effective-tool-surface conformance scenarios;
- SmolRunner receipt intake fixtures;
- GitHub provider boundary and reconciliation tests.

The harness should provide a fake ledger port and fake effect provider while using
real Stensibly validators and state transitions.

## Required conformance scenarios

### Group A — common v1 foundation

1. Start command accepted, execution started, heartbeat, checkpoint, completion
   proposal, verified success, and settled close.
2. Duplicate observations replay idempotently and do not append duplicate durable
   events.
3. Stale run or lease generation observation is rejected.
4. Adapter crash after checkpoint resumes through the same canonical run and a
   durable continuation reference.
5. Effective tool surface changes between start and resume; required capability
   loss blocks consequential dispatch.
6. Private prompts, credentials, and unrestricted traces never enter durable
   observations.

### Group B — depends on #572

1. Schema or policy rejection before dispatch records known non-dispatch.
2. Remote application error remains distinct from local transport failure.
3. Local timeout after possible dispatch requires reconciliation.
4. Ambiguous write reconciles through the original operation identity without blind
   replay.

### Group C — depends on #574

1. Two cancellation or shutdown callers join one authoritative completion.
2. Cancelling one waiter leaves cleanup active.
3. Partial child settlement preserves successful outputs and bounded failures.
4. A replacement generation waits for prior settlement or an exact late-publication
   fence.

## Gap register

| Gap | Owner | Adapter v1 treatment |
| --- | --- | --- |
| Causal event envelope and aggregate sequence | #149 | Carry optional command, causation, and correlation references; avoid inventing final event persistence. |
| Generic execution certainty | #572 | Keep certainty payload extensible and provider receipt references explicit; defer universal retry semantics. |
| Joinable settlement and cancellation | #574 | Define observation and descriptor semantics; defer authoritative close implementation. |
| Durable human decision inbox | #48 | Approval observations reference existing grant approval IDs; adapter cannot decide approval. |
| Accepted context packet generation identity and retention | #49 | Reuse current packet and source references; add packet identity after #49 lands it. |
| External surface attachment and session identity | #273 | Use private external references; avoid making runtime sessions canonical. |
| Full causal tool/provider event persistence | #149 and #572 | Conformance can run in memory until the event envelope and certainty contracts land. |
| Portable checkpoints across unrelated frameworks | future, outside v1 | Preserve framework-owned references; no conversion promise. |

## First implementation slice

Create an isolated, behavior-neutral library area:

```text
src/runner-adapter-v1.ts
src/runner-adapter-conformance.ts
test/runner-adapter-conformance.test.ts
```

The slice should contain:

1. strict descriptor, external-reference, start/resume command, and observation
   validators;
2. a narrow adapter interface;
3. a pure conformance runner;
4. two fake adapters:
   - sequential loop adapter;
   - resumable graph adapter;
5. scenarios from Group A only;
6. imports of `EffectiveToolSurfaceSnapshot`, `ExecutionEnvelope`,
   `RunnerContextPacket`, `RunAuthorityFence`, and existing run/continuation identity
   types rather than copies.

It should avoid persistence changes, public REST/MCP exposure, real model SDKs,
provider dispatch, or claims that #572/#574 are complete.

## Second implementation sequence

After the pure contract is green:

1. add a ledger-side observation consumer that validates current run and authority;
2. map observations to existing heartbeat, transition, event, artifact, capability,
   and continuation operations;
3. add #572 execution-certainty facts;
4. add #574 joinable shutdown settlement;
5. integrate one lightweight loop SDK and one durable workflow host;
6. compare both through the same conformance report.

## Real adapter selection rubric

Evaluate code from candidate GitHub repositories against the same criteria:

| Criterion | Evidence required |
| --- | --- |
| Start and resume | Public API and tests that distinguish new run from resume. |
| Cancellation | Delivery, acknowledgement, terminal, and waiter-cancellation semantics. |
| Checkpoints | Durable reference model, replay contract, and compatibility boundaries. |
| Tools | Tool proposal, approval interception, result delivery, and dynamic surface inspection. |
| Streaming | Ordered event model, duplicate/reconnect behavior, and terminal semantics. |
| Tracing and usage | External references and content-minimisation controls. |
| Failure behavior | Distinction between local exception, transport loss, provider error, and remote settlement. |
| Embedding cost | Dependency footprint, runtime assumptions, and ability to keep framework types behind the adapter. |
| Durability | Which facts survive process loss and which require an external workflow host. |
| Testability | Ability to run deterministic fake/model-free conformance. |

The first pair should represent different execution styles. One should be a compact
agent loop; the other should provide durable pause/resume and workflow replay. A
framework earns a first adapter through fit with this contract, not through becoming
the Stensibly core.

## Acceptance of this inventory

- every proposed v1 concept maps to a current source contract or a named gap;
- run status and authority remain server-owned;
- capability observation reuses #544 contracts;
- capability grants and approvals reuse current exact-request contracts;
- continuation and context use current durable identities;
- ambiguous execution and settlement remain assigned to #572 and #574;
- the first code slice is isolated, testable, and free of real SDK dependencies;
- a worker can implement the pure contract without reopening the product boundary.

— Aster · runner interoperability lane  
  Intention: reuse the durable spine and add only the seam that agent frameworks need.
