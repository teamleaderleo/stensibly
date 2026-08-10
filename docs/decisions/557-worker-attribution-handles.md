# Decision: Bind worker attribution once and publish through a worker reference

- **Status:** accepted
- **Date:** 2026-08-10
- **Owning issue:** #557
- **Implementation:** #1449; current explicit-signoff guard landed in #1444
- **Supersedes:** none
- **Superseded by:** none

## In simple words / purpose

A worker should establish stable attribution once during durable enrolment. Routine
publication should not ask the language model to reconstruct its callsign, callsign
lease generation, worker session, and run metadata every time.

Remote MCP clients should carry one opaque server-minted worker reference. Embedded
runner adapters may inject the same accepted worker record through runtime-local
context. Both routes resolve one canonical Stensibly record before rendering
attribution.

The explicit `signoff` object added to `github_add_issue_comment` in #1444 remains the
migration and recovery path until durable worker-reference resolution exists.

## Context and evidence

PR #1444 closed a real publication defect: substantive comments through the shared
GitHub App could arrive as `stensibly-dogfood[bot]` with no worker callsign. The repair
requires typed signoff and renders the canonical footer server-side before provider
dispatch. That is a good fail-closed boundary, while its repeated `callsign` and `runId`
inputs are not the desired steady-state authoring experience.

The repository already separates the relevant concepts:

- `src/worker-enrolment.ts` carries `workerSessionId` and optional callsign in a replayable
  enrolment request;
- `src/worker-signoff.ts` renders descriptive provenance without granting authority;
- #450 binds callsign leases to exact worker-session and run identities;
- #557 owns the hosted callsign/enrolment/dispatch join;
- #270 treats chats as disposable and worker/run state as durable product state.

Repository search on 2026-08-10 found no hosted worker-enrolment or callsign-lease
persistence behind those pure contracts yet. That absence is an implementation fence:
do not shorten the public tool by inventing process-local state that would become a
second source of truth.

### Research and protocol references

These sources inform the division of labour; none specifies Stensibly's exact design.

- **OpenAI Agents SDK — context management**  
  https://openai.github.io/openai-agents-python/context/  
  Local `RunContextWrapper` data is available to tools and hooks without being sent to
  the LLM. Embedded runtimes can therefore carry stable worker metadata outside
  repeated model-authored arguments.

- **MCP SEP-2567 — Sessionless MCP via Explicit State Handles**  
  https://modelcontextprotocol.io/seps/2567-sessionless-mcp  
  This Final standards-track SEP removes protocol sessions and `Mcp-Session-Id` after
  deployed hosts gave sessions incompatible lifetimes. Stateful applications are
  directed toward explicit server-minted handles. Authenticated servers should validate
  `(handle, auth_context)` on every call and keep handles opaque.

- **MCP 2026-07-28 specification release**  
  https://blog.modelcontextprotocol.io/posts/2026-07-28/  
  The released protocol is sessionless and recommends a tool-returned handle carried as
  an ordinary argument across later calls.

- **Lost in the Middle** — https://arxiv.org/abs/2307.03172  
  Long-context use is position-sensitive, so a startup instruction is a weak place to
  keep recurring clerical state.

- **ComplexFuncBench** — https://arxiv.org/abs/2501.10132  
  Multi-step constrained function calling with long parameter filling remains difficult;
  repeated non-semantic parameters should justify their cost.

- **Toolformer** — https://arxiv.org/abs/2302.04761 and **ReAct** —
  https://arxiv.org/abs/2210.03629  
  Both support a useful general split: the model chooses semantically meaningful actions
  while external tools/environments perform deterministic work they can own exactly.

The resulting inference is simple: choosing a callsign can be a language-model task;
persisting it, binding its lease generation and run, checking authority, and formatting
a footer are software tasks.

## Decision

### Canonical worker attribution record

Durable worker enrolment owns one canonical attribution record that can resolve:

```text
worker enrolment ID
worker session ID
current run ID when applicable
callsign
accepted callsign lease generation when applicable
callsign lease lifecycle evidence
project / approved portfolio scope
worker lifecycle status and expiry
```

This record is descriptive provenance. It does not replace actor identity, claims,
capability grants, approval, repository permissions, or provider credentials.

### Remote MCP uses an explicit worker reference

A successful durable `enrol_worker` operation will return one opaque server-minted
worker reference. `workerRef` is the working name; #1449 may choose an equivalent final
name before public release if it is materially clearer.

Later tools that need worker attribution should take that reference instead of repeated
stable callsign/session/run fields. On every use, the server must:

1. resolve the bounded opaque reference from durable state;
2. validate it with the independently authenticated principal and project scope;
3. validate current worker lifecycle and any operation-specific run/lease fence;
4. derive only provenance proved by the accepted record;
5. render attribution through the canonical signoff renderer;
6. dispatch the provider effect only after those checks pass.

Possession of `workerRef` grants no authority. Models and clients must not parse or
manufacture it.

### Embedded runners use runtime-local context

When Stensibly hosts the agent runtime directly, an adapter may inject the same accepted
worker record through runtime-local context. Stable attribution then stays out of
routine model-generated tool arguments entirely. The OpenAI Agents SDK
`RunContextWrapper` is one concrete mechanism; other adapters may use equivalent local
context while preserving the same canonical Stensibly record and checks.

### Keep dynamic publication meaning explicit

Only stable lifecycle facts move behind the reference/context boundary. Publication-
specific facts remain explicit when canonical state cannot prove them, including an
intention, non-default work address, exact reviewed revision, or explicit succession
wording.

### No hidden MCP transport session

Stensibly will not use `Mcp-Session-Id`, connection identity, process affinity, or a
hidden per-connection map as the worker attribution key. MCP 2026-07-28 intentionally
removed that abstraction; remote continuity belongs in durable application state with
an explicit reference.

### Migration

Keep #1444 unchanged until real hosted worker/enrolment lookup exists. Do not create a
temporary process-local worker-reference registry just to shorten the current schema.
During rollout, explicit `signoff` remains the fallback while the worker-reference path
is tested across reconnect, expiry, callsign reuse, and stale/foreign references.
Removing explicit signoff later would require its own compatibility decision.

## Alternatives considered

- **Full signoff forever:** safe and already deployed, but repeatedly restates stable
  application state and can drift from canonical lifecycle facts.
- **Hidden MCP session:** compact, but rejected because current MCP deliberately removed
  protocol sessions after inconsistent host lifetimes.
- **Infer from OAuth/GitHub App/shared account:** rejected because one transport identity
  can represent several concurrent or successive workers; #490/#1444 demonstrated this
  distinction directly.
- **Temporary standalone attribution registry:** rejected for now because it duplicates
  worker lifecycle, expiry, and authorization state that #557 is meant to own.

## Consequences

Benefits are fewer clerical model arguments, server-derived callsign generation/run
provenance, reconnect behavior independent of transport lifetime, and one attribution
source usable by GitHub footers, handoffs, activity views, and embedded runners.

The main costs are one reference that remote MCP models still need to carry, a required
durable enrolment lookup before implementation, and a later public-tool migration.
Context compaction can also lose the reference, so the hosted design needs an
authenticated recovery/read path rather than asking the model to guess.

Key safety rules remain: validate reference plus auth/project every call, return typed
stale/expiry errors, derive callsign generation only from the accepted lease, and never
let callsign or worker-reference possession satisfy an authority check.

## Validation

Compare three dogfood paths where the host permits them:

- **A:** current explicit signoff;
- **B:** remote `workerRef` with server-resolved stable attribution;
- **C:** embedded local context with no routine model-authored stable attribution.

Measure tool-input validation failures, attribution omissions/mismatches, repeated
stable-attribution tokens, retries caused by clerical errors, human corrections,
provider-effect success, reconnect/resume behavior, and recovery from stale or lost
references.

Acceptance means a worker enrols once, publishes repeatedly with the correct canonical
footer, survives remote request/reconnect boundaries without transport-session state,
and reuses a historical callsign only with the correct fresh lease generation and run.
A foreign or stale reference must fail before provider dispatch.

Failure means the reference increases recovery burden enough to outweigh removed
metadata, permits stale/foreign state to reach a provider, loses canonical provenance
across reconnect, or starts functioning as an implicit authority credential.

## Recovery and supersession

The explicit #1444 signoff path is the immediate recovery route. If worker-reference
resolution is unreliable, stop advertising that path and retain explicit server-rendered
signoff while fixing #557; no provider-data migration is required to return to it.

A later durable worker-identity primitive may supersede this record if it works cleanly
across remote MCP and embedded runtimes while staying separate from authority.

## History

- 2026-08-10 — accepted: remote MCP uses a durable explicit worker reference; embedded
  runners may use runtime-local context; explicit signoff remains the migration and
  recovery guard. Implementation lane: #1449.

— Kite · dogfood
  Intention: let workers choose identity once and let software carry the bookkeeping
