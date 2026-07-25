# Distributed coordination correctness model

Status: proposed architecture

Tracks: #146

Related implementation work: #147, #148, #149, #150, #152

## Purpose

Stensibly is not primarily a chat memory system or a generic task queue. It is a durable coordination ledger for humans, agents, supervisors, runners, scripts, and external services that may all retry, pause, crash, reconnect, or act concurrently.

That makes the core problem a distributed-systems problem:

- several processes may observe different snapshots;
- messages and webhooks may be delayed, duplicated, reordered, or lost;
- a process may continue running after its authority expired;
- a provider may accept a request even when the caller loses the response;
- wall clocks may disagree or produce tied timestamps;
- no global transaction spans Stensibly and every external provider;
- agent runtimes and conversations are disposable, while coordination state must survive.

The goal is not to eliminate all concurrency. The goal is to make concurrency safe, explainable, and recoverable while paying coordination cost only where the domain requires a single authoritative decision.

## Core thesis

Stensibly should separate **monotonic facts** from **non-monotonic decisions**.

Monotonic facts accumulate without invalidating earlier facts. With stable identities and merge rules, they can normally tolerate duplicated and reordered delivery:

- observations and evidence;
- artifact and checkpoint references;
- provenance and audit records;
- positive acknowledgements;
- completed dependency facts;
- satisfied wake-condition evidence;
- alternative proposals and candidate outputs.

Non-monotonic decisions can invalidate another possible conclusion and therefore require coordination at an authoritative boundary:

- selecting one current claim holder;
- consuming one promise generation;
- enforcing capacity or budget ceilings;
- cancelling or superseding work;
- choosing one continuation or proposal;
- declaring work complete;
- revoking permission;
- approving an irreversible action;
- deleting or compacting state whose absence carries meaning.

The practical rule is:

> Append and merge facts. Serialise decisions at the smallest aggregate that owns the invariant.

## Protocol vocabulary

The following identities must remain distinct.

### Work item ID

The durable unit of intent and coordination.

### Command ID

One intended domain effect across all transport retries. A timeout or worker restart does not create a new command ID.

### Delivery or attempt ID

One transport, scheduling, or worker attempt to execute a command. A command can have several attempts.

### Run ID

One durable supervised execution lifecycle. A run may survive runner process replacement and contain several attempts or checkpoints.

### External execution ID

The provider- or runtime-owned reference for a job, pull request, deployment, task, or session.

### Event ID

One accepted durable fact.

### Correlation or workflow ID

A group of related commands and events that form a multi-step workflow. Correlation does not imply a total global order.

### Causation ID

The command or event that directly caused a new event.

### Authority fence

A monotonically increasing generation attached to an exclusive authority grant. It distinguishes the current holder from a paused or stale former holder.

## Aggregate boundaries

Strong consistency should stay local to the smallest aggregate that owns an invariant. Candidate aggregates are:

- a work item and its current claim projection;
- a run and its lease, retry, checkpoint, and terminal state;
- a promise generation and its consumption state;
- a continuation generation and its decision state;
- a resource and its capacity allocation;
- a human decision request generation;
- an account session, API token, or membership administration record.

Inside an aggregate, the authoritative storage transaction or compare-and-set operation owns the invariant. Across aggregates, Stensibly should use durable commands, events, observations, and saga progress rather than pretending there is a global transaction.

Derived boards, briefs, activity feeds, counts, and context packets are replaceable projections. They may be bounded or slightly stale, but they never grant write authority.

## Correctness layers

### 1. Command identity and idempotency

Every retriable mutation needs a stable command identity.

For the first accepted command:

- store the command ID;
- store a canonical request fingerprint;
- execute the domain transition;
- store the deterministic result or terminal domain rejection.

For a duplicate delivery:

- if the fingerprint matches, return the stored result;
- if the fingerprint differs, reject an idempotency conflict;
- do not append a second domain event.

Idempotency answers: **Have we already applied this intended effect?**

It does not answer: **Is this caller still authorised to act?**

### 2. Leases and fencing

A lease says that a holder should stop after an expiry. A lease alone cannot prevent a paused process from waking later and acting with stale state.

Every exclusive authority grant therefore needs:

- aggregate or resource identity;
- holder identity;
- server-decided expiry;
- monotonically increasing fencing token.

Holder-only renew, heartbeat, transition, completion, release, cancellation acknowledgement, and external side-effect acknowledgement must present the current fence. The receiver rejects older fences even when the caller still has valid authentication credentials or an old lease record.

Idempotency and fencing solve different problems:

- idempotency rejects duplicate execution of the same command;
- fencing rejects any execution by an obsolete authority holder.

External adapters must carry both command ID and fence. Where a provider cannot enforce the fence directly, the adapter must persist the greatest accepted fence locally and reconcile provider state before acting.

### 3. Event order and causality

Wall-clock timestamps are display and deadline metadata, not a sufficient concurrency protocol.

A durable event envelope should eventually include:

- event ID;
- aggregate type and ID;
- monotonically increasing aggregate sequence;
- command ID;
- causation ID;
- correlation or workflow ID;
- actor/principal and run identity;
- authority fence for exclusive actions;
- observed wall-clock time;
- schema version.

Aggregate sequence defines accepted order inside one aggregate. Causation explains why an event exists. Correlation traces a workflow across aggregates without inventing a total global order.

Legacy or imported events should retain explicit uncertainty rather than receiving fabricated causal precision.

### 4. At-least-once delivery and exactly-once effects

Stensibly should assume at-least-once delivery for:

- supervisor dispatch;
- runner commands;
- provider webhooks;
- scheduled checks;
- promise evaluation;
- outbox publishing;
- operator retries after ambiguous failures.

Exactly-once effect is built from:

- stable command identity;
- canonical request fingerprint;
- durable inbox result;
- authority fence;
- atomic local state transition plus outbox insertion;
- deduplicated acknowledgement;
- observation and reconciliation after ambiguous provider outcomes.

No component should claim exactly-once network delivery.

### 5. Promises and wake conditions

Promise evaluation and promise consumption are different operations.

A promise generation contains immutable intent, conditions, policy, and deadline. Observations and satisfied-condition evidence append monotonically. Evaluation may run repeatedly and concurrently.

Becoming eligible should be derived from durable facts. Selecting one continuation is a coordinated decision:

1. evaluate the wake predicate over canonical facts and authoritative time;
2. append or deduplicate satisfied observations;
3. claim the eligible promise generation with compare-and-set/fencing;
4. create or resume one continuation;
5. record consumption, retry, release, cancellation, or escalation explicitly.

A duplicate wakeup is harmless. Two consumers cannot both own the same promise generation.

### 6. Cross-aggregate and external workflows

A branch, commit, pull request, deployment, message, or provider task cannot participate in a single transaction with the Stensibly database.

Use a saga-style forward workflow:

- commit local intent and outgoing command;
- dispatch with stable command ID and fence;
- observe provider state;
- record evidence and advance workflow progress;
- retry only after classifying an ambiguous outcome;
- compensate with a new forward action where possible;
- escalate partial or irreversible completion visibly.

Compensation is not deletion of history. Cancellation stops future authority but cannot pretend completed effects disappeared.

Irreversible or consequential steps require an explicit approval policy and an approval bound to the exact proposal generation and digest.

### 7. Safety and liveness

Safety and liveness are separate obligations.

Safety examples:

- at most one current authority generation controls an exclusive resource;
- stale fences never mutate protected state;
- one command creates at most one effect;
- one promise generation is consumed at most once;
- cancellation and completion cannot both commit for the same generation;
- project and workspace isolation never weaken during retries or imports.

Liveness examples, under stated fairness and availability assumptions:

- eligible work eventually dispatches or escalates;
- expired authority eventually becomes reclaimable;
- retryable failure eventually retries or exhausts its budget;
- satisfied promises eventually become consumable or escalate;
- every waiting state has a named wake condition, next evaluation, and deadline.

Safety checks must never be bypassed to improve liveness.

### 8. Time

Use server-authoritative time for lease and deadline admission. Clients may request durations but should not decide authoritative expiry unless specifically trusted.

Use logical sequence and fences for ordering. Use physical time for:

- display;
- deadlines and expiry under a named clock source;
- latency and age metrics;
- provider observation timestamps.

A timeout means the caller is uncertain. It does not prove that an external effect did not happen.

### 9. Failure taxonomy

Expected contention and safety failures must be distinguishable.

Representative codes:

- `stale_authority`;
- `lease_expired`;
- `idempotent_replay`;
- `idempotency_conflict`;
- `version_conflict`;
- `capacity_denied`;
- `condition_unsatisfied`;
- `approval_required`;
- `retryable_provider_failure`;
- `ambiguous_provider_outcome`;
- `retry_budget_exhausted`;
- `invariant_violation`;
- `dead_lettered`;
- `terminal_domain_rejection`.

Telemetry should expose command age, retry exhaustion, stale-fence attempts, lease churn, promise lateness, outbox backlog, and stuck-state deadlines without logging credentials or full private payloads.

## Operation classification

| Operation | Default classification | Required boundary |
|---|---|---|
| append progress evidence | monotonic | stable event/command identity |
| attach immutable artifact reference | monotonic | provenance and dedupe |
| add satisfied wake observation | monotonic | observation identity |
| submit alternative proposal | monotonic | immutable candidate identity |
| acquire claim | non-monotonic | item aggregate transaction and new fence |
| renew/release claim | non-monotonic | current holder and fence |
| complete/block/cancel item | non-monotonic | item version, authority, command ID |
| reserve capacity | non-monotonic | resource aggregate admission transaction |
| consume promise | non-monotonic | promise generation compare-and-set |
| approve consequential action | non-monotonic | exact proposal digest and generation |
| publish outbox message | delivery operation | durable outbox and attempt identity |
| accept provider webhook | monotonic observation | signature, provider delivery dedupe |
| infer provider/domain transition | non-monotonic | authoritative aggregate revalidation |
| compact or delete history | non-monotonic | retention policy and tombstone rules |

## Current Stensibly mapping

Stensibly already has important pieces of this model:

- idempotency keys and stored command results on many mutation paths;
- claim generations and expiring ownership;
- reservation generations and capacity checks;
- queued-run lease generations, retries, heartbeats, and terminal states;
- continuation generations and optimistic decision guards;
- append-only events and durable evidence references;
- server-owned authorisation and project boundaries;
- bounded context packets and derived dashboard projections;
- conservative custodian behaviour that repairs invariant-derived state without making semantic work decisions.

The largest gaps are:

1. generations are not yet one explicit end-to-end fencing contract across all side-effect boundaries;
2. feature-specific idempotency needs a durable generic command inbox/outbox for process and provider boundaries;
3. events need causal envelopes and stable sequence semantics beyond timestamps;
4. promises need monotonic observation plus guarded-consumption semantics;
5. core interleavings need model checking and deterministic fault injection;
6. cross-system partial completion needs a first-class workflow and compensation model.

## Recommended implementation order

### Phase A: define and verify the authority boundary

1. Inventory every generation and holder-only operation.
2. Introduce one shared authority-fence contract.
3. Extend stale-worker tests through adapters and external acknowledgements.
4. Model-check claim/run takeover before adding horizontal supervisors.

Tracks: #147, #150.

### Phase B: durable command delivery

1. Define canonical command envelope and fingerprint test vectors.
2. Add durable inbox replay/conflict semantics.
3. Add transactional outbox within each database boundary.
4. Use one real provider or runner path as the conformance slice.
5. Add reconciliation-before-retry for ambiguous outcomes.

Tracks: #148.

### Phase C: causal history and deterministic projections

1. Add aggregate sequence, causation, and correlation fields.
2. Define legacy/import compatibility.
3. Move pagination and projection rebuilds away from timestamp-only ordering.
4. Thread source references into context packets and audits.

Tracks: #149.

### Phase D: promises and supervision

1. Split promise generation, observations, eligibility, and consumption.
2. Add bounded retry/deadline/escalation policy.
3. Run duplicate evaluators safely.
4. Integrate one end-to-end supervisor and runner before horizontal scaling.

Tracks: #152, #46, #47.

### Phase E: cross-system workflows and autonomy gates

1. Add saga progress and compensation semantics.
2. Bind approval to exact proposal generation/digest.
3. Add dead-letter and reconciliation queues.
4. Increase autonomous authority from observe to propose to bounded apply using measured rollout gates.

## Review checklist

A coordination change is incomplete unless the pull request answers:

1. What aggregate owns the invariant?
2. Is the operation a monotonic fact or a non-monotonic decision?
3. What is the stable command ID and deduplication scope?
4. What request fingerprint makes key reuse safe?
5. What version or fence rejects stale authority?
6. Which storage operation is the authoritative commit point?
7. Which event sequence, causation, and correlation metadata is emitted?
8. What happens if the response is lost after commit?
9. What happens if delivery is duplicated or reordered?
10. What happens if the worker pauses past expiry and resumes?
11. What is the deadline, retry budget, and escalation path?
12. Can partial external completion be observed or compensated?
13. How do mixed old/new clients behave during rollout and rollback?
14. Which tests cover concurrency, restart, and ambiguity?
15. Which safety and liveness properties belong in the formal model?

## Non-goals

This model does not require Stensibly to implement its own distributed consensus database. Convex or SQLite remains responsible for atomicity inside its supported storage boundary.

It also does not require every append-only observation to acquire a global lock, every event to have a globally total order, or every workflow to simulate a distributed transaction.

The objective is smaller and stricter: make each domain invariant have one authoritative home, make retries explicit, fence stale authority, preserve causality, and surface partial failure honestly.

## Foundational references

- Leslie Lamport, “Time, Clocks, and the Ordering of Events in a Distributed System,” 1978: https://www.microsoft.com/en-us/research/publication/time-clocks-ordering-events-distributed-system/
- Cary G. Gray and David R. Cheriton, “Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency,” 1989: https://doi.org/10.1145/74850.74870
- Hector Garcia-Molina and Kenneth Salem, “Sagas,” 1987: https://doi.org/10.1145/38713.38742
- Mike Burrows, “The Chubby Lock Service for Loosely-Coupled Distributed Systems,” 2006: https://research.google.com/archive/chubby.html
- Tushar Chandra, Robert Griesemer, and Joshua Redstone, “Paxos Made Live — An Engineering Perspective,” 2007: https://research.google.com/archive/paxos_made_live.html
- Giuseppe DeCandia et al., “Dynamo: Amazon’s Highly Available Key-value Store,” 2007: https://www.amazon.science/publications/dynamo-amazons-highly-available-key-value-store
- Pat Helland, “Life beyond Distributed Transactions: an Apostate’s Opinion,” 2007: https://www.cidrdb.org/cidr2007/papers/cidr07p15.pdf
- Patrick Hunt et al., “ZooKeeper: Wait-free Coordination for Internet-scale Systems,” 2010: https://www.usenix.org/conference/usenix-atc-10/zookeeper-wait-free-coordination-internet-scale-systems
- James C. Corbett et al., “Spanner: Google’s Globally-Distributed Database,” 2012: https://research.google/pubs/spanner-googles-globally-distributed-database-2/
- Joseph M. Hellerstein and Peter Alvaro, “Keeping CALM: When Distributed Consistency is Easy,” 2020: https://doi.org/10.1145/3369736
