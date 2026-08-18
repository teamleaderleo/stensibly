# Stensibly development log

This log explains major product and reliability progress in plain language. It complements `docs/current-wave.md`, which remains the exact operational record.

Update this file when a meaningful capability lands, a deployment or authenticated dogfood result changes the product picture, or a major review changes the accepted direction. Do not add one entry for every red control, carrier, or CI retry.

## 2026-08-08 — Configured delegated GitHub reads became the normal configured state

The reviewed delegated GitHub read surface now defaults on when complete hosted GitHub provider configuration is present. This landed through #1168. The change is deliberately narrow: delegated reads and job-detail reads adopt configured default-on behavior, while generic exact-boolean settings remain default-off.

Exact `false` remains an independent recovery switch for the delegated surface and for job-detail reads. Empty configuration remains unconfigured, partial provider configuration still fails closed, and existing project scope, repository binding, token permissions, response bounds, and content-minimisation checks remain authoritative.

This is a repository activation-policy change, not live hosted proof. W01 still needs an authenticated deployed GitHub job step/log receipt before #697 can be treated as accepted in product use.

## 2026-08-07 — Hosted MCP verification moved from catalogue presence to contract evidence

Stensibly now checks much more of the deployed MCP surface before a protected Worker release can be treated as verified.

The checked-in ChatGPT action snapshot protects the complete MCP action contract rather than only a tool count or coarse fingerprint. The hosted verifier then calls the live `tools/list` path and compares the deployed result with that full contract.

The current verifier follow-up order is intentional. #1194 first hardens the live `tools/list` response boundary: exact JSON-RPC identity, strict duplicate-key JSON, status-first rejection, bounded byte/chunk intake, intrinsic typed-array copying, contained cleanup, and Web Streams intrinsic reader handling. After that parent lands, #1193 replays the bounded real `survey_workspace` read on top of it so release verification proves both declaration and one read-only execution path.

Those follow-ups are deliberately read-only. They do not add MCP tools, provider mutations, credentials, deployment authority, or new runtime permissions. They also do not replace authenticated dogfood evidence: repository tests prove verifier code, while the protected deployment path must still run the final command against both configured hosted origins.

## 2026-08-07 — Project Pulse foundations became concrete repository capability

Several pieces needed for a future live Project Pulse are now on main:

- Work Pulse provides fixture-only executable UI evidence for responsibility, receipts, attention, relations, and accepted events;
- automatic activity observations provide deterministic content-minimised facts without prompts, private reasoning, raw provider bodies, credentials, or unbounded logs;
- exactly-once activity ingestion defines replay, conflict, semantic deduplication, and scope isolation without granting authority;
- Project Brief compilation provides a detached read-only work projection over admitted item and artifact snapshots;
- GitHub repository binding facts provide bounded read-only provider context without exposing credentials or write authority.

Open work is filling the remaining read-only reasoning layers: causal operator attention, return-to-work delta briefs, append-only Merkle proofs, and reusable simulation-only execution recipes. Review of these modules continues to reject caller boundaries that look bounded semantically but still let hostile JavaScript objects force unbounded or trap-driven inspection.

There is still no live Project Pulse aggregate endpoint, durable attention inbox, notification channel, or autonomous decision surface.

## 2026-08-07 — Exact caller inspection became a recurring reliability rule

A repeated JavaScript boundary lesson has now influenced several modules: checking a length or validating an object after copying it is insufficient if the first copy step enumerates caller-controlled keys, invokes accessors, consults typed-array constructor/species state, or lets a revoked Proxy escape through a raw runtime error.

Current repairs use direct descriptors for known fields, direct own array length before dense indices, compiler-owned snapshots before later validators, and intrinsic byte-copy paths for untrusted response chunks. Review is also tightening a subtler variant: error-normalization code must not inspect arbitrary values thrown from hostile caller or provider traps while trying to decide which fixed local error to return.

This work now appears in activity admission, Project Brief, return-to-work deltas, hosted MCP verification, delegated GitHub reads, Merkle admission, execution recipes, policy simulation, and native provider responses.

The aim is not to accept more input. It is to make accepted work genuinely bounded before caller-controlled traps can run.

## 2026-08-07 — Native repository writes changed direction toward exact old-ref compare-and-swap

The private native repository-write chain has reviewed repository/ref/path/object admission, bounded installation-token profiles, immutable-parent Git Data construction, ordinary executable-mode preservation, and bounded provider response handling.

Review found one important publication gap in the original atomic candidate. A REST branch update with `force: false` proves that the new commit is a fast-forward from the branch's current position; it does not prove that the branch still equals the exact old object ID that Stensibly observed. An ancestor regression can therefore satisfy fast-forward rules while violating the exact-parent requirement.

The active integration direction now uses GitHub GraphQL `updateRefs` with `beforeOid` bound to the observed old object ID. The direct integration lane is also absorbing small-array caller-inspection controls, HTTPS-only provider transport outside the explicit localhost test seam, and a mutation identity that fingerprints the complete admitted CAS request rather than a truncated new SHA.

This chain remains private. No native repository-file write is mounted hosted or exposed as a public MCP action.

## 2026-08-07 — Policy simulation started as a non-authorizing counterfactual layer

A pure MCP capability-policy simulator is under review. It compiles the existing policy contract, evaluates a bounded representative subject set, and reports how a candidate policy would change direct allow/deny decisions, approval requirements, exposure, risk, project resolution, receipt/reconciliation behavior, and affected active work.

The simulator is explicitly counterfactual: its output cannot activate policy, approve work, grant authority, execute a provider call, or mutate state. Review is currently tightening complete semantic classification and ensuring source-reference accounting is computed from all classified evidence before presentation limits hide individual rows.

This is the intended direction for broader autonomy work: reuse accepted evaluators and make prospective changes inspectable before anything is allowed to execute.

## 2026-08-07 — Shared provider method capture and activity ingestion landed

Descriptor-safe provider method capture is now on main. Public GitHub issue MCP composition and hosted durable-receipt composition use one bounded helper for own or inherited data methods while preserving the original receiver, rejecting accessors and non-function shadows, excluding `Object.prototype`, and bounding hostile prototype traversal.

Automatic activity ingestion also landed after its parent observation contract. Exact delivery replay returns the original receipt, changed reuse conflicts, semantic duplicates under new delivery IDs deduplicate, and workspace/project scope stays explicit. The reference implementation grants no provider execution or decision authority.

Both changes reduce duplicated edge-case policy without expanding the public action surface.

## 2026-08-06 — Work Pulse became merged fixture-only product evidence

Work Pulse lives on main as a Labs operator view over an admitted fixture. It exercises the real comparison surface inside its opaque iframe sandbox and displays attempts, authority generations, receipts, bounded attention, declared relations, and accepted timeline events.

Browser review repaired skip-link focus, UTC timestamp disclosure, admitted attempt-state styling, compact overflow behavior, and default/empty/degraded/failure journeys. External requests remain blocked.

Work Pulse is still not a live activity stream. It changes no production root, provider behavior, persistence, or deployment authority.

## 2026-08-06 — Context reconciliation and acceptance moved onto main

The GitHub context path contains deterministic proposal/request compilation, instruction-observation resolution, and accepted-context composition.

The chain binds provider receipt identity, attachment generation, request fingerprints, provider/observation chronology, retained-credential admission, GitHub item bounds, and private-base import boundaries. These compilers remain authority-free.

Landing them does not prove a hosted context read or sustained W01 lifecycle; those require live authenticated evidence.

## 2026-08-05 — Hosted GitHub issue writes remained explicit opt-in

Stensibly contains typed hosted GitHub issue creation, update, and comment writes backed by durable receipts. Current behavior requires exact `STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED=true` before those methods mount. Absent, empty, and exact `false` remain read-only, and durable receipt methods remain mandatory after activation.

Default-on issue-write proposals were closed without merge. Repository integration is therefore not evidence that writes are enabled in the hosted environment.

The live W01 requirement remains one authorised idempotent create/update/comment journey with durable receipt lookup, reconnect, accepted context reconciliation, and proof that exact replay does not duplicate the provider effect.

## 2026-08-05 — Durable repository-write identity and CI evidence tightened

Repository-write receipts gained stricter stored identity and privacy admission. One exact project-scoped owner is required for external receipt identity, and lookup identifiers use the same credential-safe admission before durable-store work.

The repository also gained a non-authorizing red-control CI profile. It can preserve exact source, base, merge-base, parent, and changed-path evidence for an intentionally failing control without turning that failure into merge authority.

Queued, cancelled, stale-parent, carrier, predecessor, and red-control runs remain evidence only.

## 2026-08-04 — Formal settlement and observation proofs improved the reliability baseline

The cancellation-settlement TLA+ model and reachability witnesses are merged. They check safe and unsafe schedules, retained retry capacity, and active cancelled-caller rejoin behavior.

Observation Merkle work defines content-minimised inclusion and append-only prefix proofs over admitted ledger identities. Its public admission remains under review for fixed-record and revoked-array caller inspection, and the proof intentionally says nothing about provider truth, authorization, settlement, signing, persistence, or deployment eligibility.

Formal and cryptographic evidence constrain later runtime behavior; they do not themselves execute provider effects.

## 2026-08-03 — GitHub became the independent project and recovery record

The W01 reliability campaign established GitHub as the independent source for repository instructions, source, issues, reviews, CI receipts, blockers, recovery branches, and handoffs during Stensibly degradation.

Stensibly adds durable responsibility, authority, continuation, provider receipts, and execution history when its connector is available. A connector outage must never hide the backlog or make recovery depend on the connector that is failing.

## What remains unproved

Repository progress is substantial, but W01 remains incomplete until fresh authenticated sessions repeatedly prove:

- the exact deployed Worker/MCP revision and refreshed ChatGPT app state;
- bounded hosted MCP contract verification and a stable read against both governed origins after the current verifier follow-ups land;
- one hosted project-context read used in a sustained journey;
- one hosted idempotent GitHub write with durable receipt lookup and exact replay without duplicate provider mutation;
- authenticated hosted GitHub job-step/log reads under the merged configured-default-on policy;
- disconnect/reconnect recovery;
- the complete create/claim/event/artifact/read/complete/reread lifecycle across several calls;
- GitHub availability throughout Stensibly degradation.

A merged PR, green CI run, dashboard sign-in, deployment command, or one successful provider call is evidence, not completion.
