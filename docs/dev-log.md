# Stensibly development log

This log explains major product and reliability progress in plain language. It complements `docs/current-wave.md`, which remains the exact operational record.

Update this file when a meaningful capability merges, a deployment or authenticated dogfood result changes the product picture, or a major repair changes the active direction. Do not add one entry for every control PR or carrier branch.

## 2026-08-07 — Automatic activity evidence reached main, and bounded-input review tightened

The authority-free `orchestrator-activity-observation/v1` contract is now on main. It gives automatic work and provider activity one deterministic, content-minimised record with exact source identity, work/attempt/run responsibility, causal evidence, provider lifecycle, bounded attention, and explicit disclosure fields. It retains no prompt, private reasoning, raw provider body, credential material, or unbounded log text.

The next ingestion and attention layers remain under review. Their review has already caught an important boundary: checking an array length before `Object.getOwnPropertyDescriptors()` is not enough when a caller-controlled Proxy can still return an arbitrarily large decorated key set for an otherwise valid length. Current work is moving these public boundaries toward fixed direct-descriptor reads and zero caller `ownKeys` where the schema is already known.

This is useful reliability progress even before those children land: the repository is rejecting implementations that are semantically bounded but not physically bounded under hostile JavaScript objects.

## 2026-08-07 — Native repository-write convergence exposed a post-timeout cancellation escape

The private native repository-write stack now has reviewed canonical path/object admission, combined installation-token permission profiles, and an atomic Git Data publication candidate. The atomic path constructs one direct-child commit from the immutable expected parent, preserves ordinary executable mode, and publishes only through a non-forced branch ref update.

A later review found that two cancellation helpers still inspect provider-controlled cleanup results with `"then" in value` and assimilate them through `Promise.resolve(value)`. A hostile Proxy or `then` getter can therefore run synchronously after the deadline while cancellation is supposed to be best-effort and non-awaited. Existing green CI did not cover that case.

The stack is intentionally blocked until cancellation suppression uses an internal-slot-only native Promise check and hostile-thenable regressions prove that cleanup cannot execute caller-controlled property traps. No native repository mutation is public or deployed.

## 2026-08-07 — Configured delegated reads have accepted source, but rollout remains gated

A current-main policy candidate makes the already reviewed delegated GitHub read tools available by default when complete hosted GitHub App configuration is present. Exact `false` remains an independent recovery switch for the full delegated surface and for job-detail reads; an empty environment stays unconfigured; partial or malformed configuration still fails closed.

The source behavior is technically reviewed, but integration approval remains withheld. Default discovery would expand the visible hosted surface to bounded job-step and job-log reads, so the rollout still needs explicit operator acceptance plus authenticated hosted proof of project/repository scope, response bounds, credential rejection, and content minimisation. Green repository CI alone is not rollout evidence.

## 2026-08-07 — Shared provider method capture is converging without widening authority

A current-main refactor extracts duplicated descriptor-safe provider method capture into one helper used by public GitHub issue MCP composition and hosted durable-receipt composition.

The helper preserves the original receiver, accepts own or inherited data methods, stops at `Object.prototype`, treats accessors and non-function shadows as hard denials without invoking getters, and bounds hostile or cyclic prototype traversal. The change is implementation-only: it does not add tools, permissions, provider calls, rollout flags, or authority.

Source review is complete; canonical execution remains the integration gate.

## 2026-08-06 — MCP compatibility checks became simpler without changing meaning

The MCP release-manifest compatibility path now uses one direction-aware numeric-bound classifier instead of mirrored lower- and upper-bound helpers.

The merged change covers all ten supported JSON Schema minimum, maximum, exclusive-minimum, exclusive-maximum, and length/item/property bound keywords. Canonical CI passed strict TypeScript, repository and Convex tests, the Worker bundle, browser evidence, runtime parity, serial-full, and exact-ref validation before integration.

This is an implementation cleanup, not a capability change. Existing compatible, widened, narrowed, added, and removed classifications remain unchanged.

## 2026-08-06 — Work Pulse became merged fixture-only product evidence

Work Pulse now lives on main as a fixture-only Labs operator view. It exercises the real Labs comparison surface inside its opaque iframe sandbox and consumes the dedicated admitted Work Pulse fixture through an immutable classic bridge.

The route displays exact attempts, authority generations, receipts, attention records, declared relations, and accepted timeline events while blocking external requests. Browser review exposed and repaired skip-link focus, stale catalogue expectations, and oversized compact screenshots. Compact attempt and timeline regions remain keyboard-scrollable and named without dropping admitted records from the DOM.

Work Pulse is still not a live activity stream. It changes no production root, provider behavior, persistence, or deployment authority.

## 2026-08-06 — Context reconciliation and acceptance moved onto main

The GitHub context path now contains deterministic proposal/request compilation, instruction-observation resolution, and accepted-context composition on main.

The chain binds exact provider receipt identity, accepted attachment generation, request fingerprint, provider/observation chronology, retained-credential screening, GitHub item bounds, and private-base import boundaries. Carrier workflows used during convergence were retired once their intended source packets were already present on main.

These compilers remain authority-free. Landing them does not by itself prove a hosted context read, provider mutation, or sustained W01 lifecycle; those require live authenticated evidence.

## 2026-08-05 — Hosted GitHub issue writes became an explicit opt-in capability

Stensibly contains typed hosted GitHub issue creation, update, and comment writes backed by durable receipts. Current main requires exact `STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED=true` before those methods mount. Absent, empty, and exact `false` remain read-only, and durable receipt methods remain mandatory after activation.

Issue creation also accepts bounded initial labels and assignees. Invalid or duplicate metadata fails before provider dispatch, and omitted metadata remains an exact empty set.

The repository still does not prove the current production Worker revision, ChatGPT app refresh, reconnect, or a complete authenticated no-duplicate replay journey. Those live W01 proofs remain separate from source integration.

## 2026-08-05 — Durable repository-write identity became stricter

The Convex repository-write store keeps its caller, service secret, workspace, and authenticated argument builder behind runtime-private fields and methods.

Stored repository-write receipts also require one exact project-scoped owner for each external receipt ID. Standalone lookup identifiers use the same privacy admission as stored receipts and fail before Convex activity when malformed or credential-shaped.

These changes reduce credential exposure and prevent a duplicate or substituted external identity from being mistaken for the intended durable write.

## 2026-08-05 — CI gained a safe home for intentionally red controls

The repository has a draft-only, non-authorizing red-control CI profile. It records exact head, base, merge base, parent, and changed-path evidence while explicitly granting neither merge nor mutation authority.

Editing a pull-request description triggers replacement validation. This keeps exact-head evidence aligned when a repair or handoff description changes after the branch was created.

A red-control run is evidence about a defect. It never authorizes integration.

## 2026-08-05 — Provider response handling converged around bounded settlement

The issue-write response stack has reviewed shared machinery for total response deadlines, route-specific byte ceilings, hostile metadata/result admission, immediate chunk detachment, incremental fatal UTF-8 decoding, retained provider request identity, and call-local settlement.

Review of the native repository-write reuse of this design exposed the foreign-thenable cancellation escape described above. That distinction matters: a response reader can satisfy byte and time limits while still allowing untrusted cleanup code to run after the deadline. The native stack stays private until the cancellation boundary and post-effect settlement are both explicit.

## 2026-08-04 — Observation proofs received bounded privacy review

The observation Merkle packet is designed to prove exact leaf inclusion and append-only prefix consistency for one admitted ledger view.

Its public wrapper snapshots fixed inputs, rejects retained public GitHub route identities during proof creation and verification, bounds evidence arrays, and prevents production source from importing the private proof engine directly.

The proof says nothing about provider truth, webhook completeness, authorization, settlement, signing, persistence, or deployment eligibility. Its current integration candidate still needs current-main execution evidence before landing.

## 2026-08-04 — Outbound GitHub references received complete URL-focused review

The outbound preflight detects external issue, pull request, discussion, and commit references in canonical URLs and shorthand. Later repairs added WHATWG normalization coverage, one-pass policy/text snapshots, bounded controlled-repository arrays, and a private-base import guard.

A current-main typed create decorator also has reviewed source that preflights exact normalized title/body bytes, detaches optional labels and assignees, and fails before provider activity for hostile inputs. These admission layers grant no authority or contact GitHub by themselves.

## 2026-08-04 — Formal cancellation settlement landed

The cancellation-settlement TLA+ model and reachability witnesses are merged. The model checks retained retry capacity, safe and unsafe schedules, and active cancelled-caller rejoin behavior.

The formal result constrains the settlement design. It does not deploy or execute provider cancellation.

## 2026-08-03 — GitHub became the independent project and recovery record

The W01 reliability campaign established GitHub as the source of truth for source, issues, reviews, CI receipts, blockers, recovery branches, and handoffs during Stensibly degradation.

The repository added guarded GitHub reads, durable issue-write receipts, accepted project-context storage, exact CI evidence, long review-thread handling, backlink-safe outbound preflight, and the guarded OpenAI Agents adapter.

## What remains unproved

Repository progress is substantial, but W01 is incomplete until fresh authenticated sessions repeatedly prove:

- the exact deployed Worker/MCP revision and refreshed ChatGPT app;
- one hosted project-context read used in a sustained journey;
- one hosted idempotent GitHub write with durable receipt lookup and exact replay without duplicate provider mutation;
- authenticated hosted job-step/log reads if their default-on rollout is approved;
- disconnect/reconnect recovery;
- the complete create/claim/event/artifact/read/complete/reread lifecycle across several calls;
- GitHub availability throughout Stensibly degradation.

A merged PR, green CI run, dashboard sign-in, or one successful provider call is evidence, not completion.
