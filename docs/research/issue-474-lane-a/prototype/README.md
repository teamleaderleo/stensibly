# Workerd receiver-aware generated-types prototype

Status: executable internal prototype for Stensibly issue #474. The patch targets `cloudflare/workerd` commit `6aa890be9fa547e3907c805b312e39917a274221` (`1.20260728.1`). No Cloudflare issue, branch, or pull request has been opened.

Internal validation PR: [teamleaderleo/stensibly#483](https://github.com/teamleaderleo/stensibly/pull/483)

## Prototype

Patch: [`workerd-receiver-types.patch`](./workerd-receiver-types.patch)

The patch changes generated declarations only.

### Ordinary JSG methods

`createMethodPartial()` prepends an erased TypeScript receiver to every non-static generated method:

```ts
method(this: OwningType, ...args): Result;
```

The owner name is derived from the parent context already passed to the generator. This keeps the prototype out of the RTTI schema.

Static methods remain receiver-free because JSG registers them without a V8 holder signature.

### Extracted Worker globals

The global-scope transform recognises a leading `this` pseudo-parameter. For the free global copy it replaces the owning receiver with:

```ts
this: typeof globalThis | null | void
```

This avoids the earlier recursive/compatibility concern around putting `ServiceWorkerGlobalScope | typeof globalThis` into the free declaration:

- `typeof globalThis` accepts `globalThis.fetch(...)`;
- `void` accepts bare and detached calls;
- `null` accepts the Web IDL/V8 null-receiver form;
- unrelated holders remain incompatible.

A method with no explicit receiver is copied unchanged. This preserves static methods and deliberate receiver-free overrides.

The interface member remains strict:

```ts
interface ServiceWorkerGlobalScope {
  fetch(this: ServiceWorkerGlobalScope, ...args): Promise<Response>;
}
```

The top-level global is detachable:

```ts
declare function fetch(
  this: typeof globalThis | null | void,
  ...args
): Promise<Response>;
```

## Compile matrix

The new `types/test/types/fetch-receiver.ts` fixture requires these forms to compile:

```ts
fetch(url);
globalThis.fetch(url);
self.fetch(url);

const detached = fetch;
detached(url);
detached.call(undefined, url);
detached.call(null, url);
detached.call(globalThis, url);
detached.apply(undefined, [url]);
detached.apply(null, [url]);
detached.apply(globalThis, [url]);

const boundUndefined = detached.bind(undefined);
const boundNull = detached.bind(null);
const boundGlobal = detached.bind(globalThis);
boundUndefined(url);
boundNull(url);
boundGlobal(url);
({ fetch: boundGlobal }).fetch(url);
```

It requires diagnostics for:

```ts
detached.call({}, url);
detached.apply({}, [url]);
detached.bind({});
({ fetch: detached }).fetch(url);

class Client {
  fetchImpl = fetch;
  run() {
    return this.fetchImpl(url);
  }
}
```

The negative cases use `@ts-expect-error`, so the fixture fails if the generated declarations become permissive again.

## Focused validation

The temporary Stensibly workflow performs:

```console
git -C workerd apply --check workerd-receiver-types.patch
git -C workerd apply workerd-receiver-types.patch
git -C workerd diff --check

bazelisk test \
  //types:test/transforms/globals.spec \
  //types:test/types/fetch-receiver \
  --test_output=errors
```

The workflow reproduces workerd's own Linux CI toolchain with LLVM 19 before running the focused targets.

The transform test verifies three paths:

1. receiver-sensitive methods become globals with `typeof globalThis | null | void`;
2. static methods remain receiver-free;
3. an explicitly receiver-free method remains unchanged.

## Deliberate limits

- The patch uses generator parent context and adds no RTTI receiver field.
- TypeScript can still erase a receiver through widening to a plain callback type.
- The patch does not relax JSG/V8 receiver enforcement.
- The patch does not add nominal owner brands.
- The compile matrix covers detachment from the free global declaration. A broader follow-up can evaluate whether references obtained specifically through `self.fetch` should retain the detachable global call set.
- Source-compatibility measurement across representative generated APIs remains required before proposing a broad upstream merge.

— Kestrel · Cloudflare implementation lane
