# Bounded human and agent work-stack projection

**Owner:** #764  
**Status:** pure read-only contract  
**Version:** `work-stack-projection/v1`

## Purpose

A project can contain hundreds of relevant records without making every record body part of the current human screen or agent context window.

This contract separates five readings of the same admitted snapshot:

1. **Hot shelf** — active work and concrete attention, bounded to at most 20 rows.
2. **Review queue** — up to 50 completed or handed-off records that became actionable, ordered oldest-actionable first.
3. **Warm summaries** — at most 50 short records with an explicit inclusion reason.
4. **Cold index** — at most 500 metadata-only records with explicit truncation.
5. **Focused detail** — one exact record only after explicit selection.

The compiler performs no provider read, persistence, mutation, assignment, claim, approval, retry, merge, or dispatch.

## Ordering

One recency sort cannot represent both ongoing work and the operator's review queue.

- Hot work orders by closed attention class, oldest unmet action, stalest or absent evidence, blocked fan-out, priority, and stable identity.
- Every attention record carries `actionableAt`; an untimed attention claim fails admission.
- Review work orders by `actionableAt` ascending. Newer completions cannot starve an older unreviewed result.
- Warm summaries order by an explicit inclusion reason: hot context, review context, blocked context, priority-ready work, knowledge, recent completion, then other recent change.
- The cold index places hot identities first, review identities second, other non-archived records by recent update, and archived records last.
- All ties use literal UTF-16 code-unit comparison rather than locale-dependent collation.

## Information budget

The cold index excludes summary text, next actions, and full link objects. It contains identity, title, kind, state, priority, timestamps, owner, link count, and whether a source link exists.

Warm summaries retain bounded summary and next-action text because they are the context-bearing set. Every warm row says why it was selected.

Focused detail retains the complete admitted record and its bounded direct links. It exists only when `selectedId` names an admitted record.

Every response reports available and returned counts, truncation per tier, limits, ordering policy, and a record/link-order-independent snapshot fingerprint. The pure compiler deliberately emits no cursor: pagination belongs to the later ledger adapter, which can bind provider coverage and a real continuation to this snapshot.

The complete canonical JSON response must fit within `WORK_STACK_LIMITS.maxProjectionBytes` (1 MiB). Oversized output fails explicitly rather than silently dropping rows or links.

## Link-back boundary

Links use a closed kind vocabulary covering Stensibly items, runs, requests, receipts, GitHub records, artifacts, deployments, provider observations, parents, dependencies, handoffs, and supersession.

Each link carries one globally unique durable identity within its record, a label, and either a credential-free HTTPS URL without user information or a single-slash root-relative path. Link input order is canonicalized before snapshot identity and output. Protocol-relative, backslash-bearing, malformed, userinfo-bearing, duplicate, and conflicting links fail admission.

Kind-specific provider identity verification remains the later adapter's job; this compiler does not claim that an arbitrary admitted URL proves a provider record.

## Admission

The input is exact own enumerable data:

- ordinary undecorated dense arrays;
- plain objects with exact field sets;
- exact lowercase project identity;
- bounded strings, identities, priorities, fan-out, and link counts;
- canonical UTC timestamps inside one observed snapshot;
- unique record and link identities;
- an actionable review always has `actionableAt`;
- an attention row always has `actionableAt` and one safe next action;
- selected detail must exist in the admitted snapshot.

Accessors, symbols, hidden or surplus fields, custom array decoration, sparse arrays, future timestamps, project aliases, duplicate identities, unsupported links, bidi/control text, and realistic credential-shaped text fail closed without getter invocation. Ordinary identifiers such as `item-sk-research` remain valid.

## Authority

Every projection returns:

```text
authorizesOperation: false
authorizesMutation: false
```

Ordering, visibility, selection, and inclusion never grant responsibility, authority, approval, retry, merge, deployment, provider access, or mutation rights.

## Next integration

After this pure contract is accepted, a separate read adapter may translate canonical ledger state into the input and expose a bounded REST/MCP attention endpoint. That adapter must preserve partial-history and source-availability facts, verify provider-specific link identities, and own any real pagination rather than claiming this compiler queried 500 complete records itself.

Work Pulse and the production dashboard may render the same projection. The human root keeps configuration and write identity behind deliberate entry; agent consumers receive hot plus warm context and may request a bounded index or one focused detail explicitly.

## Recovery

Revert the contract commit or leave it unused. It owns no storage, public tool registration, route, provider call, or product effect.
