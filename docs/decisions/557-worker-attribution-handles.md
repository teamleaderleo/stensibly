# Decision: Bind worker attribution once and publish through a worker reference

- **Status:** accepted
- **Date:** 2026-08-10
- **Owning issue:** #557
- **Implementation:** #1449; current explicit-signoff guard landed in #1444
- **Supersedes:** none
- **Superseded by:** none

## In simple words / purpose

A worker should establish stable attribution once, during durable enrolment, instead of
asking the language model to reconstruct its callsign, callsign lease generation,
worker session, and run metadata on every publication.

Remote MCP clients should carry one opaque server-minted worker reference between
calls. Embedded runner adapters may inject the same accepted worker record through
runtime-local context. Both routes resolve one canonical Stensibly record before
rendering publication attribution.

The current explicit `signoff` object on `github_add_issue_comment` remains the safe
migration and recovery path until the durable worker-reference route exists.

## Context and evidence

### Repository observations

PR #1444 closed a demonstrated publication-boundary defect: substantive comments
published through the shared GitHub App could arrive as `stensibly-dogfood[bot]`
without any worker callsign. The repair requires typed worker signoff metadata and
renders the canonical footer server-side before provider dispatch. An otherwise valid
unsigned call now fails before the GitHub write.

That guard is intentionally stricter than the desired steady-state authoring
experience. Its public tool input asks the language model to supply stable facts such
as `callsign` and `runId` again for every issue comment. Those facts already belong to
the worker lifecycle domain.

The repository has the right precursor concepts but not their hosted join yet:

- `src/worker-enrolment.ts` binds an ephemeral `workerSessionId` and optional callsign
  in a replayable enrolment request;
- `src/worker-signoff.ts` renders callsign, accepted lease generation, run, work, and
  other descriptive provenance without granting authority;
- #450 defines callsign leases around exact worker-session and run identities;
- #557 owns the hosted join between callsign leasing, worker enrolment, and supervisor
  dispatch;
- #270 treats chats as disposable and durable worker/run identity as product state.

### External research and protocol evidence

The following sources inform this decision. They are evidence for the division of
labour, not claims that any paper or SDK specifies Stensibly's exact design.

1. **OpenAI Agents SDK — context management**  
   https://openai.github.io/openai-agents-python/context/  
   The SDK distinguishes local run context from LLM-visible context. Application data
   and dependencies can be passed to tools through `RunContextWrapper` without sending
   that local context to the model. This is a direct fit for stable worker metadata in
   an embedded runtime.

2. **MCP SEP-2567 — Sessionless MCP via Explicit State Handles**  
   https://modelcontextprotocol.io/seps/2567-sessionless-mcp  
   The final standards-track SEP removes protocol-level sessions and
   `Mcp-Session-Id`. It records that deployed hosts assigned incompatible session
   lifetimes, including per-tool-call behaviour, and recommends explicit server-minted
   handles for application state that must survive across calls. It also recommends
   opaque handles and validation of `(handle, auth_context)` on every authenticated
   call.

3. **MCP 2026-07-28 specification release**  
   https://blog.modelcontextprotocol.io/posts/2026-07-28/  
   The released protocol is sessionless. Its guidance says stateful applications can
   mint an explicit handle from a tool and have the model pass that ordinary argument
   on later calls; the protocol no longer supplies hidden transport session state for
   this purpose.

4. **Lost in the Middle: How Language Models Use Long Contexts**  
   https://arxiv.org/abs/2307.03172  
   The study finds strong position sensitivity in long-context retrieval, with relevant
   information in the middle often used less reliably than information near the
   beginning or end. A startup instruction to remember clerical attribution forever is
   therefore weaker evidence than typed runtime state.

5. **ComplexFuncBench: Exploring Multi-Step and Constrained Function Calling under
   Long-Context Scenario**  
   https://arxiv.org/abs/2501.10132  
   The benchmark exercises multi-step constrained calls, long parameter filling, and
   parameter reasoning, and reports substantial deficiencies in then-current
   state-of-the-art models. Repeated non-semantic parameter filling should earn its
   place in the model-facing contract.

6. **Toolformer: Language Models Can Teach Themselves to Use Tools**  
   https://arxiv.org/abs/2302.04761  
   Toolformer frames tool use around the model choosing when and how to invoke simple
   external APIs. It supports the broader product principle here: let the model make
   semantic choices while deterministic software performs bookkeeping it can own
   exactly.

7. **ReAct: Synergizing Reasoning and Acting in Language Models**  
   https://arxiv.org/abs/2210.03629  
   ReAct demonstrates useful interleaving of model reasoning with environment actions.
   Stensibly should make those actions concise and semantically meaningful rather than
   repeatedly asking the model to restate stable local identity facts.

### Inference from the evidence

Stable worker attribution is application state. The language model may make the
meaningful naming choice once, but persistence, lease generation, run binding,
authority checks, and Markdown rendering are deterministic software responsibilities.

The same conclusion has two different ergonomic implementations because the execution
surfaces differ:

- an embedded runner can inject local context directly into tool implementations;
- a remote MCP client needs one explicit durable reference because current MCP is
  intentionally sessionless.

## Decision

### One canonical worker attribution record

Durable worker enrolment owns the canonical attribution record. It should retain or
resolve at least:

```text
worker enrolment ID
worker session ID
current run ID when applicable
callsign
accepted callsign lease generation when applicable
callsign lease ID / lifecycle evidence
project or approved portfolio scope
lifecycle status and expiry
```

The exact storage schema remains #557's implementation concern. Callsign and display
metadata remain descriptive. They do not become the actor, claim, capability, approval,
repository permission, or provider credential.

### Remote MCP: explicit worker reference

A successful durable `enrol_worker` operation will return one opaque server-minted
worker reference. `workerRef` is the working contract name; an implementation may
choose an equivalent final name before public release if it is materially clearer.

Later tools that need worker attribution should accept that one reference instead of
requiring the model to repeat stable callsign/session/run fields.

On every use, the server must:

1. admit the worker reference as bounded opaque input;
2. resolve it from durable state;
3. validate it against the independently authenticated principal and project scope;
4. validate current worker/enrolment lifecycle state and any operation-specific run or
   lease fence;
5. derive only provenance facts proved by the accepted record;
6. render attribution with the canonical signoff renderer;
7. dispatch the provider effect only after those checks pass.

Possession of `workerRef` is not authorization. It is a resource identifier that is
meaningful only together with current authenticated and durable state.

The reference should be opaque rather than encoding callsign, project, principal, run,
or lease generation. Models and clients must not be encouraged to parse or manufacture
one.

### Embedded runners: runtime-local attribution context

When Stensibly directly hosts an agent runtime, the adapter may inject the same accepted
worker attribution record through runtime-local context available to tool
implementations. Stable attribution does not need to appear in every model-generated
tool argument merely because the remote MCP path uses a reference.

The OpenAI Agents SDK is one concrete host where local `RunContextWrapper` context can
carry this kind of application data without putting it in LLM-visible context. Other
adapters may use their own equivalent injection mechanism while preserving the same
canonical Stensibly record and validation rules.

### Keep semantic and dynamic publication facts visible

Only stable lifecycle facts move behind the reference/context boundary. Facts that are
specific to one publication remain explicit unless canonical state proves them safely.
Examples include:

- current intention when it adds useful context;
- a work address that differs from the current bound item;
- an exact reviewed revision;
- explicit succession or handoff wording.

This keeps the model responsible for meaning while software owns repetition.

### No hidden MCP transport session

Stensibly will not use `Mcp-Session-Id`, connection identity, Worker process affinity,
or another hidden per-connection map as the worker attribution key. MCP 2026-07-28
removed that protocol abstraction, and the deployed-host evidence in SEP-2567 makes its
lifetime unsuitable for worker identity.

### Migration from explicit signoff

PR #1444 remains unchanged until a real durable worker/enrolment lookup is available.
There will be no temporary process-local worker-reference registry merely to shorten the
current tool schema.

During rollout:

1. explicit `signoff` remains accepted and server-rendered;
2. the worker-reference path is added only when it can resolve durable canonical state;
3. dogfood compares both paths;
4. explicit signoff remains a recovery/debug path until reconnect, expiry, reuse, and
   stale-reference behaviour are proven;
5. later deprecation requires a separate compatibility decision if the public tool
   contract would remove explicit signoff.

## Rationale

The model should spend tool-call attention on the intended target and semantic payload.
Callsign text, lease generation, worker-session ID, and run identity are stable
bookkeeping after enrolment. Asking for them repeatedly creates additional token use,
validation opportunities, and chances for stale or mismatched provenance without adding
new intent.

A single durable reference is the smallest remote-MCP compromise. It still asks the
model to carry one identifier, but that identifier points to server-owned state and
survives connection boundaries. This follows the current MCP application-state pattern
rather than building against host-specific connection behaviour.

Embedded runtimes can do better because the host owns both sides of the tool boundary.
There, local context can remove even the reference from routine model-authored
arguments while keeping the exact same server-side record and checks.

## Alternatives considered

### Require the full signoff object forever

- **Why it was plausible:** typed, inspectable, already deployed, and fails closed when
  attribution is omitted.
- **Why declined as the steady state:** it repeatedly asks the model to restate stable
  application state and can still accept internally inconsistent freehand values unless
  a separate canonical lookup verifies them.
- **Revisit if:** durable worker enrolment is abandoned entirely.

### Bind attribution to an MCP transport session

- **Why it was plausible:** extremely small tool inputs and familiar web-session
  ergonomics.
- **Why declined:** MCP 2026-07-28 intentionally removed protocol sessions after
  inconsistent host lifetimes made them unreliable for application state.
- **Revisit if:** a future protocol introduces a new explicit durable worker identity
  primitive with semantics stronger than the removed transport session.

### Infer the worker from OAuth client, GitHub App, or shared account identity

- **Why it was plausible:** these identities are already authenticated or visible at
  the provider boundary.
- **Why declined:** one transport or account can represent several concurrent or
  successive workers. The original unsigned-bot defect is direct dogfood evidence of
  this distinction.
- **Revisit if:** a deployment proves one authenticated principal is permanently and
  exclusively bound to one worker, which is outside Stensibly's current many-agent
  model.

### Add a temporary standalone attribution registry before hosted enrolment

- **Why it was plausible:** it could shorten the comment tool sooner.
- **Why declined:** it would duplicate worker lifecycle state, create another expiry and
  authorization boundary, and risk becoming a second source of truth. #557 already
  owns the durable join.
- **Revisit if:** the hosted enrolment programme is blocked long enough that a bounded,
  explicitly disposable bridge has measurable product value.

## Consequences

### Benefits

- routine publication carries less repeated model-authored metadata;
- canonical callsign generation and run provenance come from server-owned state;
- reconnect and new-request behaviour no longer depends on transport session lifetime;
- embedded runners can remove stable attribution from model-visible tool arguments
  entirely;
- one worker lifecycle record can feed GitHub footers, activity views, handoffs, and
  later provider surfaces consistently;
- callsign remains pleasant display metadata without becoming a security identity.

### Costs and accepted imperfections

- remote MCP still requires the model to preserve one worker reference across calls;
- durable worker/enrolment persistence and lookup must exist before publication can use
  the reference safely;
- the public ChatGPT tool contract will need another deliberate migration after that
  prerequisite lands;
- client context compaction can lose a worker reference, so recovery/discovery needs a
  clear path rather than assuming perfect model memory;
- dynamic per-publication facts still need explicit inputs when canonical state cannot
  prove them.

### Risks and mitigations

- **Foreign or leaked reference:** validate reference plus authenticated principal and
  project on every call; never treat possession as authority.
- **Expired worker:** return a typed expiry/stale error with an enrolment recovery path.
- **Wrong callsign generation after reuse:** derive generation only from the accepted
  lease attached to the resolved worker record.
- **Reference lost during compaction:** provide a bounded authenticated way to recover
  current enrolment/reference state; do not encourage the model to guess a handle.
- **Duplicate sources of truth during migration:** explicit signoff remains a fallback,
  while the worker-reference path derives stable facts only from durable enrolment.
- **Premature public schema churn:** keep #1444's current schema until the durable lookup
  prerequisite is real and tested.

## Validation

### Evidence already available

- #1444 proves the server can render canonical signoff before GitHub provider dispatch
  and can reject missing attribution before an effect.
- `worker-enrolment.ts`, #450, and #557 already separate worker/session/run/callsign
  lifecycle from authority.
- the current MCP HTTP implementation is already stateless per request, which is
  compatible with explicit durable handles.

### Experiment

Compare three dogfood paths where the host permits them:

- **A — explicit signoff:** current `callsign + runId + optional provenance` input;
- **B — remote worker reference:** one `workerRef`, server-resolved stable attribution;
- **C — embedded local context:** no routine model-authored stable attribution fields.

Measure:

- tool-input validation failures;
- omitted, stale, or mismatched attribution;
- repeated stable-attribution characters/tokens per provider effect;
- retries caused by clerical parameter errors;
- human correction rate;
- successful attribution across reconnect/resume;
- task completion and provider-effect success;
- recovery quality after an expired or lost reference.

### Acceptance signal

A worker can enrol once, publish repeatedly with the correct canonical callsign footer,
reconnect or resume without transport-session dependence, and reuse a historical
callsign only with the correct fresh lease generation and exact run provenance.

### Failure signal

The worker-reference path increases recovery burden enough to outweigh the removed
metadata, allows a foreign/stale reference to reach provider dispatch, loses canonical
attribution across reconnect, or causes the callsign/reference to become an implicit
authority credential.

## Recovery and supersession

The explicit #1444 signoff path is the immediate recovery route. If worker-reference
resolution proves unreliable, stop advertising that path and retain server-rendered
explicit signoff while fixing #557. No provider data migration is required merely to
return to explicit signoff.

A future design may supersede this record if Stensibly gains a stronger durable worker
identity primitive that works consistently across remote MCP and embedded runtimes.
Keep that identity separate from authority and link the superseding decision in both
records.

## History

- 2026-08-10 — accepted: use durable explicit worker references for remote MCP and
  runtime-local context for embedded runners; retain explicit signoff as migration and
  recovery guard. Implementation lane opened as #1449.

— Kite · dogfood
  Intention: let workers choose identity once and let software carry the bookkeeping
