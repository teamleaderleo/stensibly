# After-action note: agent work coordination at high parallelism

- **Status:** active
- **Opened:** 2026-08-19 UTC
- **Last updated:** 2026-08-19 UTC
- **Author:** Slate · GPT-5.6 Sol, operator-requested GitHub review
- **Scope:** many-agent repository work, review, integration, recovery, and coordination practice in Stensibly; lessons also compare against current Cultist dogfood where useful
- **Version coverage:** `stensibly-agent-ops/0.5.0`; current `main` reviewed at `7580dfd6f23ecfb28e99f273fb6d7629f9ee0bb6`; recent #1500–#1629-era repository history and currently open work sampled on 2026-08-19
- **Confidence:** high for repository-visible coordination patterns; medium for causes that would require private chat/runtime evidence
- **Sensitivity:** public
- **Review by:** when the operating protocol changes materially, the active-work/ledger model becomes authoritative enough to replace GitHub status archaeology, or after the next sustained multi-agent wave

## Situation

Stensibly has become an unusually dense experiment in one-person/many-agent software work. The repository does not merely contain agent-authored code; it contains explicit operating policy, durable work and authority concepts, provider receipts, resumable execution, project activity, deployment reconciliation, review controls, recovery paths, and a large history of agents repairing the operating system they themselves use.

The current operating documents already state many of the right principles:

- `AGENTS.md` tells workers to own meaningful outcomes, keep a small portfolio, continue across implementation/review/integration/deployment/verification, and use blocked time on non-conflicting work;
- `ADAPTIVE_COORDINATION.md` separates responsibility from authority, treats independent review as a tool rather than a ritual, and explicitly says to change instructions that cause stalls, duplicate effort, misleading ownership, or lost evidence;
- the durable operation layer attempts to make chats/processes disposable by retaining exact work, authority, reservation, settlement, reconciliation, and recovery evidence;
- institutional memory exists specifically so reusable lessons survive without turning every successful action into documentation ceremony.

Repository history shows that these principles have produced real leverage. It also shows the next layer of coordination problems: once dozens of agents, controls, carriers, reviews, dogfood runs, and follow-ups exist simultaneously, the main difficulty is no longer only *doing work safely*. It is keeping the repository's representation of active work small, current, non-duplicative, and legible enough that a fresh worker can distinguish:

```text
live implementation
vs
live review
vs
blocked continuation
vs
red control / evidence-only child
vs
stale carrier
vs
superseded candidate
vs
historical research artifact
```

without spending half the run reconstructing the answer.

This note records what has worked, what has created drag, and the next questions worth testing. It is descriptive evidence, not a policy change. Exact live status still belongs to the current issue, pull request, ledger, deployment, and provider receipts.

## Reusable lesson

> **Large agent autonomy works when workers receive durable outcomes, boundaries, authority, evidence, and wake/completion conditions rather than step-by-step scripts. The next scaling limit is not worker intelligence; it is the cost of reconciling too many stale, duplicate, or ceremonial representations of work.**

Stensibly should keep increasing worker independence while reducing the number of surfaces a fresh worker must reconcile before knowing what is real.

## What went well

### 1. Outcome ownership has worked better than ticket choreography

The current protocol's strongest move is asking a worker to own a meaningful outcome and continue through natural boundaries instead of returning after every small action. This matches the observed high-throughput waves: implementation often continues into tests, exact-head repair, merge, deployment, live verification, and fix-forward follow-up without waiting for a human to re-issue an obvious next command.

This removes a costly human relay loop:

```text
worker finishes tiny slice
-> reports upward
-> operator identifies obvious next slice
-> operator messages worker again
-> worker rehydrates context
```

The more effective pattern is:

```text
bounded outcome + authority + overlap fence
-> worker chooses next executable action
-> worker changes tactics when evidence changes
-> worker records only meaningful state transitions
```

This is worth preserving. The repository's current guidance already correctly treats a responsibility as an outcome, not a task script.

### 2. Standing internal-dogfood authority removed a lot of fake approval latency

The distinction between internal reversible dogfood and genuinely external/material effects is productive. Earlier coordination models often treated anything called “production” or anything touching a deployment as if it automatically required another ceremonial approval. The current policy instead asks what consequence is actually occurring.

That lets a worker merge, deploy, verify, repair, and continue inside a reviewed internal-dogfood boundary while still stopping for real access widening, material spend, external publication/contact, secret exposure, destructive non-test data changes, or irreversible migrations without recovery.

The practical benefit is large: authority is explicit enough for agents to act without asking the operator questions that the standing policy has already answered.

### 3. Self-review is useful when independence would be theater

The repository has correctly moved away from a blanket “different agent must review” rule. For mechanical and bounded reversible internal changes, exact self-review plus relevant checks is often stronger than changing chats/callsigns merely to manufacture nominal independence.

This has two benefits:

- the worker with the freshest implementation model can inspect the exact candidate without a lossy handoff;
- scarce independent review can be spent on authentication, authorization, privacy, durable state, cross-project isolation, ambiguous recovery, or other changes where a second reasoning path can actually reduce uncertainty.

The important retained condition is that self-review cannot mean “author says it is fine.” It still needs exact candidate inspection, consequence analysis, relevant tests, and a concrete integration decision.

### 4. Durable receipts and exact identities made autonomy safer

A recurring success across Stensibly is replacing correlated or prose-level status with explicit durable facts:

- exact revisions instead of “latest branch”; 
- provider-current observations instead of assuming deployment commands completed;
- durable operation reservations before provider effects;
- readback reconciliation after ambiguous provider outcomes;
- exact run/responsibility/lease generations rather than loose process presence;
- exact deployment/source identities in receipts;
- authoritative resume conditions rather than reconstructing intention from chat.

Recent history contains several examples where the repository made a proxy less authoritative and moved toward the actual fact. #1605 is especially illustrative: `claimGeneration > 0` had become a convenient proxy for live responsibility even though the counter could advance without a current claim. The repair bound activity to actual live responsibility evidence instead.

This is an important organizational lesson as well as a technical one: **convenient counters, labels, branch names, callsigns, and workflow states should not silently become authority merely because they correlate with it most of the time.**

### 5. Recovery and continuation are increasingly first-class

Stensibly's product direction treats worker/session/process disappearance as normal rather than exceptional. Durable command state, stranded-command ownership, resume inspection, authoritative resume, reconciliation, and project activity all reduce dependence on one long-lived chat.

That is exactly the right direction for high-parallelism agent work. A good coordination system should assume:

- a chat will become unwieldy;
- a model/run may disappear;
- a branch may go quiet;
- a provider response may be lost;
- another worker may need to continue with no private memory.

The repository is materially better when the next worker can recover *what outcome remains, what exact effect already happened, what authority still exists, and what action is executable now* without impersonating the previous worker.

### 6. Failures are frequently promoted into executable guards

One of the strongest habits in the repository is not stopping at “we fixed the incident.” Several failures have moved through a useful maturation path:

```text
specific failure
-> exact reproduction
-> repair
-> reusable invariant
-> test / workflow / provider / protocol enforcement
```

Cultist issue #41 already identifies representative Stensibly cases such as #1575, where a deployment failure class became a repository-wide CI guard rather than another one-off identifier repair.

This is a better form of institutional memory than prose alone. The documentation should explain the lesson, but the durable payoff is when a later worker is physically prevented from repeating the same invalid state.

### 7. The repository is willing to reverse process policy when evidence says it is hurting

Stensibly's operating guidance has evolved after observing real friction. Useful reversals include moving away from blanket production/internal risk assumptions, blanket second-agent gates, and the idea that all existing work must be completed before any new bounded lane may start.

That adaptability is a major positive. Coordination rules are hypotheses about how to reduce error and delay; they should be revised when they become the source of error and delay.

### 8. Parallel work is productive when lanes differ by decision surface

The current guidance to avoid replacing a coherent implementation while allowing non-overlapping implementation, review, deployment, reproduction, evidence, and research lanes is sound.

Parallelism is especially effective when workers differ in *function* rather than all editing the same answer:

```text
implementation owner
+ adversarial reviewer
+ CI/package diagnostician
+ deployment/evidence owner
```

can move faster than four workers independently solving the same implementation from scratch.

This is one of the clearest lessons to transfer to other repositories.

### 9. Provider ambiguity is treated as a state to reconcile, not a reason to guess

The durable operation work's `waiting_reconciliation` style is a strong general coordination pattern. When a provider effect may have happened but local settlement was lost, retrying blindly is unsafe; giving up and calling it failed is also inaccurate.

The system instead retains enough identity to ask the provider/readback surface what happened. This is the right mental model for GitHub, deployment systems, mail, and other providers whose request/response boundary can fail independently from the effect.

### 10. The product is beginning to expose coordination to the operator instead of only encoding it internally

Recent Project Activity, Control Room, decision tray, Studio Radar, quick dispatch, and provenance work point toward a useful product direction: the operator should see the small number of things requiring judgment rather than manually reading every agent thread.

This is a more promising end state than simply making the backend ledger richer. Coordination infrastructure earns its cost when it reduces operator reconstruction and interruption.

## What could have gone better

### 1. “Open pull request” has become an unreliable synonym for “active work”

The strongest visible coordination debt is the long tail of open PRs whose current meaning differs radically:

- live implementation;
- current security repair;
- red control that explicitly says “merge independently: no”;
- stale current-main replay carrier;
- parent/child evidence packet;
- dormant research candidate;
- superseded source retained only for provenance;
- old documentation replay.

Examples visible in the current open queue include old red-control and replay PRs such as #1159, #1171/#1178, #987, #968, #1000, #1249–#1251, #1260, #1411, #1553/#1557, alongside genuinely current #1617–#1629 security/integration work.

A fresh worker therefore cannot safely interpret the GitHub open-PR list without reading substantial historical prose. That is exactly the sort of reconstruction Stensibly is supposed to eliminate.

**Improvement:** make lifecycle state explicit and aggressively retire fake-active work. A red control or absorbed child can remain preserved while closed. If it must remain open for a tool reason, mark it with machine-readable state that clearly excludes it from normal active-work selection.

### 2. Duplicate lanes still appear despite sophisticated coordination machinery

The current queue contains obvious convergence families:

- #1624, #1625, and #1629 all address fail-closed MCP item-project resolution, with different implementation depth;
- #1619 and #1620 both address main-ref guarding for dashboard publication.

Independent reasoning is useful, and duplicate candidates can occasionally expose a better design. The waste occurs when duplicate ownership is discovered only after both workers have produced full PRs, CI, and review artifacts.

**Improvement:** add an admission/preflight moment *before* branch/PR creation for consequential implementation work:

```text
outcome identity
+ likely touched responsibility / paths
+ active candidate search
+ explicit “competing candidate allowed?” decision
```

This should be cheap and advisory for ordinary work. The purpose is not to forbid parallelism; it is to make deliberate competition distinguishable from accidental duplication.

### 3. The live coordination document can become stale faster than workers can trust it

`docs/current-wave.md` was last reconciled on 2026-08-15 while the repository experienced major additional work on August 16–17 and now has a fresh set of #1617–#1629 security/control PRs.

In a slower project, a prose current-wave document is useful. At Stensibly's current churn rate, a hand-maintained exact-state document risks becoming archaeology shortly after merge.

**Improvement:** reduce what the prose wave document claims to facts that are stable enough to curate. Generate or derive volatile fields—active candidates, current heads, blocked/wake conditions—from the durable ledger/GitHub/provider state wherever possible.

A good split is:

```text
human-curated wave thesis / priorities / invariants
+
machine-derived live queue / exact revisions / states
```

rather than repeatedly editing exact SHAs and active lists into Markdown.

### 4. Coordination vocabulary can become another source of cognitive load

Pod, wave, lane, action, run, callsign, responsibility, authority, grant, approval, reservation, settlement, reconciliation, activity, continuation, recovery, compensation, project attachment, operation receipt, provider receipt, and more all have legitimate meanings.

The danger is that a fresh worker spends too much of its useful context budget learning Stensibly's coordination ontology rather than solving the current problem.

The test for every new concept should be:

> Does this distinction prevent a real class of wrong effect, lost continuation, duplicate work, or misleading status that could not be expressed cleanly with existing primitives?

If the answer is merely “this gives us a more precise name for a team habit,” keep it in local guidance rather than product schema.

### 5. Callsigns help provenance but can accidentally imply durable people

The repository correctly states that callsigns are session-local attribution, not authority or permanent expertise. In practice, rich signoff/history can still make later workers talk as though “Keel owns this forever” or wait for a named previous worker to return.

**Improvement:** future handoffs and active-work views should foreground the current outcome/responsibility and exact continuation evidence before callsign history. The callsign should answer “who produced this evidence?” rather than “who must be available for this work to continue?”

### 6. Exact-head discipline can degrade into ritual if the invalidation reason is not explicit

Exact revisions are essential for source review, provider effects, deployment receipts, and mutable candidates. But high churn can create a reflex that *any* ancestry movement invalidates *all* evidence.

This can cause repeated CodeRabbit/CI/review cycles after changes that do not alter the reviewed behavior or files.

The stronger rule is already implicit in the better Stensibly/Preflight work:

- invalidate evidence when the premise it proves changed;
- do not perform ceremonial re-review when only unrelated ancestry or no-content metadata changed;
- when a merge ref changes because the base changed, identify whether the relevant dependency surface changed before deciding how much evidence must be renewed.

**Improvement:** record the invalidation predicate alongside important evidence. Examples:

```text
valid while head tree for paths X remains exact
valid while provider configuration fingerprint remains exact
valid while merge-base control files remain exact
valid only for exact full commit
```

This makes review freshness a property rather than a superstition.

### 7. CI/process optimization itself needs a control-invariant review

The history around CI churn is a valuable second-order lesson. Changes such as #1583/#1598 were motivated by real waste and sought to avoid rerunning expensive validation for equivalent work. Later #1617 identified a control weakness where metadata events/skipped jobs could satisfy required contexts and potentially admit unvalidated merges.

The lesson is not “never optimize CI.” It is:

> **Any optimization that skips, reuses, aliases, or suppresses validation must explicitly prove that the authorization/merge predicate is unchanged.**

A useful pre-merge checklist for control-plane optimizations:

- what event/result previously authorized the effect?
- what new event/result can now stand in for it?
- can skipped/cancelled/neutral states accidentally satisfy the required context?
- does the reused evidence bind the exact source/tree/configuration the protected effect depends on?
- can metadata controlled by an untrusted PR alter admission without source validation?
- is the “equivalent work” relation actually proven or just correlated?

### 8. Security hardening waves can encourage fix-count thinking

The current #1617–#1629 queue contains many worthwhile authorization, workflow, and abuse-boundary repairs. Scanner/audit waves are productive, but they create a risk familiar from other projects: many small “security” PRs can be treated as interchangeable green boxes rather than evaluated by consequence and architecture.

Stensibly should preserve distinctions among:

- externally exploitable authorization boundary;
- internal same-user/dogfood correctness;
- denial-of-service/resource admission;
- CI supply-chain/control boundary;
- metadata/provenance integrity;
- defense-in-depth hardening;
- test-only red control.

That improves merge ordering and prevents broad rewrites merely because several findings share a security label.

### 9. Portfolio breadth can exceed the intended cap without anyone explicitly deciding to widen it

`AGENTS.md` suggests one primary outcome and up to three useful secondary lanes. The current repository's number of simultaneously open research/control/implementation candidates is far higher if GitHub open state is used as the observable portfolio.

Some of those are historical rather than truly active, which reinforces the state-quality problem. But even among current work, a high-parallelism system can gradually accumulate more lanes because every worker reasonably starts something useful during blocked time.

**Improvement:** distinguish global studio WIP from per-worker portfolio. The operator/system should be able to answer:

```text
How many independent implementation decisions are live right now?
How many exact candidates can advance main/deployment?
How many are only review/evidence/research?
```

WIP limits should apply to *decision surfaces likely to invalidate each other*, not raw number of chats.

### 10. Integration should be treated as scarce work, not the automatic afterthought of implementation

Many agents can produce branches faster than the repository can safely review, rebase, merge, deploy, and prove live behavior. Once implementation throughput exceeds integration throughput, opening more branches increases queueing delay rather than total completion.

The work-selection ordering already values integration highly. The practical next step is to measure it explicitly:

- time from code-complete to merged;
- time from green to integrated;
- time from merge to deployed/verified;
- number of head movements while waiting;
- number of duplicate/replay candidates created because the integration queue was unclear.

When those grow, new workers should preferentially become integrators/reviewers/evidence owners rather than create another implementation lane.

### 11. Temporary carriers and self-edit workflows leave a large archaeology burden

Stensibly has used current-main replay carriers, red controls, workflow-assisted repairs, and exact-source donors to solve real bootstrapping problems. These can be legitimate tools. Their cost is that old PR bodies become dense with source donor SHAs, transition workflows, “zero integration authority,” absorbed child controls, and replay instructions.

A fresh worker may correctly conclude that all this history is important and then spend substantial time reading artifacts whose only remaining value is provenance.

**Improvement:** after convergence, collapse the *active* representation aggressively:

- close the donor/control/carrier;
- link it from the merged parent or a short research receipt;
- preserve only the final invariant/tests in ordinary source;
- keep a bounded provenance graph for archaeology rather than keeping every construction scaffold “active.”

### 12. More coordination telemetry is not automatically better coordination

Stensibly now has durable activity, Project Activity, radar-style views, receipts, traces, and detailed lifecycle concepts. This is useful only if it reduces decisions the operator must reconstruct.

Measure product value by whether the operator can answer quickly:

- what needs my decision?
- what is safe and already moving?
- what is blocked and on what exact condition?
- what is duplicate/superseded?
- what happened while I was away?
- where did an effect actually settle?

If a new telemetry field does not improve those answers or a machine recovery invariant, it may be instrumentation debt.

## Questions the project should keep asking

### Active-work truth

1. **What is the canonical active-work authority?** The Stensibly ledger, GitHub PR state, `docs/current-wave.md`, Project Activity, or a projection over several sources?
2. Can the system make `active`, `blocked`, `waiting_ci`, `waiting_human`, `red_control`, `superseded`, `historical`, and `ready_to_integrate` explicit enough that fresh workers do not infer them from prose?
3. Should an open red-control/child PR automatically disappear from normal work-selection queries once its parent absorbs the evidence?
4. Can stale-current-wave age itself become visible evidence instead of silently misleading workers?

### Duplicate prevention without suppressing useful independence

5. Should opening a branch/PR require a cheap active-work preflight against outcome identity, cited issue, and likely touched responsibility?
6. When are two competing candidates desirable? What explicit marker distinguishes intentional design competition from accidental duplication?
7. Could Cultist's active-work/explicit-coordination machinery become a pre-dispatch check for Stensibly workers?
8. How often do duplicate lanes actually happen, and how much wall time/CI/review do they consume?

### Worker independence

9. Which decisions should an outcome owner make locally by default, and which must remain operator-level product/policy decisions?
10. Are workers still returning too often at arbitrary artifacts such as “PR opened” instead of actual outcome boundaries?
11. Does the current one-primary/three-secondary portfolio rule improve completion, or should portfolio size depend on integration contention and uncertainty?
12. What is the minimum handoff packet a totally fresh chat needs to continue a live lane without reading the original chat?
13. Can a worker safely recover a dormant lane based solely on durable Stensibly/GitHub evidence today? If not, what fact is still missing?

### Review

14. Can review depth be derived from concrete uncertainty/impact properties rather than coarse labels alone?
15. Which review findings have historically caught material issues versus generated ritual churn?
16. How often does independent review change the patch compared with exact self-review?
17. What evidence should survive a head move without full re-review?
18. Should important review receipts encode an explicit invalidation predicate?

### Integration economics

19. Is implementation throughput currently higher than integration throughput?
20. What is median time from code-complete -> green -> merge -> deploy -> verified?
21. How much main movement occurs while an exact candidate waits, and how often does that force meaningful rework versus ceremonial reruns?
22. Should the orchestrator steer idle workers toward review/integration when the candidate queue exceeds a threshold?

### Control-plane safety

23. For CI/deployment/process optimizations, can we require an explicit statement of the protected authorization invariant before changing event admission or evidence reuse?
24. Which workflows currently run third-party code before receiving powerful credentials, and are immutable action/runtime pins part of a common policy or one-off fixes?
25. Are “skipped”, “neutral”, “cancelled”, and reused evidence represented distinctly enough that required checks cannot accidentally treat them as validated success?

### Product-versus-process boundary

26. Which Stensibly coordination concepts are actual product invariants and which are merely this repository's current working convention?
27. Has any schema/protocol concept been added primarily because agents were told to produce it, rather than because a demonstrated failure required it?
28. Could any current operating instruction be deleted without reducing safety, recoverability, or operator comprehension?
29. Are we teaching fresh workers how to achieve outcomes, or teaching them how to administer the Stensibly process?

### Operator experience

30. What fraction of operator attention is spent making real product decisions versus routing/reconciling agent work?
31. Can the Control Room show only decision-worthy interruptions by default and keep routine progress expandable?
32. When the operator returns after several hours, can one screen answer “what changed, what is blocked, and what needs me?” without opening GitHub?
33. Are notifications/wakeups based on meaningful state transitions or merely activity volume?

### Learning and institutional memory

34. Which repeated lessons have been promoted from prose -> test -> invariant -> server-enforced fact?
35. Which lessons remain prose despite recurring failures?
36. Which older operating rules were later reversed, and can we identify the evidence that should have weakened them sooner?
37. Do we preserve negative results and rejected coordination ideas as well as successful mechanisms?

## Experiments worth running

### Experiment A: active-work hygiene sweeper

Build or dogfood a bounded classifier that identifies GitHub PRs which are likely:

- absorbed red controls;
- explicit `merge independently: no` children;
- superseded carriers;
- stale candidates with newer canonical replacements;
- live candidates.

Begin read-only. Require exact evidence before closure. Measure how many “open” PRs disappear from a fresh worker's normal active-work set without losing useful provenance.

Success metric: a new worker can inspect the live queue with materially fewer false-active objects.

### Experiment B: pre-implementation overlap admission

Before a worker opens a new implementation branch, compile:

```text
outcome / issue
candidate responsibility/path region
existing open candidates
explicit coordination edges
```

Return one of:

```text
continue independent lane
join existing candidate
review existing candidate
intentional competing candidate (record why)
unknown / inspect more
```

This should be advisory for ordinary work and should never grant mutation authority.

Measure duplicate PR families before/after adoption.

### Experiment C: generated live-wave projection

Keep the human-curated wave thesis and priority narrative, but generate a compact live section from durable work/GitHub/provider facts:

- current canonical candidates;
- exact heads;
- current state;
- blocker/wake condition;
- integration order/edge;
- last evidence time.

Measure stale-fact age compared with the hand-maintained `docs/current-wave.md` pattern.

### Experiment D: review-invalidation receipts

For selected Tier 2 candidates, have review state record what exact premise it proves and what changes invalidate it. Then deliberately advance unrelated main ancestry and compare:

- full re-review;
- premise-scoped revalidation.

Measure missed defects and unnecessary rerun cost.

### Experiment E: integration WIP steering

Track candidate queue length and code-complete-to-merge delay. When the queue exceeds a threshold, route additional agents preferentially toward:

- exact-head review;
- CI diagnosis;
- stale-base integration;
- deployment verification;
- duplicate retirement;

instead of new implementation.

The hypothesis is that total completed outcomes rise even though fewer new branches are created.

### Experiment F: operator-interruption accounting

Classify operator pings for a sample wave:

- real product/policy decision;
- external authority/credential need;
- ambiguity the worker could not resolve from durable state;
- obvious next-step routing;
- stale/duplicate-work reconciliation;
- ceremonial approval.

The goal is not zero operator involvement. The goal is to remove the last three categories while preserving the first two.

### Experiment G: Cultist-fed Stensibly dispatch

Use Cultist's current active-work/preflight evidence as a read-only input before dispatch. Let Cultist answer repository-evidence questions such as overlap, explicit hold edges, and stale applicability; let Stensibly remain the authority for assignment, effect permission, leases, and execution.

This division is promising because it avoids making either product a second copy of the other.

## Practices worth retaining

These are strong defaults unless later evidence disproves them:

- one current responsible actor for a coherent outcome, with delegation allowed;
- responsibility never implies authority;
- callsign is attribution, never exclusive ownership;
- workers own outcomes, not tiny ticket scripts;
- blocked time can be used on non-conflicting work;
- review depth follows risk and uncertainty, not ceremony;
- exact evidence is bound to the premise it actually proves;
- ambiguous provider outcomes reconcile before redispatch;
- external writers/providers remain authoritative at real commit boundaries;
- recovery and continuation must work after chat/process loss;
- detailed evidence belongs in its owning system with durable references;
- process conventions should remain guidance unless they protect a demonstrated invariant;
- successful lessons should preferentially become executable guards rather than ever-longer instructions.

## Practices to resist

The following are recurring temptations that should require evidence before becoming standard:

- one independent reviewer for every change regardless of consequence;
- treating every open PR as active work;
- treating a callsign/assignee as a permanent human role;
- requiring a fresh operator approval for effects already covered by standing policy;
- serializing all work merely to avoid any possible merge conflict;
- opening multiple implementation candidates for the same decision surface without declaring the competition;
- invalidating all evidence after any head/base movement regardless of premise;
- keeping red controls/carriers open forever for provenance;
- adding a new durable state field for every local team habit;
- optimizing CI or review cost without proving the protected admission predicate is unchanged;
- producing more telemetry because it is available rather than because it improves recovery or operator decisions.

## Cross-repository lesson: Stensibly and Cultist should remain complementary

Current dogfood suggests a useful boundary:

### Stensibly is strongest at

- responsibility and assignment;
- effect authority;
- leases/reservations;
- execution and settlement;
- provider reconciliation;
- recovery/continuation;
- operator-facing durable work state.

### Cultist is strongest at

- repository evidence selection;
- precedent and counterexamples;
- active-change/preflight evidence;
- applicability/freshness reasoning;
- bounded research questions;
- preserving `UNKNOWN` rather than inventing intent;
- testing whether a coordination heuristic deserves promotion.

A healthy composition is:

```text
Cultist: what repository evidence should affect this work?
        |
        v
Stensibly: who owns the outcome, what may they do, and what effect settled?
        |
        v
Cultist: what did the outcome teach the repository, if anything?
```

Cultist evidence must not itself grant Stensibly effect authority. Stensibly work state must not turn local organizational habits into universal Cultist repository rules.

## Evidence and source coverage

Evidence reviewed for this note includes:

- `AGENTS.md` operating protocol and risk-tier/recovery guidance;
- `ADAPTIVE_COORDINATION.md`;
- `docs/current-wave.md`;
- `POSTMORTEMS.md` and the institutional-memory practice;
- current open pull-request inventory sampled on 2026-08-19, including the #1617–#1629 control/security wave and older carrier/red-control work;
- recent repository commits around durable activity, Project Activity, deployment reconciliation, exact CI evidence, resume, and duplicate-work reduction;
- public Cultist issue #41, which independently records Stensibly agentic episodes as an organizational-precedent corpus.

Evidence not available to this review:

- private chat transcripts across all workers;
- a complete Stensibly ledger export measuring every run/handoff;
- operator-interruption timing/count data;
- a complete classification of every open PR as live/stale/absorbed;
- direct causal proof for why individual workers opened overlapping lanes.

Interpretations about incentives or worker intent are therefore deliberately avoided. Duplicate/stale patterns are described from repository-visible artifacts only.

## Recommended use

Use this note when:

- revising `AGENTS.md` or `ADAPTIVE_COORDINATION.md`;
- designing active-work/Control Room projections;
- changing review or merge policy;
- adding automatic stale-work/duplicate-work handling;
- deciding whether a coordination convention belongs in product schema;
- evaluating whether worker autonomy should expand further;
- designing Stensibly/Cultist integration.

Do not use it as an excuse to add another mandatory workflow. The primary recommendation is **less reconstruction and fewer fake-active coordination artifacts while preserving the autonomy that already works.**

## Limits and counterexamples

- High open-PR count is not inherently bad. Some deliberately independent research/control candidates are valuable; the defect is ambiguity about their current lifecycle.
- Duplicate implementations can occasionally expose independent counterexamples or a superior design. The goal is intentional competition, not forced single-threading.
- Exact full-head review is still appropriate when a candidate's behavior can change through broad integration effects or generated/dependency surfaces.
- Independent review remains valuable for genuinely consequential or uncertain changes even when self-review is allowed.
- More durable state is justified when it protects authority, recovery, or idempotency. This note argues against state that merely mirrors local ceremony.
- Stensibly's internal-dogfood autonomy model should not be generalized automatically to external multi-user deployments with different trust and approval boundaries.

## Durable follow-up

- [ ] Measure duplicate-lane rate and code-complete-to-integration delay over one future wave.
- [ ] Prototype a read-only stale/superseded/red-control active-work classifier before any automated closure.
- [ ] Test a generated live-wave projection that keeps prose strategy separate from volatile exact state.
- [ ] Evaluate premise-scoped review invalidation on a small set of Tier 2 changes.
- [ ] Dogfood Cultist active-work/preflight evidence before new Stensibly implementation dispatches.
- [ ] Revisit whether the operator-interruption mix has shifted from routing/ceremony toward real product decisions.

Owner or eligible continuation: any coordination/product worker under #406 / the current agent-operations programme; promote only the experiments that earn themselves.

## Omitted sensitive data

No credentials, tokens, provider payloads, private repository content, private chat transcripts, personal mail, or unrestricted operator data are included. The note uses public repository-visible evidence and project-owned public cross-references only.
