# Institutional memory archive

This directory preserves historical learning notes, postmortems, and audits that remain useful evidence or explanation.

It is **not an active operating protocol, recurring after-action programme, policy source, or current-state database**.

Current facts stay with their canonical owners:

- work/responsibility/authority/continuation -> Stensibly;
- issues, pull requests, checks, branches, reviews -> GitHub;
- deployments/resources -> their provider;
- repository policy -> exact Git revision and applicable instruction files;
- recurring machine-decidable failure prevention -> code/tests/contracts/defaults.

## Reading

Open a historical record only when it is relevant to the subsystem, incident class, or decision you are investigating. Do not read the directory as part of ordinary worker startup.

The index is a convenience/search aid. Historical labels, terminology, proposed procedures, and provider facts in archived records describe their own time and may have been superseded.

Before using an archived claim for current action, refresh the owning current source.

## Writing new durable learning

Prefer the smallest owner that prevents recurrence:

```text
exact bug/finding -> owning issue or PR
mechanical recurrence -> regression test / invariant / safer API
operational recipe -> current runbook/reference
consequential durable choice -> issue-backed decision record
incident whose causal analysis remains useful -> postmortem
cross-cutting research/audit whose source coverage remains useful -> bounded audit record
```

A separate learning note is optional. Create one only when the reusable explanation would otherwise be lost and does not belong more naturally in the owning issue, decision, test, or current documentation.

Routine successful work, ordinary handoffs, review summaries, status updates, and speculative process ideas do not need archive records.

## Historical integrity

Archived records are descriptive evidence. They grant zero authority, approval, responsibility, or provider capability.

Preserve the original evidence and dates. When a current document or contract supersedes an archived lesson, link the newer owner where useful; avoid rewriting the old event to look consistent with present policy.

Secrets, credentials, raw tokens, unrestricted personal data, unbounded transcripts, and unnecessary raw provider payloads remain outside retained records.

## Postmortems

Use a postmortem when a material incident or near miss needs durable causal analysis beyond the repair issue itself, for example:

- outage/data-loss risk;
- security/authority boundary failure;
- ambiguous consequential effect with substantial recovery work;
- repeated failure whose causes span several owner contracts.

The repair and current controls still belong to their current owners. The postmortem explains what happened and why.

## Audits

A durable audit record is useful when bounded source coverage and cross-cutting conclusions should survive the immediate review. Exact actionable findings should also live on the issue/PR that can repair them.

Review independence is consequence-based under current repository policy. Merely placing a Markdown file in this directory does not create independent acceptance evidence.

## Index maintenance

Updating `index.md` is optional convenience work. A stale index must never make a historical record current or hide a canonical current issue/provider fact.

If archive indexing becomes useful enough to require reliable freshness, generate the index from record metadata instead of maintaining another manual workflow.

## Promotion rule

When an archived lesson recurs, move the repeatable part into the smallest executable/current owner:

```text
historical lesson
-> current issue/decision if judgement is required
-> deterministic check / typed state / safer API / runbook when repeatable
-> archive remains evidence
```

Do not revive protocol versions, wave/pod practices, recurring surveys, review-by calendars, or worker scorecards merely because older records mention them.

— Kestrel
  Intention: keep useful history without making history another process
