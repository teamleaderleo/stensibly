# Stensibly development log

**Status:** active narrative companion  
**Audience:** operator, fresh workers, and future maintainers  
**Operational source of truth:** [`docs/current-wave.md`](current-wave.md), GitHub issues and pull requests, exact CI receipts, and deployment/provider evidence

## Purpose

This log explains what Stensibly work has meant at meaningful product boundaries.
It is intentionally different from the current-wave record:

- `docs/current-wave.md` owns the live campaign state, priorities, exact gates, and next actions;
- this log explains the larger result, why the work mattered, what reached `main`, what remains experimental, and what changed in our understanding;
- pull requests, tests, CI, deployments, and provider receipts remain the exact evidence.

Add an entry after a meaningful merge batch, deployment or dogfood result, major repair,
or material change of direction. Do not add one entry for every repair child, CI wake-up,
review control, or temporary publication carrier.

---

## 2026-08-03 — GitHub reliability and the first guarded agent runner

### In simple words

The recent work has mostly been product infrastructure rather than visible dashboard
features. We have been turning Stensibly into a safer system for agents to work with
GitHub over long-running sessions:

- read exact repository, pull-request, review, status, and Actions evidence;
- perform narrowly typed GitHub issue writes;
- retain durable receipts so an ambiguous write can be reconciled instead of repeated;
- preserve the exact GitHub context and repository instructions associated with a
  project and issue;
- run an agent through resumable checkpoints and cancellation without confusing one
  profile, holder, or generation for another;
- prove which exact revision was tested;
- stop accidental external references, backlinks, credential retention, and unbounded
  provider data before they become effects.

Current repository `main` at this entry is
`854b528bdb8380071244dfba799ff91d5d1403e0`.

### What reached `main`

#### 1. A guarded GitHub read surface

Stensibly can now compose bounded GitHub reads for repository metadata, immutable files,
pull-request metadata and diffs, review threads, combined commit status, Actions runs,
Actions jobs, job steps, and bounded text logs.

The important part is not just the number of reads. The adapters bind results to the
accepted repository, pull request, commit, run, or job; use narrow GitHub App
permissions; preserve provider request identity; avoid forwarding installation
credentials to log-download hosts; and minimize retained provider content.

Relevant integrations include #899, #910, #911, #913, #920, and #931.

#### 2. Governed GitHub issue create, update, and comment actions

The first end-to-end Stensibly-to-GitHub write path is in the repository:

- #934 persists provider reservations and receipts in hosted Convex;
- #937 mounts private hosted create, update, and comment execution;
- #938 exposes typed public actions for issue creation, issue update, issue comment, and
  receipt lookup.

Each write is project- and repository-scoped, derives actor and client identity from
the authenticated principal, requires an explicit idempotency key, and records an
outcome that can survive reconnect. Ambiguous transport or verification outcomes remain
pending reconciliation; exact replay must not blindly dispatch the mutation again.

This is the main practical answer to “what have the agents been building?”: a GitHub
write path that treats uncertainty and duplicate prevention as first-class product
behavior rather than an error-message afterthought.

#### 3. Durable accepted GitHub context

Stensibly now persists deliberately accepted, content-minimized GitHub issue context in
hosted Convex (#908), exposes a project-scoped read through the public MCP surface
(#933), and has a private reader for the exact accepted issue snapshot and repository
instruction binding (#967).

This establishes the foundation for a write result to flow back into project context
without silently borrowing another issue's instructions or trusting a stale row.

#### 4. A model-free OpenAI Agents runner adapter

#945 added the first guarded runner adapter built on the pinned
`@openai/agents-core@0.14.1` package.

It supports resumable external checkpoints and adds explicit controls around:

- fresh versus replayed checkpoint chronology;
- holder, profile, run, lease, and generation identity;
- cancellation and checkpoint authority;
- stale-holder rejection before local checkpoint disclosure;
- recovery of an admitted resume checkpoint;
- exact control text and credential-shaped identity rejection;
- JavaScript negative-zero aliases that would otherwise collapse into generation zero.

This is substantial runner infrastructure. It does not, by itself, mean a live model run
or production checkpoint was executed during this work.

#### 5. Exact CI and workflow observation evidence

#940 made the canonical CI topology callable for one exact source revision and added a
machine-readable terminal receipt. #953 added a separate observation receipt that can
say whether an exact workflow run was observed, not observed at a trusted lookup time,
or still unknown without inventing runner allocation state.

These changes exist because a branch write, queued check, and executed validation are
not the same fact. The repository now has stronger vocabulary and evidence for telling
them apart.

#### 6. Review-thread reads that remain useful on long discussions

#944 changed long pull-request review threads from an all-or-nothing failure into bounded
evidence: retain the admitted first page and publish the provider total plus an explicit
truncation flag. #981 then repaired an overly strict pagination assumption so a valid
short nonterminal GraphQL page remains readable.

The resulting behavior is deliberately honest: return useful bounded comments, state
that more exist, and reject contradictory pagination evidence.

#### 7. Outbound GitHub reference preflight

#971 added a pure pre-dispatch scanner for exact outbound GitHub text. It detects direct
external GitHub issue, pull-request, discussion, and commit references, plus shorthand
and closing-keyword forms, before a provider call can create an unintended backlink,
notification, or external interaction.

The scanner grants no authority. It returns a bounded decision and content-minimized
findings. Follow-up work is still tightening Unicode, encoded-path, and byte-exact
boundary behavior.

### Work that supported these outcomes but was not a separate feature

The activity stream contains many more pull requests than the feature list above.
Several classes of PR were deliberately temporary or diagnostic:

- **red controls:** tests that demonstrate a suspected defect before the parent is
  repaired;
- **repair children:** narrow fixes stacked on a larger parent candidate;
- **publication carriers:** temporary branches or workflows used to recover exact source
  bytes when normal publication was blocked;
- **current-main replays:** clean one-commit versions of reviewed work after `main` moved;
- **duplicate convergence lanes:** competing implementations closed after one path became
  canonical;
- **CI wake-ups and metadata corrections:** work needed to get an exact head observed and
  reviewed, not new product capability.

Those records are useful evidence, but counting them as independent features makes the
work look far more chaotic and feature-heavy than it was.

### What is still in progress

#### Typed label and assignee writes

#968, #972, and #970 are extending the governed issue-write system to add/remove labels
and assignees. The private parent still needs to be reduced to a workflow-free source
packet before the public 41-tool stack can settle.

The response boundary is being consolidated across #976 and #977. Executable controls
#995 and #996 require immediate stream-chunk detachment, disposal of bodies rejected by
declared-length admission, a closed work count that includes zero-byte chunks, and
best-effort cancellation that cannot itself hang the post-effect path. The final shared
reader also needs a coherent compressed-response contract, configured GitHub API-host
binding, and exact provider-URL admission.

This lane is not integrated yet.

#### Write-result to accepted-context reconciliation

#961 contains the draft reconciliation proposal and instruction-observation request
compilers; #979 was merged into that stacked parent rather than current `main`. #975
composes a proposal with the private instruction binding.

The earlier operation-target and already-current defects are repaired on the current
#961 head. The active repair chain is now privacy and chronology:

- #997 aligns #983's bearer and Slack thresholds to the repository-standard 12/16
  boundary;
- #998 requires #961 to re-screen every retained proposal identity and workspace with
  realistic anywhere-in-text credential admission;
- #999 requires #975 to reject create proposals with a prior accepted revision and
  actionable proposals whose current revision already equals provider readback before
  the composer touches a binding or takes its fallback path.

The parent order matters: finish the receipt privacy policy, apply it to reconciliation,
then repair and restack context acceptance.

#### Privacy and outbound-reference boundary repairs

#983 tightens credential-family rejection in retained provider receipt text but still
needs #997's exact threshold repair. #987 consolidates Unicode, punctuation,
long-reference, line-ending, surrogate, and hidden-identity repairs for outbound
preflight, but an immediate percent escape can still continue a decoded GitHub path
while the scanner emits a truncated issue number or commit alias.

Both remain draft at this entry.

#### Observation integrity and formal concurrency exploration

#1000 replaces the old-base Merkle exploration with one exact current-main replay. The
packet proves only that one content-minimized observation identity was included in one
named checkpoint and that a later checkpoint preserves an earlier prefix. It does not
prove provider truth, completeness, chronology honesty, authority, signing,
persistence, or deployment.

#1003 currently blocks that replay because checkpoint and proof identities can retain
canonical external GitHub references and delimiter-embedded realistic credential
families. The final identity policy must reject those public reference forms while
preserving internal ledger/compiler/delivery namespaces.

#960 models cancellation settlement and generation fencing in TLA+. It remains a proof
transition and still needs a pinned attributable TLC run, safe-state completion, and the
expected unsafe counterexample before it can be treated as evidence.

### What is not yet proven live

Repository integration and live dogfood proof are separate milestones.

At this entry, the repository contains the capabilities above, but the exact Cloudflare
Worker revision, enabled feature flags, refreshed public tool declaration, and complete
authenticated production journey have not all been independently verified. The Vercel
dashboard deployment is not evidence that the separately deployed Worker/MCP surface is
current.

W01 still needs a fresh authenticated ChatGPT journey that proves sustained discovery,
reads, writes, durable receipt lookup, reconnect, exact replay without duplicate GitHub
mutation, accepted-context use, and continued GitHub availability throughout the
session.

The Stensibly MCP was deliberately not used for the repository work summarized here.
GitHub remained the independent coordination and recovery record.

### What we learned

1. **Merged code, deployed code, and authenticated product proof are three different
   facts.** The repository should state each one separately.
2. **Ambiguous writes need durable identities, not automatic retries.** A timeout can
   happen after GitHub accepted an effect.
3. **Provider-owned identity must survive every projection.** Repository, issue, commit,
   run, job, request, actor, client, and accepted instruction generation cannot be
   inferred from nearby context.
4. **Useful bounded evidence is better than all-or-nothing reads.** Long review threads
   should remain readable while clearly reporting truncation.
5. **Untrusted JavaScript objects are part of the input boundary.** Descriptor snapshots,
   getter avoidance, immutable copies, numeric alias rejection, byte ceilings, chunk
   counts, and non-blocking cleanup are recurring defenses because injected adapters and
   tests can otherwise change values or hold work open after validation.
6. **Proof identity is also a disclosure boundary.** A hash or Merkle proof can be
   mathematically valid while still republishing an external reference or credential-
   shaped identity that should never have entered the public proof object.
7. **The operator needs a narrative record.** Exact PR descriptions and `current-wave`
   bookkeeping are strong for execution, but they do not answer “what did we actually
   build?” without a synthesis layer.

### Next meaningful outcomes

- prove the actual Worker/MCP deployment and run the full authenticated W01 lifecycle;
- finish and integrate the label/assignee write stack with one shared bounded response
  reader and without weakening durable reconciliation;
- finish the provider-receipt-to-context path in the order #983 → #961 → #975;
- close the focused outbound percent-encoding and Merkle retained-identity privacy
  boundaries on exact current-main packets;
- keep this log updated at meaningful product, deployment, and dogfood boundaries rather
  than after every micro-PR.

— Lumen and Loom · W01 development synthesis  
  Intention: make the product progress understandable without weakening the exact operational record
