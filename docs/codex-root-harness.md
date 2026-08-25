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
  runtime turn, and the current brief is delivered with `turn/steer`; if the
  auto-started turn becomes terminal before steer acceptance, continuation
  fails closed instead of claiming delivery or starting a successor;
- an already-active goal rejects a duplicate brief;
- a cumulative goal budget must be raised explicitly after exhaustion;
- unknown or mismatched runner-profile versions never become compatible by
  inference. #1702 remains the owner of the separate durable reservation
  adapter/profile/version fence; its current head has an open P1 because the two
  durable reservation backends do not yet compare fresh reservation facts with
  durable run metadata before dispatch authority. This harness neither claims
  that seam settled nor duplicates its backend repair.

Native child-slot exhaustion maps to local, retryable backpressure. It creates no
durable work item and changes no portfolio relationship.

## Profiles and placement

The exact profile fingerprint includes model, reasoning effort, sandbox, network
access, approval policy, absolute working directory, and app-server version.
Admission recomputes it from those concrete fields and rejects a caller-supplied
exact version that does not match; provenance cannot be retained while runtime
truth changes.
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
`turn/started` identity, rejects an already-terminal matching turn, and requires
`turn/steer` to accept that exact ID before waiting for goal and turn settlement.
A completion that wins the remaining protocol interval is a fail-closed
continuation error, not a successful brief delivery. Tests model that adverse
ordering and reject duplicate delivery when the goal is already active.

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
Each lease must be bound once to its exact root reference before release, so a
lease for root A cannot archive or unsubscribe root B on a shared host. Parking
unsubscribes the bound thread; releasing the last root terminates and, if needed,
kills the owned app-server process group and verifies that no live member
remains. Transport failure does not suppress later SIGKILL escalation. On Linux,
the deterministic check distinguishes terminated zombies awaiting OS adoption
from live resident processes instead of treating `kill(pid, 0)` as RSS evidence.
Retirement archives before release. Admission responds independently to macOS
pressure/free-memory, configured resident RSS, host count, and roots-per-host.

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
These exact numbers are externally observed dogfood evidence from the operator
Mac, not outputs reproduced by the committed unit tests; the committed probe is
the reproducible measurement procedure.

## Native cloud placement dogfood

The installed `codex-cli 0.146.0`, authenticated by ChatGPT subscription, exposes
native `codex cloud exec/status/list/diff/apply`. Cloud task identity is provider
runtime evidence, not portfolio topology. The first placement epoch reused two
already-dispatched read-only reviews instead of creating duplicate work:

- Compass: Quarry #1046 rereview of
  `teamleaderleo/quarry@pascal/876-review-replay-repair-r1`, required head
  `e3094f7b69524c3e3813d3eedd22796e4aada3d5`, task
  `task_e_6a8da2702674832694c6781dd6561769`;
- Turnkey: Stensibly #1702 review of
  `teamleaderleo/stensibly@ox/kepler/issue-1691-runner-profile-fence`, required
  head `d764cf9b3d161d4f8758576e50f0fec27e493fbd`, task
  `task_e_6a8da26f1a10832694d7d11aaddf1ecc`.

Both were pending with no diff at the first status read. Their briefs require
exact-ref structured receipts, transfer no local credentials, permit no provider
mutation, and exclude unrelated work. This Mac retained the one local,
Mac-dependent campaign while the reviews ran remotely. At the first placement
read, the prior local observation showed 60% free memory, 1.650 GB swap, and a
single Codex process at 6.186 GB RSS. While both cloud tasks were pending, a later
observation showed 85% free, 1.430 GB swap, and the replacement Codex process at
612 MB plus its local helper children. The Codex app restarted between samples,
so this is operational relief evidence—not causal per-task memory attribution.
No cloud review created another local app-server root.

Cloud placement is revalidated twice: immediately before dispatch and again
before any result application. `adjudicateCodexCloudPlacementV1` compares freshly
resolved canonical issue/PR owner generation, settlement, exact ref/head, and
experiment freeze against the admitted facts. A settled, superseded, frozen, or
changed mission is stale-released; the function never authorizes dispatch or
application. This captures the Quarry #1052 discriminator: task
`task_e_6a8da270bac88326936d08075e2e07bc` was dispatched after the frozen
experiment had already settled through PR #1053/run 32857504041, so its
4-file/+314 candidate is evidence-only and must not be applied.

Cloud CLI inspection runs from an isolated temporary working directory. If a
probe creates diagnostics such as `error.log` in any repository worktree, the
placement preflight stale-releases and publication remains denied;
account-routing diagnostics are removed precisely, never hidden with a repository
ignore rule.

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

The required-check policy must be non-empty, but it is still caller-supplied.
`publicationEligible` means internally consistent with supplied canonical
evidence; it does not mean this pure function independently discovered repository
policy or current authority.

An incomplete worker may still emit `local_progress` or `local_blocker`, but those
claims are never publication-eligible and the preflight always returns
`authorizesPublication: false`.

## Commands

```sh
bun test test/codex-app-server-client.test.ts test/codex-root-harness.test.ts test/codex-root-routing.test.ts test/codex-root-residency.test.ts test/codex-root-cloud-placement.test.ts test/codex-root-publication-preflight.test.ts
bunx tsc --noEmit
bun run codex-roots:probe
bun run codex-roots:memory-probe
```

The memory probe is intentionally macOS-only. Both live probes create disposable
workspaces, archive their synthetic threads, terminate owned runtime process
trees, and remove their temporary files.
