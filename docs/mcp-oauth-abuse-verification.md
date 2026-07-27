# Guarded OAuth abuse verification

## Purpose

Use `verify:oauth-abuse` to collect bounded deployed evidence for the dynamic-client
registration and authorization rejection paths before production OAuth enablement.

The harness is intentionally restricted to non-production endpoints. It refuses the
canonical API origin and known production Worker fallback, including DNS-equivalent
uppercase, default-port, and trailing-dot spellings. It uses no credentials and runs
as a dry plan until the operator supplies `--execute-non-production`.

## Safety boundary

The command:

- requires an HTTPS origin without credentials, path, query, or fragment;
- policy-normalises the hostname and effective port before refusing known production
  endpoints;
- sends at most 50 requests with at most 10 in flight;
- requires at least 11 requests for a registration burst so a fresh 10-per-minute
  limiter window can produce both acceptance and rejection evidence;
- applies one timeout of 100-30000 milliseconds per request, including bounded body
  classification;
- uses manual redirect handling and checks the final response origin when available;
- does not accept tokens, cookies, sessions, client IDs, consent payloads, or other
  credentials as input;
- never prints response bodies, `WWW-Authenticate`, `Location`, submitted redirect
  values, client IDs, or arbitrary upstream errors;
- physically reads at most 2 KiB only for the fixed OAuth `error` classification on
  expected `400` and `429` responses, then discards it;
- retains only the non-secret run tag, status counts, bounded `Retry-After`, validated
  request IDs, fixed OAuth error classes, content-type validity, and fixed transport or
  evidence classifications.

Registration mode creates real dynamic-client rows in the selected non-production
environment. Use a disposable guarded deployment or workspace and record the exact
revision and run tag before execution.

## Run correlation

Every plan and executed result includes a bounded non-secret run tag. Supply one for
repeatable evidence:

```bash
--run-tag w01-abuse-20260727-a
```

When omitted, the command generates a safe 12-character tag and prints it in the dry
plan before any request is sent. Registration client names and invalid-authorization
`state` values include the tag, while client IDs and full submitted metadata remain
excluded from output. Use the tag to inspect the exact staging cohort, assign cleanup
ownership, and confirm expiry or reconciliation evidence.

## Dry run

```bash
bun run verify:oauth-abuse -- \
  --endpoint https://oauth-staging.example \
  --mode registration-burst \
  --run-tag w01-abuse-20260727-a
```

The dry run prints the endpoint, issuer, mode, run tag, request count, and concurrency
without sending requests.

## Registration burst

Run after the selected rate-limit window has been quiet long enough for a legitimate
request to pass:

```bash
bun run verify:oauth-abuse -- \
  --endpoint https://oauth-staging.example \
  --mode registration-burst \
  --run-tag w01-abuse-20260727-a \
  --requests 12 \
  --concurrency 4 \
  --execute-non-production
```

The evidence passes only when:

- at least one registration returns `201` with JSON content type and a validated
  Stensibly request ID;
- at least one request returns `429` with JSON OAuth error
  `temporarily_unavailable`;
- every accepted rate-limit response has `Retry-After: 60` and a validated request ID;
- no redirect, origin mismatch, timeout, transport failure, malformed evidence, or
  other status occurs.

A generic proxy or WAF `201`/`429` pair is insufficient. Fixed OAuth classification,
content type, retry guidance, and request identity must agree with the deployed
Stensibly route.

Each request uses fixed valid public-client metadata and the product callback origin.
Successful registration response bodies are cancelled without being read. Rate-limit
bodies are read only to the 2 KiB cap, reduced to the fixed OAuth error class, and
discarded.

## Invalid-client authorization load

This mode performs syntactically valid authorization requests using a fixed
nonexistent client. It does not log in, use a session, show consent, or follow a
redirect.

```bash
bun run verify:oauth-abuse -- \
  --endpoint https://oauth-staging.example \
  --issuer https://oauth-staging.example \
  --mode authorization-invalid \
  --run-tag w01-auth-invalid-20260727-a \
  --requests 20 \
  --concurrency 5 \
  --execute-non-production
```

The evidence passes only when every request returns:

- local HTTP `400`;
- JSON OAuth error `invalid_request`;
- a validated Stensibly request ID;
- no `Location`, redirect, origin mismatch, or transport/evidence failure.

A generic HTML or proxy `400` does not satisfy the contract. The response body is
bounded, classified, discarded, and never copied into retained output.

When testing a Worker fallback that advertises a different canonical issuer, pass
that issuer explicitly. The endpoint remains the origin receiving the requests.

## Evidence record

Retain:

- exact repository, Convex, and Worker revisions;
- endpoint and issuer;
- mode, run tag, request count, concurrency, and timeout;
- UTC observation time;
- formatted status and fixed classification counts;
- bounded request IDs and bounded retry guidance;
- the selected non-production environment and cleanup owner;
- the run-tag-based client cohort and expected cleanup or expiry observation.

Do not retain submitted request bodies or upstream response bodies. Registration
rows created by the burst remain subject to the fixed unused-client lifetime and
bounded cleanup policy; inspect the environment after the run to confirm the
expected lifecycle behaviour for the exact retained tag.

## Relationship to production rollout

This harness supplies guarded non-production abuse evidence for #220. It does not
replace:

- the public disabled/enabled hosted verifier;
- inspection of quarantined malformed lifecycle rows;
- exact deployment and rollback evidence;
- the real ChatGPT registration, login, consent, read, approved write, refresh, and
  reconnect journey;
- the contemporaneous approval required for production OAuth enablement.
