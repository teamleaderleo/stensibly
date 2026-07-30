# Runner SDK comparison and first-adapter decision

**Issue:** #619  
**Parent:** #50  
**Architecture audit:** #600  
**Portfolio:** #614 lane 6  
**Stensibly baseline:** `2bfbd350177437aa5b198f5b25c0fa07ea4c94b0`  
**Date:** 2026-07-31

## Decision

Build the first real adapters in this order:

1. **OpenAI Agents SDK for JavaScript/TypeScript** as the first compact agent-loop
   adapter.
2. **LangGraphJS** as the first explicit graph, checkpoint, interrupt, and resume
   adapter.
3. **Temporal TypeScript** later as a durable execution host underneath selected
   adapters and Stensibly commands, after #572 execution certainty and #574
   authoritative settlement have landed.

Keep **Pydantic AI** and **Microsoft Agent Framework** in the conformance matrix and
borrow their strongest contracts. Delay first-party adapters until a Python or .NET
sidecar has a demonstrated product need. Treat **AutoGen** as historical evidence;
its own repository now directs new projects to Microsoft Agent Framework.

This decision optimizes for:

- direct TypeScript integration with Stensibly;
- two genuinely different execution styles;
- durable pause and resume without importing a framework-owned authority model;
- observable, interceptable tool proposals;
- deterministic fake/model-free testing;
- content-minimised external references;
- a path to stronger durability without requiring Temporal on every run.

The first adapters must implement the merged `RunnerAdapterV1` seam from PR #635.
They do not replace `RunnerLedger`, capability grants, continuations, provider
receipts, command identity, execution certainty, or settlement policy.

## Source revisions

Every conclusion below is tied to inspected GitHub source at these revisions.
Recheck before implementation because these projects move quickly.

| Project | Revision inspected | Role in comparison |
| --- | --- | --- |
| `openai/openai-agents-js` | `8defd2a33b78c316f0cb644875bfac656186b563` | TypeScript agent loop, approvals, serialized run state, sessions, tracing, sandbox resume |
| `langchain-ai/langgraphjs` | `56728fd3bd2c5a9e3a29f8fe6593204b2133a8f8` | TypeScript state graph, checkpointing, interrupts, explicit resume commands |
| `microsoft/agent-framework` | `3ad861f0b2b572d2cd64d4764c713b27f3afd34d` | Production workflow and middleware contracts in Python/.NET |
| `microsoft/autogen` | `027ecf0a379bcc1d09956d46d12d44a3ad9cee14` | Historical layered multi-agent runtime and migration evidence |
| `pydantic/pydantic-ai` | `589b5d731ca4e13f21d55459f64d4d8409f80ea6` | Typed tools, argument-sensitive approval, capabilities, evals, durable-host integrations |
| `temporalio/sdk-typescript` | `9cf9f363266db2f9fe38df20a8ba516c0e81b076` | Durable replay, signals, updates, cancellation, worker recovery, testing, OpenAI Agents hosting |

## Evaluation contract

The projects are evaluated against the same questions established by
`docs/runner-adapter-v1-reuse-inventory.md` and PR #635.

### Execution entry

- Can Stensibly start a run using one bounded context packet and current authority
  fence?
- Can the runtime resume from a durable external reference without pretending that
  reference is Stensibly authority?
- Can adapter-specific executable clients and credentials be rebound from current
  trusted configuration?

### Tools and approval

- Can a tool call be observed before execution?
- Are arguments parsed and inspectable before approval policy runs?
- Can approval pause execution for an extended period?
- Can Stensibly apply its own exact capability-grant decision without importing a
  second authorization system?

### Durability and interruption

- Which state is serializable?
- Which live objects must be reconstructed?
- Can execution resume after process or worker loss?
- Does a local exception remain distinct from proof of remote settlement?
- Does cancellation expose request, delivery, acknowledgement, and terminal facts?

### Capability visibility

- Can the adapter inspect its current model-visible and executable tool surface?
- Can it detect that a previously available capability disappeared before resume or
  dispatch?
- Can dynamic MCP or connector tools be reconciled without replaying historical
  assumptions?

### Observability and testing

- Are streaming events, traces, usage, checkpoints, and provider receipts available
  as bounded references?
- Can the adapter run deterministic tests without a live model?
- Can replay, interruption, approval, stale generation, and tool-surface drift be
  exercised in CI?

### Embedding cost

- Language and runtime fit with Bun, Node, Cloudflare Worker, and the current
  TypeScript repository;
- dependency and deployment footprint;
- whether framework types can stay behind the adapter;
- whether adopting the SDK would pull its scheduler, persistence, or product UI into
  Stensibly core.

## Comparison summary

| Candidate | Loop fit | Durable graph fit | Resume/checkpoint | Approval interception | Current capability inspection | Cancellation semantics | Runtime fit | First-adapter verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI Agents JS | Excellent | Moderate | Strong serialized `RunState`; sandbox/session support | Strong, argument-aware, nested-run aware | Good tool graph and MCP reconstruction; adapter must publish Stensibly snapshot | Abort and MCP cancellation exist; terminal certainty still adapter work | Excellent: TypeScript, Node, Bun, experimental Workers | **Select first loop adapter** |
| LangGraphJS | Good | Excellent | Checkpointer + thread ID + `interrupt`/`Command` resume | Strong graph-level pause, review, edit, route | Graph state is inspectable; model/tool surface needs an adapter probe | Graph interruption is clear; remote-effect settlement remains outside graph state | Strong Node/TypeScript; `@langchain/core` peer | **Select first graph adapter** |
| Microsoft Agent Framework | Good | Excellent | Workflow checkpointing, restartability, time travel, durable hosting | Strong HITL and middleware concepts | Provider and middleware surface available; requires cross-runtime mapping | Strong workflow host direction; exact details require Python/.NET adapter | Python and .NET, no first-party TypeScript runtime | Defer; borrow contracts |
| Pydantic AI | Excellent | Strong | Durable integrations for Temporal, DBOS, Prefect, Restate | Excellent argument/history/user-sensitive approval | Typed composable capabilities and event streams | Depends partly on selected durable host | Python sidecar required | Defer; borrow typed capability and eval ideas |
| Temporal TypeScript | Weak as agent loop | Excellent as durable host | Native replayable workflows, signals, updates, queries, workers | Application-defined; can host an agent SDK plugin | Host can query/record state; adapter still owns tool-surface probe | Strong host lifecycle, though adapter must keep cancellation and settlement facts separate | Heavy Node-only worker footprint; client broader | Select later host layer |
| AutoGen | Good historical evidence | Good historical evidence | Layered runtime and distributed messaging | AgentChat and extension hooks | Runtime/component metadata | Community maintenance only | Python/.NET; successor exists | Exclude from new implementation |

## 1. OpenAI Agents SDK for JavaScript/TypeScript

### Evidence inspected

- `README.md`
- `packages/agents/package.json`
- `.agents/references/runstate-schema-and-resume.md`
- `docs/src/content/docs/guides/human-in-the-loop.mdx`
- `packages/agents-core/src/result.ts`
- `packages/agents-core/src/runState.ts`
- `packages/agents-core/src/runner/runLoop.ts`
- `packages/agents-core/src/runner/mcpApprovals.ts`
- `packages/agents-core/src/utils/abortSignals.ts`
- cancellation, RunState, sandbox, session, and agent-scenario tests

### Strengths

#### Direct runtime fit

The package is TypeScript-first and advertises Node, Deno, and Bun support, with
experimental Cloudflare Worker support. Stensibly can implement an adapter in the
same language and test environment without a sidecar protocol.

The primary `@openai/agents` package keeps the public entry compact while composing
separate core, OpenAI-provider, realtime, and sandbox packages. Framework-owned
classes can remain behind `RunnerAdapterV1`.

#### Durable interrupted-run state

`RunState` is explicitly versioned and serializable. Its repository contract says a
resumed state preserves:

- the current turn and next step;
- generated items and last model response;
- pending nested agent runs;
- approvals and rejection messages;
- conversation and trace identity;
- sandbox session state;
- enough partial streaming state to avoid duplicated side effects.

The same contract requires executable callbacks, model clients, retry policies,
credentials, and live tools to be rebound from current trusted configuration. That
aligns with Stensibly's external-reference rule: store a checkpoint reference and
adapter version, then rebuild live clients under the current grant.

The SDK rejects unsupported serialized schema versions and treats tool/agent
rehydration as an identity problem. This is useful precedent for adapter checkpoint
compatibility and exact profile-version binding.

#### Approval before effect

The SDK evaluates tool approval before execution. It can derive `needsApproval` from
parsed arguments, pause the full nested run, return interruption items, preserve
approval decisions in serialized state, and resume later with the same root run.
Malformed arguments fail closed and cannot bypass the approval stage.

This maps cleanly onto Stensibly:

```text
SDK tool proposal
  -> RunnerObservationV1 tool proposal extension
  -> Stensibly capability request and current grant
  -> SDK approve/reject API
  -> SDK resumes under the same RunState reference
```

The SDK's sticky “always approve/reject for this run” choice must remain subordinate
to Stensibly authority generation, repository binding, expiry, and input drift. The
adapter may use sticky decisions only while the exact Stensibly grant remains valid.

#### Streaming and observability

Run results expose generated items, raw responses, interruptions, context, active
agent, and serialized state. Streaming results expose an event stream and completion
promise. Built-in tracing gives the adapter stable trace references while Stensibly
stores content-minimised metadata.

#### Deterministic testability

The repository has extensive fake/model tests for run state, agent scenarios,
approvals, sandbox resume, MCP cancellation, retries, tool execution, and tracing.
The Temporal repository independently exercises OpenAI Agents with a fake model
provider through full worker replay, crash, handoff, stateful MCP, trace, retry, and
failure scenarios.

### Weaknesses and adapter obligations

- Serialized SDK state may include application context. The adapter must keep secrets
  and unrestricted private context outside durable Stensibly references.
- SDK approval is execution-local. Stensibly remains the owner of durable approval,
  authority generation, scope, and expiry.
- Abort or thrown SDK errors cannot prove that a provider effect did not occur.
  #572 certainty remains required around every external effect.
- SDK sessions and `RunState` are execution references, not canonical Stensibly runs
  or continuations.
- Sandbox support broadens the dependency and security surface. The first adapter
  should begin with regular text agents and governed tools; sandbox support becomes a
  separate profile.
- Provider-specific tracing and model types stay behind the adapter.

### First adapter slice

Create a package or isolated module such as:

```text
src/runner-adapters/openai-agents-js.ts
src/runner-adapters/openai-agents-js-events.ts
test/runner-adapters/openai-agents-js.test.ts
```

The first slice should:

1. accept `RunnerStartCommandV1` and build one SDK `RunContext` from the bounded
   packet and external credentials supplied by the host;
2. use an injected model interface or fake model so repository CI needs no network;
3. map SDK stream events to existing start, heartbeat, work-step, interruption,
   checkpoint, artifact, failure, and completion-proposal observations;
4. serialize `RunState` into an external checkpoint store and return only a bounded
   `RunnerExternalReferenceV1`;
5. intercept every tool call through Stensibly capability policy before SDK
   approval/execution;
6. re-inspect effective tools at start and resume;
7. resume from a version-bound SDK state reference;
8. pass the merged Group A conformance suite;
9. add approval and tool-proposal scenarios after a shared observation extension is
   reviewed;
10. avoid sandbox, realtime, provider writes, or live model calls in the first PR.

## 2. LangGraphJS

### Evidence inspected

- `README.md`
- `libs/langgraph/package.json`
- `docs/docs/concepts/human_in_the_loop.md`
- `libs/langgraph-core/src/interrupt.ts`
- `libs/langgraph-core/src/func/index.ts`
- checkpoint packages and human-review examples
- SDK streaming-interrupt documentation

### Strengths

#### Explicit graph and persistence model

LangGraph describes itself as a low-level orchestration library for long-running,
stateful workflows. Its public concepts line up directly with the second fake adapter
already used in Stensibly conformance:

- graph nodes and transitions;
- checkpoints after steps;
- thread identity;
- `interrupt()` values surfaced to a caller;
- `Command({ resume })` to continue later;
- streamed interrupt and state events;
- human approval, state editing, and routing.

A checkpointer is required for durable interrupts, and the same thread ID can resume
in a later process. This provides a clear mapping to Stensibly continuation IDs and
adapter-owned checkpoint references.

#### Different execution style

LangGraph is meaningfully different from an agent loop. It makes state transitions
and pauses explicit, which tests whether `RunnerAdapterV1` remains neutral. The
adapter can map one graph thread to one canonical run while Stensibly retains the
right to decide which graph observation advances durable run state.

#### Human decision control

`interrupt()` can pause before an API call, surface JSON-serializable review data,
accept edited state, and route to a new node through `Command`. This is a useful host
for future Stensibly decision inbox and continuation work.

#### TypeScript package fit

The package targets Node 20+, publishes ESM and CommonJS forms, supports Zod 3/4,
and keeps the core graph package separable from higher-level LangChain agents and
LangSmith services.

### Weaknesses and adapter obligations

- Graph checkpoint state is framework-owned application state. Stensibly should keep
  a reference, generation, and accepted fingerprint, not copy arbitrary graph state.
- A graph interrupt is a control-flow exception. The adapter must preserve it and
  distinguish it from application failure.
- Graph completion cannot prove provider-effect settlement.
- LangGraph memory and checkpointer records must remain separate from Stensibly
  responsibility and authority.
- LangSmith observability is optional; Stensibly should consume OpenTelemetry or
  bounded trace references without depending on the hosted product.
- The adapter must probe actual tool executability, since a graph's declared nodes do
  not prove current external capability binding.
- Dependency cost is higher than the first loop adapter due to `@langchain/core` and
  checkpoint backends.

### First adapter slice

After the OpenAI loop adapter:

1. build a small graph with deterministic fake nodes;
2. map a checkpointer record to `RunnerExternalReferenceV1`;
3. map `interrupt()` to `paused` or `interrupted` observation according to intent;
4. resume through `Command({ resume })` using the same canonical run;
5. prove graph restart in a fresh adapter instance;
6. probe effective capabilities before every resumed consequential node;
7. pass Group A through the real graph instead of the fake graph adapter;
8. keep LangGraph state, checkpointer implementation, and thread IDs behind the
   adapter;
9. defer provider effects and settlement to #572/#574;
10. avoid LangChain agent abstractions in the first slice so the graph adapter remains
    a pure execution-style proof.

## 3. Microsoft Agent Framework

### Evidence inspected

- `README.md`
- Python and .NET workflow sample indexes
- middleware, observability, human-in-the-loop, checkpointing, durable hosting, and
  time-travel references from the root documentation
- AutoGen migration direction

### Strengths to borrow

MAF presents a production-oriented division between agents, workflows, middleware,
hosting, observability, skills, and provider integrations. Its documented workflow
surface includes:

- sequential, concurrent, handoff, and group collaboration;
- checkpointing and restartability;
- streaming;
- human decisions;
- time travel;
- OpenTelemetry;
- Durable Task hosting;
- local and cloud deployment.

The middleware design is especially useful. Stensibly adapters need interceptors for
capability inspection, approval, tool proposal, provider receipt, usage, trace, and
failure classification. Those interceptors should target the neutral adapter seam,
not one MAF pipeline.

### Why it is deferred

- The maintained runtime is Python and .NET. Stensibly would need a sidecar, process
  supervisor, or network protocol before validating the agent semantics.
- Its production breadth creates a larger integration surface than the first
  conformance milestone requires.
- Durable hosting overlaps with later Temporal/Durable Task decisions.
- A first adapter should exercise the current TypeScript seam before adding
  cross-language delivery, packaging, and cancellation issues.

Create a MAF adapter when a real .NET or Python workload needs it. Reuse the same
wire-level adapter protocol that a Pydantic AI sidecar would use.

## 4. AutoGen as historical evidence

AutoGen's current repository is in maintenance mode and explicitly sends new users
to Microsoft Agent Framework. It should not receive a new Stensibly adapter.

The reusable historical lessons are:

- separate low-level message/event runtime from higher-level AgentChat patterns;
- keep provider and code-execution integrations in extension packages;
- support local and distributed runtimes behind the same logical agent contracts;
- maintain a benchmark suite separate from production orchestration;
- allow agents to become tools without making each nested agent a new durable
  coordination authority.

Stensibly already follows the strongest part of this approach: agent runtimes are
replaceable executors, while durable responsibility and authority live elsewhere.

## 5. Pydantic AI

### Evidence inspected

- `README.md`
- `docs/deferred-tools.md`
- `pydantic_ai_slim/pydantic_ai/_deferred.py`
- capability and hook contracts
- event-stream adapters
- `docs/durable_execution/overview.md`
- Temporal, DBOS, Prefect, Restate, and continuation tests

### Strengths to borrow

#### Typed boundaries

Pydantic AI treats dependency inputs, structured outputs, tool arguments, and
capabilities as typed contracts. Its approach supports static analysis and strong
runtime validation. This reinforces Stensibly's decision to validate adapter values
before any durable transition.

#### Argument-sensitive approval

Tools can require approval based on parsed arguments, history, or user preferences.
Deferred tool requests and results provide a clean pause/resume boundary. This is
closely aligned with #617's future argument- and grant-sensitive approval predicates.

#### Composable capabilities

Capabilities bundle tools, hooks, instructions, and model settings. Stensibly should
borrow the composition and test model while keeping capability authority in the
server-owned registry and grants.

#### Durable-host neutrality

Pydantic AI officially supports Temporal, DBOS, Prefect, and Restate rather than
forcing one durable runtime. The Restate integration uses public interfaces and is
presented as a reference for additional hosts. This strongly validates Stensibly's
adapter-first position.

#### Evaluation and observability

Its eval and OpenTelemetry emphasis should inform adapter selection. Every real
adapter should publish a version-bound conformance receipt and later task-class
performance evidence without turning benchmark results into authority.

### Why it is deferred

- Python sidecar required.
- Adopting its durable integration layer would overlap with Stensibly's host-neutral
  command, receipt, certainty, and settlement contracts.
- The first TypeScript adapters can borrow its approval and capability ideas at lower
  operational cost.

A later Pydantic AI adapter should use a small JSON/event wire contract generated
from `RunnerAdapterV1`, with framework state held inside the Python process or its
chosen durable host.

## 6. Temporal TypeScript

### Evidence inspected

- `README.md`
- client, worker, workflow, testing, and OpenTelemetry package layout
- `contrib/openai-agents/src/__tests__/test-openai-agents-comprehensive.ts`
- workflow failure, cancellation, signal, query, update, replay, and testing paths

### Strengths

Temporal provides the strongest durable execution host in this comparison:

- replayable workflows;
- worker replacement and recovery;
- signals, queries, and updates;
- activities and child workflows;
- deterministic workflow testing;
- OpenTelemetry interceptors;
- explicit application failures;
- long-lived stateful operations;
- a production service boundary independent from one agent SDK.

The current repository contains a comprehensive OpenAI Agents integration test that:

- uses fake model providers;
- forces every workflow task to replay by disabling workflow cache;
- starts a run on one worker and continues on a fresh worker;
- exercises crash signals, handoffs, retries, tool failures, stateful and stateless
  MCP, child workflows, activities, signals, queries, updates, and traces;
- asserts deterministic trace identity across replay;
- treats stateful MCP session cleanup as a distinct cancellable activity.

This is direct evidence that the selected first loop SDK can later run inside a
strong durable host without making Temporal the agent API.

### Costs and boundary risks

- Temporal workers require authentic Node and several Node-specific native/runtime
  facilities. They are unsuitable for direct Cloudflare Worker execution.
- The package family and service deployment are materially heavier than a direct
  adapter.
- Temporal workflow history must remain host-owned. Stensibly should store command,
  run, workflow, checkpoint, trace, and receipt references.
- Temporal cancellation and workflow completion still need translation into
  Stensibly's separate cancellation-request, delivery, terminal, and settlement
  facts.
- A Temporal workflow should execute a Stensibly-authorized command. It must not
  become an alternate authority or task database.

### Recommended role

Introduce Temporal only after:

1. the direct OpenAI Agents adapter passes real conformance;
2. #572 defines generic dispatch and settlement certainty;
3. #574 defines joinable authoritative shutdown and terminal publication;
4. Stensibly has a command inbox/outbox suitable for a durable worker;
5. one actual workload benefits from multi-hour execution or worker replacement.

The first Temporal slice should wrap the already-tested adapter and replay a fake
model scenario across two workers. It should avoid adding a separate Temporal-shaped
public API.

## Architecture implications for Stensibly

### Keep adapter and host separate

The comparison distinguishes two independent choices:

```text
agent execution style
  OpenAI Agents loop | LangGraph graph | Pydantic AI | MAF

durable host
  direct process | Temporal | DBOS | Prefect | Restate | Durable Task
```

A Stensibly runner profile may combine one choice from each category. The adapter
descriptor should eventually expose host identity separately from agent framework
identity.

### Add observation extensions incrementally

PR #635 intentionally delivered Group A. Real adapters will need reviewed additions
for:

- exact tool-call proposal identity and parsed arguments digest;
- approval requested, resolved, expired, or invalidated;
- provider dispatch attempted, accepted, ambiguous, reconciled, or settled;
- trace and usage reference publication;
- cancellation request, delivery, acknowledgement, and terminal observation;
- settlement summary.

Add each extension only when its durable consumer and authority rule exist. Avoid a
large speculative event union.

### External checkpoint contract

A checkpoint reference should bind:

```text
adapter ID and version
runner profile ID and version
host ID and version, when present
canonical Stensibly run ID and generation
external state schema version
checkpoint generation
content digest or opaque external ID
created time
compatibility or migration policy
access class
```

The checkpoint payload remains outside Stensibly. The adapter must reject unsupported
or ambiguous schema versions and rebind live tools, credentials, clients, and policy
from current trusted configuration.

### Conformance before support claims

Every adapter/profile/host combination should produce a signed or fingerprinted
conformance report bound to exact versions. Stensibly should distinguish:

- implemented;
- passed Group A;
- passed approval/tool proposal;
- passed #572 certainty scenarios;
- passed #574 settlement scenarios;
- live-provider verified;
- production-host verified.

“Supports resume” or “supports cancellation” is too vague for selection policy.

## Delivery sequence

### A. OpenAI Agents JS adapter foundation

Create a focused child of #619 with these first acceptance items:

- injected fake model;
- regular text agent only;
- start and resume;
- serialized `RunState` external store interface;
- stream-to-observation mapping;
- effective-tool-surface probe;
- Group A conformance;
- no live provider call;
- no sandbox, realtime, or Temporal dependency.

### B. Tool proposal and approval bridge

After the first adapter is green:

- extend neutral observations with an exact tool proposal;
- resolve through #617 policy and existing capability-grant contracts;
- feed approval or rejection back into the SDK;
- invalidate sticky decisions when authority generation, inputs, target, or grant
  changes;
- test nested agent tool approvals and malformed arguments.

### C. LangGraphJS adapter

- deterministic graph and fake nodes;
- checkpointer reference;
- interrupt and resume;
- fresh-process adapter reconstruction;
- Group A conformance;
- capability recheck before a resumed effect;
- no model dependency in the first slice.

### D. Certainty and settlement

Advance #572 and #574, then expand both adapters through the shared scenarios. The
adapter must report evidence; the Stensibly consumer decides durable transitions and
safe retries.

### E. Temporal host proof

Wrap the OpenAI adapter in a Temporal test workflow with fake model and provider
activities. Force worker replay, crash between checkpoint and resume, and preserve
one canonical Stensibly run and command identity.

### F. Cross-language adapter protocol

After two TypeScript adapters prove the semantic contract, generate a small JSON
schema and event-stream protocol for Pydantic AI or MAF sidecars. Keep the wire
protocol versioned and content-minimised.

## Rejected first moves

### Import one framework into ledger core

This would couple durable responsibility and authority to a prompt loop, checkpoint
schema, or workflow scheduler. The merged v1 seam exists to prevent that.

### Start with Temporal everywhere

Temporal solves durable hosting, not tool authority, project policy, operator
explanation, or responsibility. Universal Temporal adoption would add operational
weight before the certainty and settlement contracts are ready.

### Start with a Python or .NET sidecar

Cross-language transport, packaging, process health, cancellation, and logs would
obscure whether the neutral adapter semantics work. Prove them in TypeScript first.

### Trust SDK approval as durable permission

SDK approval state is run-local execution state. Stensibly approval binds exact
inputs, target, principal, project, authority generation, expiry, and consequence.

### Persist whole framework state in Stensibly

Framework checkpoints may contain private prompts, application context, tool state,
or provider data. Keep them in an adapter-owned store and persist bounded references.

## Acceptance

- the comparison is pinned to exact GitHub revisions;
- two first adapters represent different execution styles;
- one durable host is selected without becoming the core runtime;
- approval, capability, checkpoint, cancellation, certainty, and settlement ownership
  remain explicit;
- every recommendation maps to the merged `RunnerAdapterV1` seam;
- first implementation slices are model-free and recoverable;
- AutoGen maintenance status and MAF succession are reflected;
- cross-language frameworks remain possible without delaying the TypeScript proof;
- future workers can create focused children without repeating this research.

— Aster · runner interoperability lane  
  Intention: select adapters through code-backed lifecycle fit while keeping Stensibly independent of every framework.
