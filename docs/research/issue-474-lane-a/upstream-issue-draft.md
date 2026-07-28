# Draft upstream issue: generated TypeScript declarations omit JSG receiver requirements

Target repository: `cloudflare/workerd`

Status: internal draft for review. Do not post until the full generated-global fixture and cross-lane review are complete.

Suggested title:

> Generated TypeScript declarations omit receiver requirements enforced by JSG/V8

## Summary

JSG registers ordinary resource methods with an owning V8 `Signature`, so current `workerd` rejects calls made with an unrelated JavaScript receiver. The generated TypeScript declarations omit that receiver requirement and present those methods as freely rebindable functions.

For Worker global operations such as `fetch`, this allows TypeScript to accept a call form that current `workerd` rejects before the native callback executes:

```ts
class Client {
  fetchImpl = fetch;

  run() {
    return this.fetchImpl("data:text/plain,ok");
  }
}
```

The request never leaves the Worker because `this.fetchImpl(...)` supplies the `Client` instance as `this`.

This issue proposes exploring explicit TypeScript `this` parameters in generated Worker declarations. It requests no runtime behavior change.

## User impact

This gap creates a particularly difficult failure mode:

- generated Worker declarations accept the code;
- Bun and Node tests can accept the same call because their global `fetch` implementations tolerate unrelated receivers;
- Chromium and workerd reject the call as an illegal invocation;
- the exception happens before outbound I/O and can look like a network failure;
- the safe repair is a wrapper or explicit binding that TypeScript could have prompted earlier.

A production OAuth adapter encountered exactly this path after storing ambient Worker `fetch` on a client instance and later calling the property as a method.

Detailed downstream investigation:

- https://github.com/teamleaderleo/stensibly/issues/474
- https://github.com/teamleaderleo/stensibly/blob/main/docs/postmortems/2026-07-29-cloudflare-fetch-receiver.md

## Reproduction

### Runtime matrix

Tested with:

- workerd `1.20260728.1` / `workerd 2026-07-28`;
- Chromium `144.0.7559.96`;
- Bun `1.3.14`;
- Node `26.5.0`.

Harness target: `data:text/plain,receiver-ok`.

```js
const url = "data:text/plain,receiver-ok";
const detached = globalThis.fetch;
const holder = { fetch: detached };

await fetch(url);
await globalThis.fetch(url);
await self.fetch(url);
await detached(url);
await detached.call(undefined, url);
await detached.call(globalThis, url);
await detached.call({}, url);
await holder.fetch(url);
```

Observed:

| Call form | workerd 1.20260728.1 | Chromium 144 | Bun 1.3.14 | Node 26.5.0 |
| --- | --- | --- | --- | --- |
| `fetch(url)` | response | response | response | response |
| `globalThis.fetch(url)` | response | response | response | response |
| `self.fetch(url)` | response | response | response | unavailable |
| `detached(url)` | response | response | response | response |
| `detached.call(undefined, url)` | response | response | response | response |
| `detached.call(globalThis, url)` | response | response | response | response |
| `detached.call({}, url)` | illegal invocation | illegal invocation | response | response |
| `holder.fetch(url)` | illegal invocation | illegal invocation | response | response |

Exact workerd error:

```text
TypeError: Illegal invocation: function called with incorrect `this` reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.
```

Commands used for the workerd run:

```console
npm install --no-save --ignore-scripts workerd@1.20260728.1
npx workerd --version
# workerd 2026-07-28
npx workerd serve workerd-config.capnp
curl --fail http://127.0.0.1:8787/
```

Raw output:

- https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110331378

### Generated declarations

For the relevant generated Worker type family, the declarations are receiver-free:

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

A project reproduction:

```console
bunx wrangler types /tmp/worker-types.d.ts
rg -n 'interface ServiceWorkerGlobalScope|declare function fetch|^[[:space:]]+fetch\(' \
  /tmp/worker-types.d.ts
```

No explicit TypeScript `this` parameter appears on either declaration.

## Runtime enforcement trace

### JSG registration

`ServiceWorkerGlobalScope` declares `fetch` as a C++ member and registers it using `JSG_METHOD(fetch)`:

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/api/global-scope.h#L792-L798
- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/api/global-scope.h#L852-L865

### Owning V8 signature

JSG creates a `v8::Signature` from the resource constructor:

```cpp
// Signatures protect our methods from being invoked with the wrong `this`.
auto signature = v8::Signature::New(isolate, constructor);
```

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/resource.h#L2018-L2026

`registerMethod()` passes that signature to the method `FunctionTemplate` on both normal and C-function paths:

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/resource.h#L1339-L1369

Static methods use an empty signature:

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/resource.h#L1371-L1404

### V8 receiver conversion and check

For API functions, V8 converts `undefined` and `null` to the global proxy while leaving object receivers unchanged:

- https://github.com/v8/v8/blob/66b7bf5e0ddc117ecfd04b8d79066fef3d9eaf2b/src/builtins/builtins-api.cc#L155-L177
- https://github.com/v8/v8/blob/66b7bf5e0ddc117ecfd04b8d79066fef3d9eaf2b/src/objects/objects.cc#L300-L309

It then validates the converted receiver against the function-template signature and throws for an unrelated holder:

- https://github.com/v8/v8/blob/66b7bf5e0ddc117ecfd04b8d79066fef3d9eaf2b/src/builtins/builtins-api.cc#L25-L54
- https://github.com/v8/v8/blob/66b7bf5e0ddc117ecfd04b8d79066fef3d9eaf2b/src/builtins/builtins-api.cc#L92-L112

Cloudflare's V8 patch expands the illegal-invocation message:

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/patches/v8/0012-Update-illegal-invocation-error-message-in-v8.patch#L14-L23

## Declaration-generation trace

The owning receiver disappears along the generated-type path.

### Member traits

`FunctionTraits<R (This::*)(Args...)>` retains the return type and argument tuple while omitting the C++ owner from the trait output:

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/rtti.h#L80-L109

### RTTI schema

`Method` contains name, return type, arguments, static status, and fast-API compatibility. It has no receiver policy or owner reference:

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/src/workerd/jsg/rtti.capnp#L275-L281

### TypeScript method generation

`createMethodPartial(fullyQualifiedParentName, method)` already receives parent context, then emits only `method.args` and the return type:

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/types/src/generator/structure.ts#L32-L48

### Global extraction

`maybeExtractGlobalNode()` converts methods from `ServiceWorkerGlobalScope` into top-level functions while copying their parameter list unchanged:

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/types/src/transforms/globals.ts#L74-L116
- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/types/src/transforms/globals.ts#L118-L203

The transform test snapshots receiver-free global functions:

- https://github.com/cloudflare/workerd/blob/6aa890be9fa547e3907c805b312e39917a274221/types/test/transforms/globals.spec.ts#L15-L74

## Proposed bounded direction

### Ordinary non-static JSG methods

Generate an explicit owning receiver:

```ts
interface Crypto {
  getRandomValues<T extends ArrayBufferView>(
    this: Crypto,
    array: T,
  ): T;
}
```

The generator already has the parent type name, so an initial prototype may avoid an RTTI schema change.

Suggested first scope:

- include ordinary non-static `JSG_METHOD` members;
- exclude static methods, constructors, properties, and callable resources;
- add generator snapshots and `tsc` fixtures;
- test inherited methods explicitly.

### Extracted Worker globals

The interface member can retain the strict owner receiver. Its top-level global copy needs a widened receiver that preserves Web IDL's bare/null/global calls while rejecting unrelated holders.

An isolated TypeScript 5.8.3 fixture works with one union signature:

```ts
declare function fetch(
  this: ServiceWorkerGlobalScope | null | void,
  input: RequestInfo | URL,
  init?: RequestInit<RequestInitCfProperties>,
): Promise<Response>;
```

Separate `this: void` and `this: Owner` overloads remain too permissive. A single union behaves differently and rejects the unrelated holder.

One Cloudflare-specific caveat remains: the generated global transform creates free declarations without making TypeScript's `typeof globalThis` exactly `ServiceWorkerGlobalScope`. In a minimal model of that output, `globalThis.fetch(...)` required a receiver union that also included `typeof globalThis`:

```ts
this:
  | ServiceWorkerGlobalScope
  | typeof globalThis
  | null
  | void
```

That spelling may create a recursive relationship in the complete declaration file. A generated helper alias or a smaller designated-global interface may be preferable.

The exact global receiver type should therefore be settled by a full generated-output fixture before implementation is chosen.

### RTTI metadata as a later step

A receiver policy in RTTI could support other generators and typed tooling:

```capnp
receiverPolicy :ReceiverPolicy;
# none | owningType | contextGlobal
```

The initial TypeScript prototype can use generator parent context. RTTI expansion becomes useful when another consumer needs the same fact or parent context proves insufficient.

## Why the runtime should stay unchanged

The receiver check already matches Chromium and Web IDL behavior. Relaxing it would broaden the runtime contract across JSG methods and could affect native object identity, holder lookup, or internal assumptions.

An explicit TypeScript receiver:

- adds no runtime code;
- grants no new capability;
- narrows accepted TypeScript calls toward current runtime behavior;
- points users toward `.bind(owner)` or an application-owned arrow wrapper.

Cloudflare already uses that adapter pattern in workerd PR 2730, which changed a free-standing `node:crypto` compatibility export from a raw `crypto.getRandomValues` reference to `crypto.getRandomValues.bind(crypto)` while preserving the underlying Web Crypto receiver rule:

- https://github.com/cloudflare/workerd/pull/2730

Related receiver discussion:

- https://github.com/cloudflare/workerd/issues/2716

## Compatibility considerations

A generated type change can produce new compiler errors after users update Wrangler and regenerate declarations.

The intended new errors cover code that current workerd already rejects. A broader generator change may also affect deliberate adapters that extract methods and later supply a valid receiver.

Before a broad patch, please consider fixtures for:

- direct owner calls;
- detached calls;
- `.call(owner)` and `.bind(owner)`;
- receiver-free callback assignments;
- inherited JSG methods;
- context-global methods;
- representative APIs with existing ecosystem use.

TypeScript also permits receiver information to disappear after assignment to a callback type that omits `this`. Generated declarations improve direct diagnostics while wrappers and runtime tests remain useful downstream.

## Questions for maintainers

1. Is a generator-only prototype using the existing parent type context an acceptable first step?
2. For inherited methods, should the explicit receiver use the declaring type or generated leaf type?
3. Which non-static JSG methods intentionally permit receiver-independent invocation?
4. What generated type should represent the legal Worker-global receiver without creating recursive `globalThis` output?
5. Should this source-compatibility change follow the normal generated-types release path or an opt-in transition?
6. Would receiver policy in RTTI help another current consumer, or should it wait?
7. Which APIs provide the best compatibility sample before applying the change broadly?

## Suggested acceptance criteria

A successful prototype would:

- preserve current workerd runtime behavior;
- generate `this: OwningType` for selected ordinary non-static JSG methods;
- preserve `fetch(...)`, `globalThis.fetch(...)`, `self.fetch(...)`, detached bare calls, `.call(undefined)`, and `.call(null)`;
- reject `.call({})` and invocation through an unrelated holder in TypeScript;
- leave static methods receiver-free;
- include snapshot and compile fixtures;
- document receiver widening as a remaining TypeScript escape.

## Out of scope

- relaxing JSG/V8 receiver enforcement;
- changing Fetch or Web IDL semantics;
- solving every receiver-erasure path in TypeScript;
- requiring nominal brands across all generated Worker interfaces;
- opening a TypeScript language proposal before the generator prototype is evaluated.

— Kestrel · draft assembled from Stensibly issue 474 Lane A evidence
