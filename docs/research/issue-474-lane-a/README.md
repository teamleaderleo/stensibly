# Issue 474 Lane A: workerd receiver contract and generated Worker types

Status: research draft. This branch changes no production code and opens no upstream work.

Tracking: [teamleaderleo/stensibly#474](https://github.com/teamleaderleo/stensibly/issues/474)

Related incident record: [Cloudflare fetch receiver postmortem](../../postmortems/2026-07-29-cloudflare-fetch-receiver.md)

## Conclusion

The production failure exposed a declaration-fidelity bug class, rather than a reason to relax `workerd` at runtime.

Current `workerd` and Chromium enforce the Web IDL receiver contract for global `fetch`:

- bare and detached calls work because `undefined` or `null` is converted to the realm global;
- calls through the actual Worker global work;
- calls through an unrelated object fail with `TypeError: Illegal invocation` before the request leaves the runtime.

Cloudflare's generated Worker declarations describe the same value as a receiver-free function. That gap lets TypeScript accept code that current `workerd` rejects:

```ts
class Client {
  fetchImpl = fetch;

  run() {
    return this.fetchImpl("https://example.com");
  }
}
```

The local arrow wrapper remains the correct application repair. A bounded upstream improvement would expose the receiver rule in generated TypeScript so more users receive a compile-time diagnostic before deployment.

The first upstream prototype should stay inside `cloudflare/workerd`'s type-generation code:

1. add `this: OwningType` to ordinary non-static JSG methods;
2. give extracted Worker globals a specially widened receiver that preserves legal bare/global calls;
3. add receiver metadata to RTTI only when another consumer needs it.

The exact global receiver type still needs one full generated-declaration fixture. `ServiceWorkerGlobalScope | null | void` models the runtime set in an isolated fixture, while the complete Cloudflare declaration model may also require `typeof globalThis` or a generated alias so `globalThis.fetch(...)` remains accepted.

## What users actually update

There is no desktop `Cloudflare.exe` update in this path.

Cloudflare operates the hosted Workers runtime. A Worker project carries a compatibility date and optional compatibility flags. Cloudflare can update the runtime globally while gating backwards-incompatible behavior behind those settings.

The developer-controlled pieces are project dependencies and generated declarations:

- update the local Wrangler dependency;
- choose a newer compatibility date or flags when appropriate;
- run `wrangler types` to regenerate Worker declarations;
- deploy the Worker when runtime configuration or code changed.

A receiver-typing fix would therefore reach users through a newer Wrangler/workerd type release and a regenerated declaration file. It would produce new TypeScript diagnostics. It would leave the deployed receiver check unchanged.

Primary Cloudflare documentation:

- [TypeScript support and runtime-generated types](https://developers.cloudflare.com/workers/languages/typescript/)
- [`wrangler types`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#types)
- [Compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)

## Why this belongs upstream

Awkward dependency injection alone would be a local ergonomics concern. The stronger upstream case is that Cloudflare owns both sides of an inaccurate contract:

1. JSG tells V8 that the method has an owning receiver.
2. V8 enforces that receiver and throws for unrelated objects.
3. JSG RTTI and the Worker type generator omit the receiver.
4. Wrangler distributes the resulting declarations as runtime-specific Worker types.

The runtime therefore knows a fact that the generated declarations erase.

This omission has user-visible impact:

- code typechecks under the generated Worker declarations;
- common Bun and Node tests also pass because their global `fetch` implementations accept unrelated receivers;
- the deployed Worker throws before issuing the request;
- the exception can be misclassified as an outbound network failure;
- developers then invent wrappers, binding conventions, or test doubles after production discovery.

A declaration fix moves that discovery into the compiler while preserving the existing runtime boundary.

## Responsibility split

### workerd runtime

`workerd` owns the receiver behavior. The current strict behavior follows browser/Web IDL semantics and should remain.

Relaxing the native receiver would broaden the legal runtime call set across JSG methods. That change would carry much greater compatibility and safety risk than a declaration correction.

### workerd and Wrangler type generation

Cloudflare's generated types aim to describe the selected Worker runtime, compatibility date, flags, and bindings. Receiver fidelity belongs here when TypeScript can express it.

### Stensibly

Stensibly owns its application boundary regardless of upstream timing:

- keep the application-owned arrow wrapper;
- keep the strict-receiver portable regression test;
- add one native `workerd` production-path smoke test;
- prefer minimal callable capability types over `typeof` host globals.

Upstream declarations improve early feedback. Local runtime coverage remains the final check because type information can be widened away, asserted around, or consumed from JavaScript.

## Versions and commands

### Stensibly project snapshot

The investigation snapshot at commit `4186e7b70fbea2f47924cb07339d354be1d9fe63` used:

- compatibility date `2026-07-24`;
- compatibility flag `nodejs_compat`;
- Wrangler `4.114.0` from the lockfile;
- Miniflare `4.20260722.0`;
- workerd `1.20260722.1`;
- workers-types peer range `^5.20260722.1`.

Project files:

- [`wrangler.jsonc`](../../../wrangler.jsonc)
- [`bun.lock`](../../../bun.lock)

### Current runtime matrix run

The executable cross-runtime run used:

- Bun `1.3.14`;
- Node `26.5.0`;
- workerd `1.20260728.1` / `workerd 2026-07-28`;
- Chromium `144.0.7559.96`.

Raw CI evidence: [#474 comment 5110331378](https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110331378)

Commands:

```console
bun --version
bun receiver-matrix.mjs

node --version
node receiver-matrix.mjs

npm install --no-save --ignore-scripts workerd@1.20260728.1
npx workerd --version
npx workerd serve workerd-config.capnp
curl --fail http://127.0.0.1:8787/
```

The workerd source trace uses commit `6aa890be9fa547e3907c805b312e39917a274221`, corresponding to the `1.20260728.1` package used by the runtime matrix.

## Observed receiver matrix

The harness targeted `data:text/plain,receiver-ok`. `response` means HTTP 200 with body `receiver-ok`.

| Call form | Bun 1.3.14 | Node 26.5.0 | workerd 1.20260728.1 | Chromium 144 |
| --- | --- | --- | --- | --- |
| `fetch(url)` | response | response | response | response |
| `globalThis.fetch(url)` | response | response | response | response |
| `self.fetch(url)` | response | `ReferenceError` | response | response |
| `detached(url)` | response | response | response | response |
| `detached.call(undefined, url)` | response | response | response | response |
| `detached.call(globalThis, url)` | response | response | response | response |
| `detached.call({}, url)` | response | response | illegal invocation | illegal invocation |
| `holder.fetch(url)` | response | response | illegal invocation | illegal invocation |

Exact workerd failure:

```text
TypeError: Illegal invocation: function called with incorrect `this` reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.
```

The Stensibly defect was equivalent to the last row:

```ts
const holder = { fetch: globalThis.fetch };
await holder.fetch(url);
```

Property-call syntax supplies `holder` as `this`. Bun and Node ignore that receiver for global `fetch`. Chromium and workerd enforce the owning global.

## Standards basis

The Fetch Standard declares `fetch` as an operation on `WindowOrWorkerGlobalScope`:

- [Fetch Standard: fetch method](https://fetch.spec.whatwg.org/#fetch-method)

Web IDL operation binding supplies the receiver behavior:

- use the JavaScript `this` value for a regular operation;
- substitute the realm global when `this` is `null` or `undefined`;
- reject a non-null receiver that does not implement the owning interface.

Primary reference:

- [Web IDL operation binding](https://webidl.spec.whatwg.org/#es-operations)

That produces the browser/workerd call set observed above. A detached bare global operation can be legal. Installing that operation on an unrelated object and invoking it through that object is the failing transition.

## JSG and V8 enforcement path

### 1. fetch is an ordinary JSG method

`ServiceWorkerGlobalScope` declares `fetch` as a C++ member and registers it with `JSG_METHOD(fetch)`:

- [`global-scope.h`: fetch declaration](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/api/global-scope.h#L792-L798)
- [`global-scope.h`: `JSG_METHOD(fetch)`](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/api/global-scope.h#L852-L865)

`getSelf()` returns `JSG_THIS`, tying `self` to the same JSG resource instance.

### 2. JSG creates an owning V8 signature

When JSG creates a resource template, it creates a V8 signature from that resource's constructor:

```cpp
// Signatures protect our methods from being invoked with the wrong `this`.
auto signature = v8::Signature::New(isolate, constructor);
```

Source:

- [`resource.h`: signature creation](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/resource.h#L2018-L2026)

### 3. JSG attaches the signature to method templates

`registerMethod()` passes the signature to V8 on both the ordinary and C-function paths:

- [`resource.h`: `registerMethod()`](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/resource.h#L1339-L1369)

Static methods deliberately use an empty signature because they have no holder object:

- [`resource.h`: `registerStaticMethod()`](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/resource.h#L1371-L1404)

This distinction gives a clean first boundary for generated receiver parameters: non-static JSG methods receive them; static methods do not.

### 4. V8 converts and validates the receiver

For API functions, V8 performs non-strict receiver conversion:

- objects stay unchanged;
- `null` or `undefined` becomes the isolate global proxy;
- other primitives are boxed.

Sources:

- [`builtins-api.cc`: receiver conversion path](https://github.com/v8/v8/blob/66b7bf5e0ddc117ecfd04b8d79066fef3d9eaf2b/src/builtins/builtins-api.cc#L155-L177)
- [`objects.cc`: `Object::ConvertReceiver()`](https://github.com/v8/v8/blob/66b7bf5e0ddc117ecfd04b8d79066fef3d9eaf2b/src/objects/objects.cc#L300-L309)

V8 then checks the converted object against the `FunctionTemplate` signature. The owning-template instance and a compatible global proxy pass. An unrelated object produces `Illegal invocation` before the JSG C++ callback runs.

Sources:

- [`builtins-api.cc`: signature receiver check](https://github.com/v8/v8/blob/66b7bf5e0ddc117ecfd04b8d79066fef3d9eaf2b/src/builtins/builtins-api.cc#L25-L54)
- [`builtins-api.cc`: holder lookup and illegal invocation](https://github.com/v8/v8/blob/66b7bf5e0ddc117ecfd04b8d79066fef3d9eaf2b/src/builtins/builtins-api.cc#L92-L112)

Cloudflare carries a V8 patch that expands the diagnostic text:

- [`0012-Update-illegal-invocation-error-message-in-v8.patch`](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/patches/v8/0012-Update-illegal-invocation-error-message-in-v8.patch#L14-L23)

## Where the generated declarations lose the receiver

The current generated form is receiver-free:

```ts
interface ServiceWorkerGlobalScope extends WorkerGlobalScope {
  fetch(
    input: RequestInfo | URL,
    init?: RequestInit<RequestInitCfProperties>,
  ): Promise<Response>;
}

declare function fetch(
  input: RequestInfo | URL,
  init?: RequestInit<RequestInitCfProperties>,
): Promise<Response>;
```

### 1. C++ member traits discard the owner

`FunctionTraits<R (This::*)(Args...)>` retains `ReturnType` and `ArgsTuple`. The `This` type is absent from the trait output used by RTTI:

- [`rtti.h`: member function traits](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/rtti.h#L80-L109)

### 2. RTTI Method has no receiver field

The Cap'n Proto `Method` record carries name, return type, arguments, static status, and fast-API compatibility:

- [`rtti.capnp`: Method](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/rtti.capnp#L275-L281)

### 3. The TypeScript generator omits a this pseudo-parameter

`createMethodPartial(fullyQualifiedParentName, method)` already receives the parent name. It creates parameters from `method.args` and emits the return type:

- [`types/src/generator/structure.ts`](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/types/src/generator/structure.ts#L32-L48)

This parent context makes a generator-only prototype possible before changing RTTI.

### 4. The global transform copies receiver-free parameters

`maybeExtractGlobalNode()` turns methods from `ServiceWorkerGlobalScope` into top-level `declare function` declarations and copies `node.parameters` unchanged:

- [`types/src/transforms/globals.ts`: extraction](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/types/src/transforms/globals.ts#L74-L116)
- [`types/src/transforms/globals.ts`: global-scope traversal](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/types/src/transforms/globals.ts#L118-L203)

### 5. Tests snapshot receiver-free globals

The transform test expects plain top-level functions such as `btoa(value: string): string`:

- [`types/test/transforms/globals.spec.ts`](https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/types/test/transforms/globals.spec.ts#L15-L74)

The information gap therefore spans two deliberate generation stages: method generation and global extraction.

## TypeScript encoding

### Ordinary JSG methods

For an ordinary instance method, the direct declaration is:

```ts
interface Crypto {
  getRandomValues<T extends ArrayBufferView>(
    this: Crypto,
    array: T,
  ): T;
}
```

This accepts an owning-object call and rejects a detached or unrelated-owner call.

### Extracted Worker globals

One union receiver has the desired behavior in TypeScript 5.8.3. Separate overloads do not.

Isolated candidate:

```ts
declare function fetch(
  this: ServiceWorkerGlobalScope | null | void,
  input: RequestInfo | URL,
  init?: RequestInit<RequestInitCfProperties>,
): Promise<Response>;
```

This can accept bare calls, `null`/`undefined`, and the designated global owner while rejecting an unrelated holder.

### Complete generated-global caveat

Cloudflare creates free global declarations through a transform instead of declaring TypeScript's `globalThis` as exactly `ServiceWorkerGlobalScope`. In a minimal model of that output, `globalThis.fetch(...)` can fail the receiver check because `typeof globalThis` lacks members required by `ServiceWorkerGlobalScope`.

A wider candidate preserved the intended calls in that fixture:

```ts
declare function fetch(
  this:
    | ServiceWorkerGlobalScope
    | typeof globalThis
    | null
    | void,
  input: RequestInfo | URL,
  init?: RequestInit<RequestInitCfProperties>,
): Promise<Response>;
```

This spelling needs validation against the complete generated Worker declarations. It may create a recursive type relationship because the declaration itself contributes to `typeof globalThis`.

A generated helper alias or a smaller designated-global interface may prove cleaner. This is the main unresolved typing detail before an upstream issue can claim a final signature.

### Receiver information can be widened away

TypeScript allows a source with an explicit receiver parameter to flow into a receiver-free callback type:

```ts
type PlainFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

declare const rawFetch: (
  this: ServiceWorkerGlobalScope | null | void,
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const widened: PlainFetch = rawFetch;
const holder = { fetch: widened };
holder.fetch("https://example.com"); // compiles
```

Declarations catch direct and inferred misuse. They cannot guarantee receiver preservation across every callback boundary. That limitation supports keeping the local wrapper and native runtime test.

## Upstream precedent

### workerd issue 2716

[`cloudflare/workerd#2716`](https://github.com/cloudflare/workerd/issues/2716) covers the same receiver-sensitive family for `crypto.getRandomValues`. The runtime treats illegal invocation as browser-compatible behavior.

### workerd PR 2730

[`cloudflare/workerd#2730`](https://github.com/cloudflare/workerd/pull/2730) fixed a compatibility adapter that re-exported `crypto.getRandomValues` as a free function:

```diff
- export const getRandomValues = crypto.getRandomValues;
+ export const getRandomValues = crypto.getRandomValues.bind(crypto);
```

That change preserved two contracts:

- `node:crypto.getRandomValues` works as a free-standing Node-compatible export;
- `crypto.webcrypto.getRandomValues` keeps its receiver-sensitive Web Crypto behavior.

This is the same division recommended here: bind or wrap when an adapter intentionally turns a host method into a callback; retain receiver fidelity in the underlying declaration.

## Security and compatibility assessment

### Runtime exposure

The proposed type change creates no new runtime capability and grants no additional receiver. The existing V8/JSG check remains untouched.

The risky ergonomic change would relax the runtime so JSG methods tolerate arbitrary receivers. This lane recommends against that direction.

### Source compatibility

A generated declaration change can break TypeScript builds after users update Wrangler and regenerate types. The affected code falls into two groups:

1. code already rejected by current workerd, where the diagnostic is valuable;
2. code that deliberately extracts a host method and later supplies a valid owner through `.call`, `.bind`, or an adapter, where annotations may need adjustment.

The prototype should measure both groups across representative APIs before a broad rollout.

### Type compatibility limits

TypeScript compares object members by compatibility. An unrelated object that happens to satisfy the owner interface can pass the checker. A nominal marker would tighten the model and create a wider compatibility cost.

The Stensibly client lacks the Worker-global members, so the ordinary owner type catches the concrete defect without a new brand.

### Generated-global recursion

Using `typeof globalThis` inside a declaration that contributes to the global type may create circular or unstable output. A full generator fixture must settle this before implementation.

### Compatibility-date policy

The runtime receiver rule already exists across the investigated workerd releases. The declaration correction changes source diagnostics rather than deployed semantics. Cloudflare maintainers should decide whether this follows the normal generated-types release path or an opt-in transition.

## Bounded upstream options

### Option A: generator-only receiver parameters

Recommended first experiment.

- prepend `this: OwningType` to generated non-static JSG methods;
- exclude static methods, constructors, properties, and callable resources;
- retain the strict owner receiver on the interface method;
- widen only the top-level global copy inside `globals.ts`;
- add snapshot and compiler fixtures.

Advantages:

- smallest implementation;
- parent owner is already available;
- no RTTI schema migration;
- directly catches the incident pattern.

Risks:

- inherited methods need the correct declaring or effective owner;
- the exact `globalThis` type needs resolution;
- source compatibility needs measurement.

### Option B: explicit RTTI receiver policy

Add a receiver field such as:

```capnp
receiverPolicy :ReceiverPolicy;
# none | owningType | contextGlobal
```

Advantages:

- records runtime intent beside method metadata;
- supports other generators, editors, or typed lint rules;
- distinguishes ordinary methods from context globals explicitly.

Costs:

- Cap'n Proto schema and generated-binding changes;
- RTTI builder work;
- broader review surface.

This becomes worthwhile after another consumer needs the receiver fact or generator parent context proves insufficient.

### Option C: narrow TypeScript override

Use `JSG_TS_OVERRIDE` for one known API such as `fetch` or `crypto.getRandomValues` to prove diagnostics before changing generation globally.

Advantages:

- very small experiment;
- limited source-compatibility blast radius.

Costs:

- duplicates signatures;
- can drift from implementation;
- scales poorly.

### Option D: metadata-driven typed lint

Expose receiver-sensitive metadata and let tooling report assignments that erase it.

This covers callback widening that declarations alone permit. It also carries more setup and false-positive policy than native TypeScript diagnostics. It belongs after the direct declaration prototype.

## Recommended next sequence

1. Keep Stensibly's arrow wrapper and current strict-receiver test.
2. Add one native-workerd smoke test that instantiates the production `HttpGitHubOAuthClient` through its default fetch path.
3. Build a full generated-types fixture in a workerd checkout covering ordinary methods and extracted globals.
4. Settle the accurate global receiver alias, explicitly testing `fetch(...)`, `globalThis.fetch(...)`, `self.fetch(...)`, detached calls, `call(null)`, `call(undefined)`, and unrelated holders.
5. Measure source compatibility across representative JSG APIs.
6. Open one Cloudflare issue scoped to generated declaration fidelity, with no runtime change requested.
7. Prototype the generator-only patch before proposing RTTI metadata.

## Proposed upstream scope

Repository: [`cloudflare/workerd`](https://github.com/cloudflare/workerd)

Issue theme:

> Generated TypeScript declarations omit receiver requirements already enforced by JSG/V8.

Requested outcome:

- represent owning receivers for ordinary non-static JSG methods;
- preserve legal context-global invocation forms when methods are extracted as free globals;
- add generated-type tests and compatibility evidence;
- preserve runtime behavior unchanged.

Draft issue text: [`upstream-issue-draft.md`](./upstream-issue-draft.md)

Bounded implementation plan: [`upstream-pr-plan.md`](./upstream-pr-plan.md)

## Open questions

1. What is the smallest accurate generated type for the Worker global receiver?
2. Can `typeof globalThis` appear safely in the extracted declaration, or should the generator create a helper interface or alias?
3. For inherited JSG methods, should `this` use the declaring type or the generated leaf type?
4. Which non-static JSG methods intentionally permit receiver-independent calls?
5. Should the type change follow the normal generated-types release process or an opt-in compatibility transition?
6. Does another consumer already justify adding receiver policy to RTTI?
7. Which representative APIs best measure source compatibility before a broad patch?

## Evidence map

- Main investigation: [#474](https://github.com/teamleaderleo/stensibly/issues/474)
- Lane A detailed comment: [#474 comment 5110389219](https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110389219)
- Direct workerd runtime evidence: [#474 comment 5110331378](https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110331378)
- TypeScript fixture and technique matrix: [`research/issue-474-lane-b`](https://github.com/teamleaderleo/stensibly/tree/research/issue-474-lane-b/docs/research/issue-474-lane-b)
- Cross-runtime analysis: [#474 comment 5110410658](https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110410658)
- Global extraction caveat: [#474 comment 5110454396](https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110454396)
- V8 receiver conversion detail: [#474 comment 5110465204](https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110465204)
- Incident postmortem: [`docs/postmortems/2026-07-29-cloudflare-fetch-receiver.md`](../../postmortems/2026-07-29-cloudflare-fetch-receiver.md)

— Kestrel · continuation of Flare/Lane A research
  Intention: preserve a reviewable upstream packet without external publication.
