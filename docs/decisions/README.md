# Durable decision records

Use this directory for choices whose rationale or consequences must outlive the
immediate pull request.

## Identity

Every decision record must have an owning GitHub issue. Name the file:

```text
<issue-number>-<short-lowercase-slug>.md
```

Examples:

```text
666-documentation-brief.md
591-github-observation-content-boundary.md
```

The issue number is the stable coordination identity. The slug provides searchability
and permits several distinct decisions under one programme issue without allocating a
shared sequential number.

Do not create “the next ADR number.” Before creating a record, search this directory
and the owning issue for an equivalent decision.

## Concurrency and conflicts

Two workers may propose related records on separate branches. Reconcile them before
integration:

1. retain one canonical filename and owning issue;
2. merge useful context, alternatives, and consequences;
3. mark a declined proposal rejected or superseded in its issue or Git history;
4. link superseding records in both directions;
5. never rewrite an accepted historical record to make the earlier context disappear.

The directory listing and issue-number search are the bounded catalogue. This README
does not duplicate every record's current status; each decision file owns its status,
implementation links, and supersession links.

## Lifecycle

Supported statuses are:

- `proposed`;
- `experimenting`;
- `accepted`;
- `rejected`;
- `superseded`.

Use `_template.md` as a starting point. Keep records concise, link to exact evidence,
and update status only when a real decision or supersession occurs.
