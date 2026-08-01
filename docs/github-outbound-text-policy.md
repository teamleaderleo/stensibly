# Outbound GitHub interaction preflight

This contract implements the pure first slice of issue #573. It evaluates the
exact text Stensibly intends to send in a GitHub interaction before any provider
call occurs.

## Scope

The policy applies only to provider-bound interaction surfaces:

- issue title and body;
- pull-request title and body;
- comments;
- reviews and inline-review comments;
- discussion title and body;
- commit messages intentionally sent as interaction-bearing provider text.

It does not scan arbitrary tracked source, documentation, release notes, package
metadata, ordinary web links, repository homepages, or other repository-file
content. Those surfaces do not create the same issue/PR autolink, backlink,
notification, or closing-reference effects.

## Prevention boundary

The caller must assemble the exact final destination, surface, field order, and
text first. The policy fingerprint binds the exact policy. The payload
fingerprint binds the destination repository, surface, field names, and exact
field bytes, including line endings.

A draft approximation or post-write workflow is not equivalent. GitHub has
already interpreted the interaction by the time a post-write workflow runs.

## Version-one policy

A policy declares canonical controlled owners and repositories. References to
the destination, controlled owners, or controlled repositories are allowed.

The evaluator detects these third-party GitHub interaction forms:

- direct issue, pull-request, discussion, and commit URLs;
- cross-repository issue/PR shorthand;
- cross-repository commit shorthand;
- closing keywords attached to an external item reference.

Redirect wrappers such as `redirect.github.com` are not direct GitHub
interactions. Ordinary repository links and non-GitHub documentation links are
outside this contract.

Configured destination, policy, operation, and authority identities must
already use canonical spelling. Provider text references are case-normalized
only for detection and comparison; the text bytes themselves are never
rewritten.

## External-contact authority

An optional external-contact authority may allow exact external repositories.
It must bind:

- a SHA-256 authority receipt recomputed over policy
  `github-external-contact-authority/v1`, generation, and repositories;
- the same authority generation as the provider operation;
- a canonical, unique, sorted repository set.

An authority for one repository cannot permit another. A stale authority
generation fails closed. The policy result still carries:

```text
providerDispatchAuthorized: false
```

Passing preflight is only one input to the later provider authority decision.
It does not grant repository access, capability, approval, merge, deployment,
contact, or mutation authority.

## Privacy-safe diagnostics

The receipt never stores the raw title, body, review, comment, or commit
message. It stores only:

- field name;
- SHA-256 text fingerprint;
- byte and line counts;
- destination and operation identity;
- policy and authority identities;
- reference counts;
- up to 100 structured diagnostics.

A diagnostic contains the field, line, column, reference kind, separated owner
and repository, item kind, and a bounded number or shortened commit identity.
It does not reproduce a GitHub URL, cross-repository shorthand, closing
expression, unrestricted body, or provider payload.

The complete rejection count remains visible even when diagnostics are
truncated. Realistic GitHub, OpenAI, Stensibly, Slack, secret-reference, and JWT
credential families are rejected from retained identifiers while benign
identities such as `task-sk-review` remain valid.

## Exact admission

Every public input and receipt record is admitted from one own-property
descriptor snapshot. Only ordinary or null-prototype records with enumerable
data properties are accepted. Accessors, symbols, hidden fields, inherited or
custom records, and unknown fields fail without invoking getters.

Every public array is admitted from one descriptor snapshot containing an exact
ordinary-array prototype, bounded captured length, every dense enumerable data
index, and no symbols or decorated keys. Sparse, accessor-backed, custom, or
decorated arrays fail closed.

Input destinations contain exactly `owner` and `repository`. Receipt
destinations additionally require the exact derived `repositoryFullName`.
Input fields must match the exact surface field names and canonical order.
Controlled and authorized repository sets are canonical, unique, sorted, and
admitted through the same dense-array boundary.

## Receipt integrity

Receipt parsing checks:

- exact schema version;
- exact surface field names and order;
- exact reference-count arithmetic;
- exact omitted-diagnostic count;
- diagnostic fields belong to the receipt field set;
- decision consistency with rejected references;
- complete authority identity and matching authority generation;
- authorized references cannot exist without an authority identity;
- `providerDispatchAuthorized` remains false;
- receipt fingerprint matches every retained field.

## Current fence

This pure contract does not:

- call GitHub;
- inspect an existing thread;
- modify, delete, or correct provider text;
- authorize external contact;
- authorize provider dispatch;
- persist policy receipts;
- scan repository documentation;
- interpret arbitrary mentions or natural-language intent;
- replace project capability, repository binding, expected-version,
  idempotency, or reconciliation checks.

The next slice should invoke this evaluator inside one first-party GitHub
issue/comment write path after the exact final provider payload is assembled and
before the provider adapter is called.
