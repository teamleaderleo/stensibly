---
title: Portable learning garden working model
date: 2026-08-10
status: exploratory
project: scrapbook
kind: product-note
author: Lattice
---

# Portable learning garden working model

## In simple words

Scrapbook should become a pleasant place to recover useful thoughts, follow
connections, and begin a new conversation or practical exercise. It is not a
codebase browser, a daily diary, a task dashboard, or a database wearing a
paper texture.

Code investigations are one strong source. Other sources can include design,
research, conversations, interviews, books and papers, tools, visual references,
history, games, systems, cultural observations, explanations, decisions,
unfinished questions, and small practical techniques. The admission test is not
the subject. It is whether the material changes understanding or would be worth
recovering later.

The product should ask:

> What is the smallest reminder that restores the useful model, and how can the
> reader go deeper without losing the route back?

## Three systems with different jobs

The clean boundary is:

```text
Git versions durable knowledge artifacts.
Stensibly governs the work around those artifacts.
Scrapbook presents the useful human surface.
```

Git should retain reviewable Markdown, exact revisions, diffs, authorship, and
recovery. Stensibly should retain responsibility, proposals, evidence references,
status, next actions, and publication or maintenance workflows. Scrapbook should
render dense, fast, inviting pages for reading, searching, wandering, practising,
and sharing.

This extends the existing Stensibly boundary in
[`collaboration-state-and-git.md`](../collaboration-state-and-git.md): Stensibly
must not become a second source-control or content-management system. It can
coordinate a content change while Git remains independently usable when the
ledger, website, or an agent integration is unavailable.

## What earns a durable note

Do not record routine activity merely because it happened. Promote material
when at least one of these is present:

- a reusable model, mechanism, or distinction;
- a decision and the reason it survived alternatives;
- a concrete example, implementation path, or technique;
- a footgun, failure mode, negative result, or discriminator;
- an unresolved question with a real next observation;
- a connection that makes two existing ideas more useful;
- a compact explanation that is easier to recover than its source;
- a source, image, passage, or artifact likely to start useful work again.

Daily-life material is not forbidden. It simply has no special claim to
durability. “I ate eggs” is noise unless the surrounding observation carries a
model or consequence worth keeping.

## The note has three depths

Every subject should support progressive disclosure without requiring three
separate documents.

### Spark

One or two lines that restore the thought. This is the default feed and search
result. It must be authored or deliberately accepted, not regenerated on every
view.

### Working note

The useful explanation: why it matters, a golden path, a concrete example, the
main footgun, and one question or action.

### Deep record

Sources, exact revisions, longer reasoning, experiments, alternatives, selected
Q&A, revision history, open questions, and related material.

For example:

```text
Spark
  Host APIs can fail before I/O when application code accidentally changes the
  function receiver.

Working note
  Wrap ambient capabilities in application-owned closures. Test the production
  adapter and call expression, not only the destination and arguments.

Deep record
  Exact Stensibly incident, source diff, failed hypotheses, runtime evidence,
  tests, postmortem, and the later reusable rule.
```

## Relations need sentences

A useful graph is not a collection of automatic backlinks. Begin with a small
typed vocabulary:

- explains or is an example of;
- builds on or is prerequisite for;
- supports or contradicts;
- is a failure mode of;
- supplies a golden path for;
- was discovered in;
- caused this question;
- supersedes an older framing;
- is worth comparing with.

Each important edge should include a short explanation of why the relation
exists. A local neighbourhood of understandable links is more useful than an
impressive global hairball.

## Navigation should preserve thought, not only URLs

Browser history is the minimum recovery mechanism. Scrapbook can retain a
conceptual trail containing:

- origin and destination;
- relation followed;
- active search or lens;
- scroll position and expanded note;
- parked side branches;
- a human-readable return target.

Back, up, and return-to-branch are different operations. The interface should
make all three available. A dense natural-scrolling index should replace forced
scroll snapping. On a phone, a compact recent-trail drawer and mnemonic jump
field can make common destinations nearly instant.

Aliases can borrow the speed of old Reddit without reproducing its URLs:

```text
mcp
t/design
f/authority
i/code-review
? stale closure
```

## Git is the published chronicle

A candidate repository shape is deliberately modest:

```text
garden/
  notes/
  trails/
  sources.yml
```

Markdown is the canonical published artifact. Front matter carries stable IDs,
the Spark, status, source references, and typed relations. The body carries the
working note and deep record.

Commits and pull requests provide the real revision chronicle. The website can
derive a readable conceptual change feed such as:

> Revised “host capability receivers” to distinguish a healthy network probe
> from execution through the real production adapter.

This is more useful than manually writing a daily journal about continued work.

## The database is a projection and private workbench

A database remains useful for state Git handles poorly:

- private raw transcripts and intake;
- draft extraction and generation jobs;
- unpublished proposals;
- reading position, feedback, and saved trails;
- lightweight personal ranking signals;
- authenticated editing and review state.

Published notes, relations, sources, and revision history should remain
recoverable from Git. The site can compile static pages, chunked feed manifests,
full-text indexes, relation indexes, public Markdown, and MCP resources from that
corpus. Losing the database must not erase the public body of knowledge.

## Agents should propose small diffs

The low-friction conversation path is:

```text
chat, link, document, image, repository, or transcript
  -> private intake
  -> candidate Sparks, findings, examples, questions, and relations
  -> search existing notes for overlap or contradiction
  -> one reviewable Markdown proposal
  -> ordinary Git revision
  -> rebuilt Scrapbook projection
```

Raw transcripts should remain private by default. The public artifact is the
edited thought that survived the exchange. A useful Q&A may become a selected
FAQ block, counterexample, clarification, or new question without publishing the
entire conversation.

Stensibly can make “go organise Scrapbook” a bounded operation by exposing a
maintenance queue:

- untriaged private intake;
- duplicate or contradictory Sparks;
- notes whose evidence moved;
- open questions with new source material;
- broken or weak relations;
- long notes without a usable reminder;
- orphan notes with no route in or out;
- proposed revisions awaiting a publication decision.

The ledger should reference the branch, candidate revision, source evidence, and
next action. It should not copy the full note or transcript into coordination
state.

## MCP should be an enhancement, not a dependency

The same knowledge should remain usable through progressively richer surfaces:

1. pleasant public Scrapbook pages;
2. raw GitHub Markdown and stable source links;
3. ordinary Git clone and text search;
4. structured remote MCP search, traversal, briefs, and proposals.

The MCP server should use the `2026-07-28` stateless protocol while retaining a
compatible legacy lane until important clients are verified. Read operations can
include:

- `search_notes`;
- `get_note`;
- `get_topic`;
- `follow_relations`;
- `get_recent_changes`;
- `get_open_questions`;
- `build_brief`.

Authenticated write-capable operations should initially create proposals rather
than silently publish:

- `ingest_transcript`;
- `propose_note`;
- `propose_note_update`;
- `propose_relation`;
- `propose_retirement`.

Search should return Sparks first and fetch deeper content only when needed. Tool
results should include stable public URLs and exact source identities. Models do
not need the entire archive merely to answer one bounded question.

## Scrapbook is more than its supply lines

Fieldwork, Linux Fieldwork, Stensibly, and other repositories can supply strong
material, but none defines the product. The garden can also hold:

- a design motif and why it works;
- an explanation refined across several chats;
- a historical analogy that changes a systems decision;
- a paper distilled into one model and one caveat;
- a visual reference with an interaction idea;
- a practical checklist discovered through failure;
- a game mechanic worth borrowing;
- an interview question connected to real work;
- an unfinished thought whose next question is genuinely interesting.

The common contract is recoverable value, not technical subject matter.

## First bounded experiment

Do not begin with a broad schema migration or hundreds of generated cards.

1. Establish a tiny Git-backed note format in Scrapbook.
2. Hand-author five varied notes: code, design, research, conversation, and one
   non-technical subject.
3. Render a dense natural-scroll index with Spark-first expansion.
4. Preserve exact return position and one parked branch.
5. Add public Markdown and deterministic local search.
6. Have an agent ingest one conversation into a reviewable proposal.
7. Observe whether any of the notes are voluntarily reopened.

Only then decide which relations, database records, generation jobs, or MCP
write tools have earned a permanent contract.

## Open questions

- Should the public Git corpus live inside Scrapbook or in a smaller dedicated
  repository consumed by it?
- Which private intake surface is easiest from a phone without turning capture
  into a chore?
- Should a Spark be immutable history, or simply the current accepted reminder?
- Which relations deserve manual sentences and which can remain inferred hints?
- How much trail state should sync across devices rather than remain local?
- Can Stensibly compose transcript intake through Git publication without
  retaining private content in its operation aggregate?
- Which first five notes span enough subject matter to test whether the product
  is genuinely broader than software learning?

## Current disposition

Retain this as an exploratory working model. It records a direction and testable
first slice; it does not approve a storage schema, publication policy, retention
policy, MCP write surface, or automated generation system.

— Lattice
