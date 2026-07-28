# Postmortem: the GitHub OAuth request that never left the Worker

**Incident:** hosted GitHub OAuth callback repeatedly failed during token exchange  
**Wave:** W01 Production MCP Connection  
**Primary tracking:** #286  
**Incident window:** July 2026  
**Resolved:** 2026-07-29  
**Severity:** internal dogfood blocker  
**Customer impact:** no external customers; the operator and participating agents could not complete the hosted sign-in and ChatGPT MCP connection journey  
**Final repair:** PR #455, merge commit `3aa6a01a6a4543783bf04c1b3c26f55a7e7249fb`  
**Verified deployment:** GitHub Actions run `30393846940`

## Executive summary

The hosted GitHub OAuth callback failed with what initially looked like an outbound network problem. DNS, TLS, GitHub credentials, callback configuration, Cloudflare egress, Vercel/Cloudflare proxying, request timeouts, cache controls, redirect handling, and provider behaviour were all plausible suspects.

The final defect was much smaller and more local:

```ts
this.fetchImpl = options.fetch ?? fetch;
```

The production client later invoked that property as a method:

```ts
await this.fetchImpl(url, init);
```

In JavaScript, `object.function()` passes `object` as the function's `this` receiver. The native Cloudflare Worker `fetch` function had therefore been detached from its normal invocation context, stored on an `HttpGitHubOAuthClient`, and called with the client instance as its receiver.

The production evidence strongly indicates that the Worker runtime rejected that invocation with an `Illegal invocation`-style `TypeError` before attempting an outbound request. We deliberately did not expose raw exception messages, so the exact runtime string was not retained. The causal diagnosis is nevertheless strong:

1. Direct Worker probes calling `fetch(...)` reached GitHub successfully.
2. The production adapter calling `this.fetchImpl(...)` returned a bounded `TypeError` classification.
3. The failure was localized to the preflight operation, before OAuth state consumption or authorization-code exchange.
4. Removing request options did not change the failure.
5. Wrapping native and injected fetch functions so they were no longer invoked as client methods fixed production immediately.
6. A receiver-sensitive regression test reproduces the old call-pattern failure and passes with the repair.

The line-level bug was small. The long incident was caused by a broader systems failure: our tests and probes reproduced the request's URL, headers, body, and network destination, but did not reproduce the exact production invocation semantics.

## Impact

The defect blocked the critical W01 dogfood journey:

- hosted GitHub sign-in could begin and reach GitHub;
- GitHub could redirect the browser back to Stensibly;
- the callback reached the correct Cloudflare Worker;
- the Worker failed before it could complete the GitHub token exchange;
- no hosted session was created;
- ChatGPT could not be connected to the hosted Stensibly MCP server through the intended OAuth journey.

The failure consumed substantial debugging and coordination time over several days, although the team was not exclusively focused on it throughout that period.

No authorization code, token, credential, verifier, cookie, provider response body, exception message, or profile field was exposed through the diagnostic work.

## What users saw

The initial failure was too broad:

```json
{
  "error": "GitHub authentication failed",
  "code": "provider_failure",
  "stage": "token_exchange",
  "reason": "network_exception"
}
```

Successive bounded diagnostics eventually narrowed the failure to:

```json
{
  "error": "GitHub authentication failed",
  "code": "provider_failure",
  "stage": "token_exchange",
  "reason": "network_exception",
  "detail": "type_error",
  "operation": "preflight",
  "colo": "LAX"
}
```

Those additional fields were decisive:

- `detail: type_error` shifted the leading hypothesis from remote infrastructure to local runtime behaviour;
- `operation: preflight` proved the failure happened before code exchange and token parsing;
- `colo: LAX` confirmed the exact Worker edge handling the callback without leaking request secrets.

## Architecture at the failing boundary

The relevant path was:

1. Browser starts sign-in at `/auth/github/start`.
2. Stensibly creates signed OAuth state and a PKCE verifier.
3. Browser authorizes at GitHub.
4. GitHub redirects to `/auth/github/callback`.
5. The Cloudflare Worker validates callback state.
6. `HttpGitHubOAuthClient` makes a request to GitHub's token endpoint.
7. GitHub returns an access token.
8. Stensibly reads the GitHub identity, creates or resolves the hosted account, and creates a session.

The incident occurred at step 6, but before the outbound request was made.

## Root cause

### The unsafe abstraction

The OAuth client accepted an optional fetch dependency using the entire host-global type:

```ts
export interface HttpGitHubOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}
```

The constructor stored either the injected implementation or the ambient global directly:

```ts
this.fetchImpl = options.fetch ?? fetch;
```

The client then invoked it as an instance method:

```ts
await this.fetchImpl("https://github.com/login/oauth/access_token", init);
```

That syntax binds `this` to the client instance.

For an ordinary arrow-function test double, this does not matter. Arrow functions do not take a dynamic receiver from the call site. For a host-provided runtime function, it can matter considerably.

The application treated a host capability as though it were a freely rebindable JavaScript callback.

### The repair

PR #455 narrowed the dependency to the capability actually required:

```ts
type GitHubFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
```

It then wrapped both injected and native implementations:

```ts
const fetchImpl = options.fetch;
this.fetchImpl = fetchImpl
  ? (input, init) => fetchImpl(input, init)
  : (input, init) => globalThis.fetch(input, init);
```

The class still calls `this.fetchImpl(...)`, but that property now contains an application-owned arrow function. The arrow ignores method-call receiver rebinding. The native Worker function is invoked explicitly as `globalThis.fetch(...)` inside the wrapper.

### Why `typeof fetch` was the wrong dependency type

The first repair attempt retained `typeof fetch` for the wrapped function. TypeScript rejected it under Bun because Bun's global fetch type included a `preconnect` property that a plain wrapper did not implement.

That compiler error exposed a design mistake: the OAuth client did not need the platform's entire fetch host object. It needed only a callable request capability.

Minimal capability types avoid importing accidental host-object behaviour and properties into application abstractions.

## Why the bug looked correct in review

The original pattern is idiomatic-looking dependency injection:

```ts
constructor(options) {
  this.fetchImpl = options.fetch ?? fetch;
}
```

It appears to provide exactly what the code needs:

- production gets the runtime's `fetch`;
- tests can inject a fake;
- all network calls go through one dependency;
- the code typechecks;
- request construction tests are straightforward.

The hidden problem is not the stored function value. It is the call expression used later.

These are observably different for receiver-sensitive functions:

```ts
const fn = this.fetchImpl;
await fn(url, init);
```

```ts
await this.fetchImpl(url, init);
```

The second form supplies the client instance as `this`.

The code was locally reasonable and globally wrong because the abstraction erased the distinction between an ordinary callback and a host-runtime method-like capability.

## Why tests passed

Tests mostly injected implementations like this:

```ts
const fetchImpl = async (input, init) => {
  requests.push({ input, init });
  return new Response(...);
};
```

Those are arrow functions. Calling an arrow as `this.fetchImpl(...)` does not rebind its internal `this`.

The tests correctly covered:

- token endpoint URL;
- HTTP method;
- headers;
- PKCE verifier;
- redirect URI;
- explicit form serialization;
- provider-response parsing;
- one-shot code exchange;
- timeout and exception classification;
- redaction of sensitive values.

They did not cover:

- receiver-sensitive host-function invocation;
- the semantic difference between `fetch(...)` and `this.fetchImpl(...)`;
- execution of the production adapter against the real Worker runtime.

The new regression test injects a normal function that deliberately throws unless called with `this === undefined`:

```ts
const fetchImpl = function (this: unknown, input, init) {
  if (this !== undefined) throw new TypeError("Illegal invocation");
  return Promise.resolve(new Response(null, { status: 405 }));
};
```

The old code fails this test. The wrapper-based repair passes.

## Why the direct Worker probes were misleading

The probes were valuable but incomplete.

They proved that the deployed Worker could:

- reach `github.com`;
- reach `api.github.com`;
- POST to the token endpoint;
- use the configured OAuth client ID and secret sufficiently for GitHub to evaluate an invalid code;
- receive the expected `bad_verification_code` provider response;
- use the production User-Agent;
- use `AbortSignal.timeout`;
- complete the request quickly from both production origins.

Those results ruled out broad failures in GitHub availability, Cloudflare egress, DNS, TLS, credentials, request body construction, User-Agent handling, and timeout signals.

But the probes called the native global directly:

```ts
await fetch(url, init);
```

Production called it through the client property:

```ts
await this.fetchImpl(url, init);
```

The probes achieved destination parity and approximate request parity. They did not achieve call-site parity.

A probe that reproduces a network request is not necessarily reproducing the production code path.

## Diagnostic timeline

### Stage 1: undifferentiated network failure

The initial implementation collapsed thrown token-exchange failures into a broad provider-network category. That made all of the following look similar:

- timeout;
- DNS failure;
- TLS failure;
- connection reset;
- request-context error;
- subrequest exhaustion;
- abort;
- local programming exception.

At this stage, proxy, provider, credential, and network hypotheses were reasonable because the available evidence could not distinguish them.

### Stage 2: PR #447 — timeout versus exception

PR #447:

- increased the token-exchange deadline from 15 seconds to 30 seconds;
- retained a 15-second identity deadline;
- classified `TimeoutError` as `network_timeout`;
- classified other thrown values as `network_exception`;
- preserved one-shot exchange semantics and sensitive-output redaction.

The real callback continued returning `network_exception`, ruling out an ordinary slow-request timeout.

This improved classification, but still grouped infrastructure failures and local code errors together.

### Stage 3: bounded egress matrix

A temporary protected Worker probe exercised:

- GitHub root;
- GitHub API;
- token POST without signal;
- token POST with the production User-Agent;
- token POST with the production timeout signal.

All variants succeeded from both origins and received the expected invalid-code response.

The conclusion at the time was that the original exception had probably been transient. That conclusion was wrong because the probe bypassed the production adapter's invocation form.

### Stage 4: PR #449 — preflight and bounded detail

After another real failure, PR #449 added:

- a GET preflight to the exact token endpoint before consuming OAuth state;
- preservation of OAuth state and cookie when preflight failed;
- explicit form-body serialization;
- bounded exception detail;
- Cloudflare colo reporting.

It also temporarily added `cache: "no-store"` and `redirect: "manual"` to the requests.

The next callback returned `detail: type_error`.

That was the first signal strong enough to move local runtime behaviour ahead of remote networking.

### Stage 5: PR #452 — eliminate request-option suspects

Because `cache` and `redirect` were new differences from the successful probes, they were reasonable suspects. PR #452 removed both options and added `operation` classification for:

- `preflight`;
- `exchange`;
- `identity`.

The next callback still returned:

```text
type_error / preflight / LAX
```

That falsified the request-option theory and localized the exception to the call itself.

PR #452 was not the final repair, but it removed two variables and introduced the operation-level signal that made the final diagnosis possible.

### Stage 6: PR #455 — preserve invocation context

The remaining material difference between probes and production was the call form:

```ts
fetch(...)
```

versus:

```ts
this.fetchImpl(...)
```

PR #455:

- introduced the minimal `GitHubFetch` capability type;
- wrapped injected functions to prevent method-call receiver rebinding;
- invoked native fetch explicitly through `globalThis.fetch(...)`;
- added a receiver-sensitive regression test;
- passed typecheck, Bun tests, Convex tests, and Worker bundling;
- was deployed and verified on both origins.

The next fresh OAuth login succeeded.

## What was not the cause

### GitHub OAuth configuration

The client ID, client secret, callback URL, PKCE values, and request body were not the root cause.

The bounded matrix reached GitHub and received `bad_verification_code` for an intentionally invalid code. Production succeeded without changing credentials or callback configuration.

### DNS, TLS, or general Cloudflare egress

The Worker reached both GitHub hosts quickly from both origins. The final failure was a local `TypeError` during preflight, not a DNS or TLS classification.

### Vercel and Cloudflare double proxying

The browser completed the inbound path through GitHub and back to the correct Worker. The application itself produced the structured failure response and Cloudflare colo.

An inbound routing or double-proxy problem would not explain a local `TypeError` at the outbound fetch call site.

### `cache: "no-store"` or `redirect: "manual"`

They were useful suspects because they were recently introduced differences. Removing them did not fix the failure.

### `AbortSignal.timeout`

The bounded Worker matrix successfully used the same timeout signal. The final failure persisted in the preflight after other request controls were removed.

### A GitHub outage or transient provider failure

Repeated real callbacks failed predictably until the invocation wrapper was deployed, then succeeded. That pattern is inconsistent with a purely transient provider outage.

## Contributing factors

### 1. Error compression erased the fault domain

`network_exception` was too coarse. It included both genuine transport failures and local programming errors.

### 2. Tests modelled outputs, not runtime semantics

The fakes returned responses and threw errors correctly, but they were not receiver-sensitive.

### 3. Probes bypassed the production adapter

The probes tested the same destination but not the same implementation.

### 4. The dependency type was too broad

`typeof fetch` described a host object rather than the minimal application capability.

### 5. OAuth's single-use boundary discouraged experimentation

Authorization codes must not be retried after an indeterminate exchange. That correctly constrained recovery, but made every real callback attempt expensive and increased reliance on synthetic probes.

### 6. Several plausible infrastructure theories competed at once

Proxying, DNS, credentials, redirects, cache controls, timeouts, and provider behaviour all fit the initial broad symptom. Without operation- and detail-level diagnostics, the investigation could not rank them effectively.

### 7. The real end-to-end journey was the only reliable detector

Static checks, public OAuth contract verification, bearer verification, unit tests, and direct egress probes all passed. Only the actual browser callback exercised the defective invocation path in the true Worker context.

## Five whys

### Why could the user not sign in?

The callback could not complete GitHub token exchange.

### Why could it not complete token exchange?

The Worker threw a `TypeError` before an outbound token-endpoint request was made.

### Why did the Worker throw?

The native fetch capability was invoked as a method of `HttpGitHubOAuthClient`, supplying an incompatible receiver.

### Why was native fetch stored and invoked that way?

The dependency-injection abstraction treated `fetch` as an ordinary freely rebindable callback and used `typeof fetch` rather than a minimal application-owned callable contract.

### Why did review and tests not catch that assumption?

Mocks used arrow functions and probes called global fetch directly, so neither reproduced receiver-sensitive host-function semantics or the exact production adapter path.

## What went well

- Sensitive OAuth material stayed out of browser errors, logs, issue comments, and retained diagnostic artifacts.
- The code never retried an authorization code after an indeterminate exchange.
- Protected workflows enabled bounded production experiments without exposing credentials.
- The egress matrix decisively ruled out large classes of infrastructure and provider failures.
- `detail`, `operation`, and `colo` diagnostics progressively narrowed the fault domain.
- The team continued fix-forward rather than disabling a mostly healthy OAuth deployment.
- Temporary diagnostic routes, workflows, scripts, and trigger markers were removed after use.
- The final repair included a regression test aimed at the actual semantic failure, not just the observed output.

## What went poorly

- The original failure model used the word `network` for local exceptions that could occur before networking.
- The first successful probe was interpreted too strongly.
- Several changes were deployed before the exact production-path difference had been identified.
- The preflight addition increased complexity before the root cause was known.
- Tests gave false confidence because they covered request data thoroughly while missing call semantics entirely.
- The OAuth adapter lacked a Worker-runtime integration test.
- The investigation did not initially compare the exact source-level call expression used by the successful probe and the failing production client.

## Where we got lucky

- Cloudflare consistently surfaced the receiver problem as a `TypeError`, allowing bounded classification.
- The defect happened during the added preflight, before single-use OAuth state was consumed, making repeated diagnosis safer.
- The final code change was narrow and reversible.
- Existing redaction design allowed more precise diagnostics without exposing secrets.
- The user kept retrying fresh flows and supplied the complete bounded JSON each time.

## Corrective and preventive actions

### Completed

- [x] Split provider timeout from non-timeout exceptions.
- [x] Add bounded exception detail.
- [x] Add operation-level classification.
- [x] Add Cloudflare colo classification.
- [x] Preserve OAuth state and cookie when preflight fails.
- [x] Keep authorization-code exchange one-shot.
- [x] Serialize the token request body explicitly.
- [x] Replace `typeof fetch` with a minimal callable capability type.
- [x] Wrap native and injected fetch implementations to preserve invocation semantics.
- [x] Add a receiver-sensitive regression test.
- [x] Verify the repaired deployment on canonical and fallback origins.
- [x] Complete a real fresh hosted GitHub sign-in.
- [x] Remove temporary diagnostic and repair machinery.

### Required follow-up

- [ ] Add a Worker-runtime integration test that instantiates the production `HttpGitHubOAuthClient` rather than calling global fetch directly.
- [ ] Audit other stored host functions and Web API methods for receiver-sensitive invocation, including crypto, streams, storage, and runtime bindings.
- [ ] Prefer application-owned capability types over `typeof` ambient platform globals in dependency injection.
- [ ] Add a review checklist item: compare production call form with probe and mock call form.
- [ ] Rename or document `network_exception` so local pre-network failures are not semantically misclassified.
- [ ] Add a sanitized internal request identifier or structured server-side diagnostic event that can correlate a callback failure without retaining secrets.
- [ ] Exercise the complete hosted login in a periodic dogfood check where a human/browser step is practical.
- [ ] Publish the readable incident narrative to the live `scrapbook` project once an authenticated Stensibly connection is available to the publishing worker.

## Durable engineering rules

### Host APIs are capabilities, not ordinary callbacks

Do not assume a native or host-provided function remains valid when detached and rebound as an arbitrary object method.

Prefer:

```ts
type RequestFunction = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const request: RequestFunction =
  (input, init) => globalThis.fetch(input, init);
```

Avoid:

```ts
const request: typeof fetch = fetch;
client.request = request;
```

when the client later invokes `client.request(...)`.

### A probe must execute the production adapter

Testing the same URL is not sufficient. A production-parity probe should instantiate and invoke the same class, wrapper, middleware, and call expression as the live path.

### Test syntax-level semantics where they matter

Arguments and return values are not the full contract. Test receiver binding, request context, abort behaviour, and platform restrictions when application code wraps host APIs.

### Errors should identify the operation and fault domain

A safe production error should answer:

- which operation failed;
- whether an HTTP response existed;
- whether the failure was timeout, abort, local type error, DNS, TLS, connection loss, request context, or provider rejection;
- which bounded deployment location handled it;
- without revealing credentials, codes, tokens, provider bodies, or raw messages.

### Real dogfood is part of verification

A public metadata check or direct egress probe cannot substitute for the actual browser callback and downstream MCP connection.

## Final causal statement

We took Cloudflare's native Worker `fetch` function, attached it to the GitHub OAuth client as though it were an ordinary method, and JavaScript consequently invoked it with the client instance as its `this` receiver. The Worker runtime rejected that host-function invocation with a `TypeError` before making the request. Our mocks and direct probes passed because they did not reproduce that receiver binding.

## Evidence map

- Tracking and canonical live state: #286
- Network failure classification: PR #447, merge `a6645e7affbfcb61600df7e95e511a17efcc2d28`
- Callback preflight and bounded diagnostics: PR #449, merge `527aa0fdb5d50ad66e893eb6c5f1abed2626f613`
- Request-option elimination and operation classification: PR #452, merge `daa7a286aea2d897f9daf6c0420881329d8ade33`
- Receiver-preserving repair and regression test: PR #455, merge `3aa6a01a6a4543783bf04c1b3c26f55a7e7249fb`
- Exact candidate verification for PR #455: run `30393687255`
- Production deployment and verification: run `30393846940`

— Bramble · W01 recovery and retrospective
