# Service activity aggregate contract

This document defines the first bounded data contract for Stensibly service-activity
observations and aggregates. It supports issue #541 without making raw Worker logs,
request identifiers, browser details, credentials, or item content part of durable
product state.

The implementation lives in `src/service-activity-contract.ts`. This slice is pure
contract code. It does not ingest production traffic, persist aggregates, expose an
API or MCP tool, render a dashboard card, or define retention jobs.

## Purpose

The contract should let the operator answer bounded questions such as:

- how many requests reached REST, MCP, authentication, health, or another route class;
- which requests were reads, writes, discovery, verification, or unknown operations;
- how much traffic was interactive, background refresh, verification, reconciliation,
  automation, or unknown intent;
- how success, failure, status bands, and bounded failure categories changed over time;
- which closed client and authentication classes were observed;
- which Worker, release, and MCP-manifest identities served the traffic;
- whether latency fell within a small fixed histogram and approximate p50/p95 bounds.

It must not become a general request log, analytics event bus, or replay store.

## Observation fields

One normalized observation contains only:

- workspace slug resolved inside Stensibly;
- ISO observation time;
- route class;
- operation class;
- client class;
- authentication mode;
- request intent;
- outcome and HTTP status;
- bounded duration;
- bounded failure category for failures;
- optional Worker version, release ID, and manifest digest.

Every categorical field uses a closed server vocabulary. When attribution cannot be
proved, the producer records `unknown`. It must not derive a new dimension from a raw
user agent, IP address, caller-supplied label, URL, route parameter, item title, prompt,
or request body.

The parser returns a new whitelisted observation object. Extra input keys are not
copied into the normalized result.

## Aggregate identity

Buckets align to UTC minute, hour, or day boundaries. Their dimension key contains:

- workspace;
- route class;
- operation class;
- client class;
- authentication mode;
- optional Worker version;
- optional release ID;
- optional MCP manifest digest.

Request intent, outcome, status, failure category, and latency are counters within the
bucket rather than dimensions. This keeps the number of bucket identities bounded and
allows one aggregate to show the mix of work inside a service slice.

Equivalent partial buckets may be merged only when the interval, time window, and full
dimension key match exactly.

## Stored measures

A bucket contains:

- request, success, and failure counts;
- status-band counts from `1xx` through `5xx`;
- counts for each request intent;
- counts for each failure category;
- duration count, sum, minimum, maximum, and fixed histogram;
- the most recent observation timestamp.

Summary helpers derive success rate, background-refresh share, and bounded p50/p95
latency estimates. A percentile in the overflow bucket is reported explicitly rather
than pretending to have a precise duration.

## Forbidden data

The observation and aggregate contracts have no fields for:

- request ID or trace ID;
- IP address or network fingerprint;
- user agent or arbitrary client name;
- authorization header, cookie, API token, OAuth token, session secret, or credential;
- full URL, path parameters, query string, redirect URI, or callback data;
- request or response body;
- prompt, conversation content, item title, summary, artifact content, or query text;
- raw provider payload, stack trace, or unrestricted error text.

Future ingestion code must build observations from server-owned classification and
already-sanitized outcomes. It must not pass a request object through and rely on this
contract as the only privacy boundary.

## Unknown and failure handling

`unknown` is an explicit bounded value, not a signal to copy an unrecognized source
value into storage. Producers use it when the server cannot establish a safe class.

HTTP status and outcome must agree. Statuses below 400 are successes; statuses from
400 through 599 are failures. A failure without a safe failure category is recorded as
`unknown`. Successful observations cannot carry a failure category.

Malformed timestamps, invalid statuses, negative or unbounded durations, arbitrary
categorical labels, unsafe diagnostic identifiers, and malformed manifest digests are
rejected before aggregation.

## Later wiring

A later #541 slice may:

1. map sanitized Worker completion records into this observation contract;
2. persist short-lived minute buckets and rolled-up hour/day buckets;
3. define explicit retention and stale-release rules;
4. expose bounded read-only summaries through REST and MCP;
5. render a portfolio-level service-activity card;
6. mark dashboard traffic as interactive or background refresh;
7. add provider-resource activity only after a separate privacy and cardinality decision.

That work should preserve this contract's closed dimensions and content-minimization
boundary. Any new field or category should arrive through a reviewed contract revision,
not an arbitrary producer label.
