# Codex root harness

This is the smallest direct Codex app-server adapter proved under #1695. It
accelerates a current Stensibly responsibility with a persisted Codex root and
goal. It does not own work selection, authority, publication, settlement,
portfolio topology, or a transcript archive.

## Boundary

Stensibly retains the durable mission, responsibility generation, exact runner
profile, current compiled brief, authority, and accepted evidence. The binding
retains only bounded runtime identity: independent Codex thread/session IDs,
mission and objective digests, exact profile provenance, predecessor reference,
and goal budget. The current brief is delivered to Codex but is never copied into
the binding or observation.

The adapter uses a subscription-authenticated `codex app-server --stdio`
connection. It starts independent roots with `thread/start`, persists and reads
goals, starts or steers turns, resumes exact threads after controller
reconstruction, and emits neutral `RunnerExternalReferencePortableV1` identities.
It does not shell the Codex CLI recursively to create workers.

Continuation is fail closed:

- exact mission generation/revision/objective and exact concrete profile version
  permit a hot or reconstructed resume;
- a changed mission or profile starts an independent successor root and retains
  only the predecessor's bounded external reference;
- a terminal goal is explicitly reactivated, the harness waits for the actual
  runtime turn, and the current brief is delivered with `turn/steer`;
- an already-active goal rejects a duplicate brief;
- a cumulative goal budget must be raised explicitly after exhaustion;
- unknown or mismatched runner-profile versions never become compatible by
  inference, matching #1702's current exact-version fence.

Native child-slot exhaustion maps to local, retryable backpressure. It creates no
durable work item and changes no portfolio relationship.

## Profiles and placement

The exact profile fingerprint includes model, reasoning effort, sandbox, network
access, approval policy, absolute working directory, and app-server version.
Network access is explicit and independent from the coarse sandbox enum, with a
fail-closed `false` default in callers. The current app-server surface exposes a
boolean network control, not an origin allowlist. Therefore Elatura's loopback
case may use `workspace-write` plus network only when the broader network grant is
admitted; this adapter must not claim that the runtime enforces loopback-only
access. `danger-full-access` cannot truthfully carry `networkAccess: false`.

Execution placement is separate from logical responsibility:

- keep a root local for Mac-local state, credentials, hot dependencies, or
  latency-sensitive repair;
- prefer native Codex Cloud tasks for repository-contained reviews,
  implementation, or tests when the subscription environment supports the
  repository and branch;
- moving between local and cloud is a successor-run/profile decision, never an
  authority expansion.

The first-class routing candidates are deliberately not defaults or roles:

| Workload | Candidate | Effort | Tradeoff |
| --- | --- | --- | --- |
| architecture and integration | `gpt-5.6-sol` | high | reasoned integration |
| bounded hot path | `gpt-5.3-codex-spark` | medium | latency |
| larger settled implementation | `gpt-5.6-luna` | max | high-certainty settlement |

OpenAI describes Spark as a separate latency-oriented Codex model with its own
limits, optimized for near-instant coding work rather than as a universally more
capable default: <https://learn.chatgpt.com/docs/agent-configuration/speed#codex-spark>.

## Local lifecycle dogfood

The subscription-authenticated app-server probe proved:

- two independent roots started concurrently with distinct mission/profile/goal
  bindings and `threadId === sessionId`;
- one root continued hot, then resumed after the controller and app-server were
  reconstructed;
- a changed durable input created a fresh independent successor, never a fork;
- the peer root's exact goal remained unaffected;
- three roots started, one hot continuation, one restart resume, and one
  replacement were observed without storing a transcript or a second queue.

The repaired continuation path matters. An earlier experiment reactivated a
terminal goal and let the app-server auto-start a turn before the current brief
was bound, producing an empty useful turn. The adapter now waits for the actual
`turn/started` identity and steers the brief into that turn before waiting for
goal and turn settlement. Tests reject duplicate delivery when the goal is
already active.

## Spark versus Sol dogfood

This is routing evidence, not a model ranking:

| Candidate/run | Scope and outcome | Elapsed | Handoff | Execution | Repair turns | Usage evidence |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Spark medium | bounded routing implementation; fourth campaign turn changed the exact two files and passed focused tests | 127.983 s | 5.438 s | 122.545 s | 4 | goal 172,142/180,000; 530,805 total tokens, 525,415 input, 395,776 cached, 5,390 output |
| Sol high | tiny exact test-description tail; passed focused tests | 59.625 s | 0.340 s | 59.285 s | 1 | goal 20,534/40,000; 166,429 total tokens, 165,145 input, 143,616 cached, 1,284 output |

Spark's first attempts exposed real harness defects: missing workspace writable
roots, expensive broad onboarding, and the goal/brief steering race. Once the
root was oriented and the task exact, it completed the bounded repair. The
observed routing rule is: use Spark for a narrow hot path with a compact handoff;
use Sol to settle ambiguity or finish a tiny exact tail when reorientation risk
dominates nominal latency; reserve Luna Max for larger already-settled work and
measure it separately before preferring it.

## Memory-aware residency dogfood

`MemoryAwareCodexHostPool` is ephemeral capacity, not a manager database. It
holds live connections and logical-root keys only. The caller retains the durable
binding. `hot`, `parked_resumable`, and `retired` are explicit observations.
Parking unsubscribes the thread; releasing the last root terminates and, if
needed, kills the exact app-server process group. Retirement archives before
release. Admission responds independently to macOS pressure/free-memory,
configured resident RSS, host count, and roots-per-host.

On the operator's 24 GB Mac, the concrete three-root test used one host with at
most two resident roots:

- idle app-server: 95.9 MB RSS;
- first hot pair: 769.7 MB across 10 processes (311.2 MB host, 410.6 MB across
  six Node workers, 47.9 MB across three other children);
- shared-host marginal estimate: 336.9 MB average above idle for the first pair;
- releasing root A changed shared RSS by only -15.3 MB, showing why exact
  per-root attribution would be misleading;
- admitting root C added a 285.4 MB shared-host marginal; the second pair peaked
  at 1.040 GB across 14 processes;
- after the final park and after retirement: 0 tracked process-tree RSS, with
  both exact host PIDs reaped;
- reconstructing the host resumed root A from the exact serialized thread,
  session tree, goal, and external reference: 43.279 s total, 0.353 s handoff,
  42.926 s execution, 110,785 input tokens with 60,672 cached;
- two useful turns completed concurrently in 20.721 s wall time; the other root
  remained unaffected.

Memory pressure stayed `normal`, but swap rose from 6.036 GB at baseline to
7.211 GB at the hot-pair observation, a +1.174 GB interval delta. That delta is
not exclusively attributable to the harness, and it must not be collapsed into
the RSS result or described as an improvement. It supports bounded residency and
cloud offload, not increasing the local root-count constant.

## Publication receipts

The existing Sol/Luna worker receipt owns head lineage and worktree activity and
marks worker success provisional. #1255 retains upstream publication authority.
`adjudicateCodexRootPublicationPreflight` is only a deterministic,
non-authorizing evidence fence. A delivery/rereview-ready claim fails closed
unless:

- a claimed delta has a different before/delivery head;
- every observed changed path is represented;
- the exact repository/ref owner lease is still current;
- remote readback proves the delivery head reachable from the intended ref;
- every required check has an actually executed `passed` result—`unavailable`
  and `not_executed` are not passes.

An incomplete worker may still emit `local_progress` or `local_blocker`, but those
claims are never publication-eligible and the preflight always returns
`authorizesPublication: false`.

## Commands

```sh
bun test test/codex-app-server-client.test.ts test/codex-root-harness.test.ts test/codex-root-routing.test.ts test/codex-root-residency.test.ts test/codex-root-publication-preflight.test.ts
bunx tsc --noEmit
bun run codex-roots:probe
bun run codex-roots:memory-probe
```

The memory probe is intentionally macOS-only. Both live probes create disposable
workspaces, archive their synthetic threads, terminate owned runtime process
trees, and remove their temporary files.
