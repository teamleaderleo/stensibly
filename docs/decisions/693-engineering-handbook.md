# Decision: Maintain a living engineering handbook and code atlas

- **Status:** experimenting
- **Date:** 2026-07-31
- **Owning issue:** #693
- **Implementation:** first documentation slice on `rook/693-engineering-handbook`
- **Supersedes:** none
- **Superseded by:** none

## In simple words / purpose

Stensibly has strong product, correctness, operations, and worker guidance, while its
code-level conventions are scattered through source, tests, reviews, and pull-request
history. Maintain one concise engineering handbook and one current-main code atlas so a
fresh contributor can recover the house style, common traps, and exemplary code without
replaying every review.

## Context and evidence

The repository already owns several deeper truths:

- `README.md`, `STENSIBLY.md`, and `docs/product-model.md` explain the product and
  authority/responsibility distinction;
- `docs/architecture.md` explains component responsibilities and trust boundaries;
- `docs/coordination-correctness.md` explains distributed coordination, idempotency,
  fencing, time, retries, and external effects;
- `AGENTS.md` and `CONTRIBUTING.md` explain repository work, review, integration,
  deployment, and handoff;
- `docs/documentation-system.md` explains orientation, evidence, and durable decisions.

Accepted implementation and review work has also established reusable code lessons:
descriptor-safe admission, exact-byte identity before canonicalization, invocation-time
authority, zero-authority empty inventories, append-only revocation history, immutable
commit refs, bounded provider results, complete returned-scope verification, fixed
credential-confidential errors, and denied-path zero-effect tests.

Those lessons currently live in several PR descriptions, review threads, tests, and
source files. Discovery depends on knowing the exact prior lane. Repeated review findings
show that a compact active synthesis can save repair time while preserving links to the
real evidence.

## Decision

Maintain two contributor-facing pages:

1. `docs/engineering-handbook.md` owns concise current code conventions, recurring
   pitfalls, and links to deeper rationale.
2. `docs/code-atlas.md` owns annotated examples from current `main` only.

The pages use these rules:

- distinguish required invariants, repository conventions, and active experiments;
- link to source, tests, issues, PRs, and deeper documents instead of copying large
  evidence;
- include a reusable lesson, its limits, and a supersession rule for every exemplar;
- add or revise guidance when merged work establishes, changes, or disproves a recurring
  convention;
- keep #693 as the long-lived curation issue during the experiment;
- preserve history through Git and linked records while removing stale active guidance.

The handbook guides implementation and review. It does not replace source, tests,
architecture, correctness, operations, current-wave records, or exact candidate
receipts.

## Rationale

A single giant contributor document would blur product direction, operating protocol,
implementation conventions, and code examples. Two linked pages keep the primary tasks
separate:

- the handbook answers “which rules and habits apply?”;
- the atlas answers “where does current code demonstrate them well?”

Current-main-only curation prevents the gallery from recommending abandoned branch
code. Issue-backed ownership gives the convention a durable identity without inventing
sequential ADR numbering. Explicit limits reduce cargo-cult copying.

## Alternatives considered

### Alternative: Keep conventions only in review threads and PR descriptions

- **Why it was plausible:** the evidence already exists and needs no new maintenance.
- **Why it was declined:** discovery requires knowing the historical lane; repeated
  findings remain easy to miss; a fresh contributor cannot recover the house style from
  the first repository screen.
- **Revisit when:** repository search or generated indexing can produce a trustworthy,
  concise, current synthesis from accepted evidence automatically.

### Alternative: Expand `CONTRIBUTING.md` into the complete guide

- **Why it was plausible:** contributors already open that file.
- **Why it was declined:** setup, workflow, code conventions, pitfalls, and annotated
  examples would crowd one page and duplicate deeper documents.
- **Revisit when:** the handbook shrinks enough that a separate page adds more navigation
  than value.

### Alternative: Generate a code gallery from recent commits

- **Why it was plausible:** automation could keep links fresh.
- **Why it was declined:** recency and complexity do not prove exemplary design; useful
  curation requires judgment, limits, and a clear lesson.
- **Revisit when:** generation proposes candidates while a review still accepts the
  lesson and limits.

### Alternative: Treat every merged PR as a handbook update

- **Why it was plausible:** it would prevent missed lessons.
- **Why it was declined:** most changes establish no reusable convention and mandatory
  updates would create boilerplate.
- **Revisit when:** repeated missed conventions show the selective maintenance trigger is
  too weak.

## Consequences

### Benefits

- A fresh contributor gains one code-convention entry point.
- Review lessons survive branch and chat turnover.
- Exemplary code becomes discoverable with its tests and limitations.
- Repeated pitfalls can be prevented before review.
- Deeper documents retain ownership of full rationale.

### Costs and accepted imperfections

- The pages require curation after meaningful changes.
- Example selection includes judgment and may lag newly merged code.
- The first edition covers only a subset of the repository.
- Relative links identify current paths; line-level details may move.

### Risks and mitigations

- **Stale advice:** every edition names a current-main review pin; remove or update stale
  entries during material contract changes.
- **Duplicate active truth:** keep full rationale in architecture, correctness, and
  decision records; the handbook summarizes and links.
- **Cargo-cult copying:** every atlas entry states its limits.
- **Documentation ceremony:** update only for reusable lessons and recurring pitfalls.
- **Recent-code bias:** require a crisp invariant and meaningful proof, not recency.

## Validation

- **Evidence already available:** accepted source and tests for provider binding
  admission, runner authority, SQLite binding history, and delegated GitHub reads.
- **Acceptance signal:** a fresh contributor can review a representative PR, identify
  its authority/data owner, admission order, denied-path proof, recovery path, and closest
  current-main exemplar from the two pages.
- **Failure signal:** pages drift from source, duplicate deeper documents, become a
  chronological scrapbook, or add boilerplate to routine PRs.
- **Review or experiment period:** keep status `experimenting` until the handbook survives
  several real updates from unrelated implementation lanes under #693.

## Recovery and supersession

Revert the documentation commit to remove the active convention. Existing source,
tests, issues, PRs, architecture, correctness, and decisions remain authoritative.

A replacement convention should:

1. create or use an owning issue;
2. mark this record `superseded`;
3. link both records;
4. migrate useful active guidance;
5. remove the obsolete entry-point links.

## History

- 2026-07-31 — proposed and entered experimentation under #693 with the first handbook,
  four atlas entries, ten pitfalls, and contributor/documentation links.
