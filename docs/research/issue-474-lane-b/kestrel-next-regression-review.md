# Tess — Kestrel/Rook next-revision regression plan

Status: test preparation complete; fork-branch review pending the first receiver implementation commit in `teamleaderleo/workerd`.

Prepared artifacts:

- [`kestrel-next-regression-tests.patch`](./kestrel-next-regression-tests.patch): test-only delta for the workerd fork.
- [`generated-receiver-eslint-matrix.fixture.ts`](./generated-receiver-eslint-matrix.fixture.ts): the original 22 TypeScript/ESLint cases using the generated declaration shape.
- [`self-fetch-bunyan-matrix.fixture.ts`](./self-fetch-bunyan-matrix.fixture.ts): Bunyan's exact direct/call/apply/bind matrix for a function obtained through `self.fetch`.
- Existing typed ESLint and receiver-erasure configurations run against both the abstract fixture and the generated-shape fixture. The Bunyan matrix is a compiler correctness fixture, not a lint expectation fixture.

## Required workerd regression cases

| Requirement | Test location | Required output |
| --- | --- | --- |
| Legacy override without `this` | override-transform method fixture | inherits `this: Root1` |
| Every overload inherits the receiver | three `get()` override overloads | every overload contains `this: Root1` |
| Explicit `this: void` | `receiverFree()` override | remains exactly `this: void` |
| Explicit custom receiver | `customReceiver()` override and global transform | remains exactly `this: CustomReceiver` |
| Static generated method | existing static `one()` / `two()` paths and global `detachable()` | no explicit `this` |
| Generic owner | `Root1<R>` type-parameter fixture | generated and inherited receivers use `Root1<R>`, not raw `Root1` |
| Inherited owner | `EventTarget<EventMap>` extracted through `WorkerGlobalScopeEventMap` | receiver uses `EventTarget<WorkerGlobalScopeEventMap>` |
| Context-global `self.fetch` | generated fetch fixture plus Bunyan matrix | interface method and extracted global both use the context-global receiver union |
| Preserved precise type | detached `self.fetch` moved to unrelated holder | TypeScript rejects the property call while the receiver-aware type is intact |
| Contextual widening | 22-case TypeScript/ESLint fixture | remains a separate receiver-erasure lint limitation, not a declaration failure |

The focused CI target set must include:

```console
bazelisk test \
  //types:test/index.spec \
  //types:test/transforms/overrides/index.spec \
  //types:test/transforms/globals.spec \
  //types:test/types/fetch-receiver \
  --test_output=errors
```

## Bunyan-pinned `self.fetch` declaration requirement

Native workerd confirms that `self.fetch` has the same invocation-time receiver set as bare Worker-global `fetch`. Accessing the function through `self` does not bind it.

Evidence: https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5111597589

Therefore an owner-only interface declaration is incorrect:

```ts
// Incorrect
fetch(this: ServiceWorkerGlobalScope, ...args): Promise<Response>;
```

Both declaration surfaces must carry the context-global union:

```ts
interface ServiceWorkerGlobalScope {
  fetch(
    this: ServiceWorkerGlobalScope | typeof globalThis | null | void,
    ...args: FetchArgs
  ): Promise<Response>;
}

declare function fetch(
  this: ServiceWorkerGlobalScope | typeof globalThis | null | void,
  ...args: FetchArgs
): Promise<Response>;
```

The exact Bunyan matrix for `const fromSelf = self.fetch` is:

### Must compile and succeed at runtime

```ts
self.fetch(url);
fromSelf(url);

fromSelf.call(undefined, url);
fromSelf.call(null, url);
fromSelf.call(globalThis, url);

fromSelf.apply(undefined, [url]);
fromSelf.apply(null, [url]);
fromSelf.apply(globalThis, [url]);

fromSelf.bind(undefined)(url);
fromSelf.bind(null)(url);
fromSelf.bind(globalThis)(url);
```

### Must be rejected while the precise type is preserved

These forms throw workerd's exact `TypeError: Illegal invocation` at runtime:

```ts
fromSelf.call({}, url);
({ fetch: fromSelf }).fetch(url);
fromSelf.apply({}, [url]);
fromSelf.bind({})(url);
```

The declaration should reject the invalid `call`, `apply`, and `bind` receiver at the corresponding TypeScript operation. For `bind({})(url)`, TypeScript should fail at `bind({})`, earlier than workerd's invocation-time failure.

A contextual conversion such as `const widened: PlainFetch = fromSelf` erases the explicit receiver. Calls through an unrelated holder then compile. That remains the separate ESLint/provenance gap and must not be used to weaken the generated declaration.

## Blocking correctness issues in the current prototype

### 1. Generic owner parameters are currently lost

The latest focused unit run produced:

```diff
- this: EventTarget<EventMap>
+ this: EventTarget
```

The generator creates the receiver before the handwritten override introduces `<EventMap>`. Cloning that generated receiver into the override preserves the raw owner name but not the override's type arguments.

This is a declaration correctness failure. It weakens receiver specificity and prevents inherited global extraction from producing `EventTarget<WorkerGlobalScopeEventMap>` reliably.

### 2. Inherited global extraction still uses stale pre-transform declarations

The failed snapshot also produced a receiver-free extracted `addEventListener()` and omitted the generated static `detachable()` global entirely.

The global transformer resolves inherited declarations through the checker created before override merging. A helper can add a receiver to a legacy override member that it sees, but it cannot recover generated members that do not exist in the original override source.

The implementation needs either:

- a rebuilt program/checker after overrides; or
- a transformed declaration map used by global inheritance traversal.

### 3. Explicit custom receivers are widened by the global transform

The current global helper preserves `this: void`, but widens every other explicit receiver to:

```ts
CustomReceiver | typeof globalThis | null | void
```

That violates the required rule that an explicit custom receiver remains unchanged. The transform must distinguish a generated owning receiver from an explicit override receiver, either through comparison with the declaration owner or explicit receiver provenance/policy.

### 4. Owner-only `self.fetch` is now a confirmed blocker

Bunyan's native matrix removes the remaining uncertainty. The interface method must be widened as well as the extracted global declaration. A revision that leaves `ServiceWorkerGlobalScope.fetch(this: ServiceWorkerGlobalScope, ...)` owner-only is incorrect even if bare `fetch` is typed properly.

### 5. Override behaviour must remain in the focused CI target set

The prototype modifies override merging, so `//types:test/transforms/overrides/index.spec` is mandatory. A green generator/global run alone is not enough.

## Non-blocking lint limitations

These are tooling limits, not blockers for Rook's declaration implementation:

- `@typescript-eslint/unbound-method` catches extraction from `self.fetch`, including assignments, object literals, callback arguments, and widening.
- It does not catch the same receiver erasure when the source is the bare ambient identifier `fetch`.
- It reports legal destructuring of `self.fetch` because the explicit receiver is a union rather than exactly `void`.
- Contextual widening of either `fetch` or `self.fetch` into `PlainFetch` erases the receiver contract. Tess's narrow typed prototype catches selected bare-global erasures, but production use still needs generated provenance or a tightly bounded host-symbol allowlist.
- Neither lint rule can repair an incorrect generated receiver or owner type. Generator and transform tests remain authoritative for all blocking cases.

No TypeScript or typescript-eslint issue should be opened from these results.
