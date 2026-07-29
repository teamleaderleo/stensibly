# Tess — Kestrel next-revision regression plan

Status: test preparation complete; fork-branch review pending the first receiver implementation commit in `teamleaderleo/workerd`.

Prepared artifacts:

- [`kestrel-next-regression-tests.patch`](./kestrel-next-regression-tests.patch): test-only delta for the workerd fork.
- [`generated-receiver-eslint-matrix.fixture.ts`](./generated-receiver-eslint-matrix.fixture.ts): the original 22 TypeScript/ESLint cases using Kestrel's generated declaration shape.
- Existing typed ESLint and receiver-erasure configurations now run against both the abstract fixture and the generated-shape fixture.

## Required workerd regression cases

The test patch makes these behaviours explicit:

| Requirement | Test location | Required output |
| --- | --- | --- |
| Legacy override without `this` | override-transform method fixture | inherits `this: Root1` |
| Every overload inherits the receiver | three `get()` override overloads | every overload contains `this: Root1` |
| Explicit `this: void` | `receiverFree()` override | remains exactly `this: void` |
| Explicit custom receiver | `customReceiver()` override and global transform | remains exactly `this: CustomReceiver` |
| Static generated method | existing static `one()` / `two()` paths and global `detachable()` | no explicit `this` |
| Generic owner | `Root1<R>` type-parameter fixture | generated and inherited receivers use `Root1<R>`, not raw `Root1` |
| Inherited owner | `EventTarget<EventMap>` extracted through `WorkerGlobalScopeEventMap` | receiver uses `EventTarget<WorkerGlobalScopeEventMap>` |
| `self.fetch` runtime parity | generated fetch fixture | bare/self/global/detached, `call`, `apply`, and `bind` accept nullish/global/self receivers and reject `{}` |

The override-transform test target must be included in focused CI:

```console
bazelisk test \
  //types:test/index.spec \
  //types:test/transforms/overrides/index.spec \
  //types:test/transforms/globals.spec \
  //types:test/types/fetch-receiver \
  --test_output=errors
```

## Blocking correctness issues in the current prototype

### 1. Generic owner parameters are currently lost

The latest focused unit run produced:

```diff
- this: EventTarget<EventMap>
+ this: EventTarget
```

The generator creates the receiver before the handwritten override introduces `<EventMap>`. Cloning that generated receiver into the override preserves the raw owner name but not the override's type arguments.

This is a declaration correctness failure. It weakens receiver specificity and also prevents the inherited global transform from producing `EventTarget<WorkerGlobalScopeEventMap>` reliably.

### 2. Inherited global extraction still uses stale pre-transform declarations

The failed snapshot also produced a receiver-free extracted `addEventListener()` and omitted the generated static `detachable()` global entirely.

The global transformer resolves inherited declarations through the checker created before override merging. A helper can add a receiver to a legacy override member that it sees, but it cannot recover generated members that do not exist in the original override source.

The implementation needs either:

- a rebuilt program/checker after overrides; or
- a transformed declaration map used by global inheritance traversal.

The currently preserved `workerd-receiver-types-inherited-global.patch` is not included in the prototype workflow's patch application list, and even that patch only repairs missing receivers on visible members; it does not recover generated-only inherited members.

### 3. Explicit custom receivers are widened by the global transform

The current global helper preserves `this: void`, but it widens every other explicit receiver to:

```ts
CustomReceiver | typeof globalThis | null | void
```

That violates the required rule that an explicit custom receiver remains unchanged. The global transform must distinguish a generated owning receiver from an explicit override receiver. Comparing the receiver to the declaration owner, or carrying receiver provenance/policy, would provide that boundary.

### 4. Override behaviour is not in the focused CI target set

The prototype now modifies override merging, but the focused workflows do not run `//types:test/transforms/overrides/index.spec`. The existing method-override fixture contains split overloads and is the most direct place to detect receiver loss.

A green generator/global run is not sufficient until that target is included.

## Non-blocking lint limitations

These are tooling limits, not blockers for Kestrel's declaration implementation:

- `@typescript-eslint/unbound-method` catches extraction from `self.fetch`, including assignments, object literals, callback arguments, and widening.
- It does not catch the same receiver erasure when the source is the bare ambient identifier `fetch`.
- It reports legal destructuring of `self.fetch` because the explicit receiver is a union rather than exactly `void`.
- Tess's narrow typed prototype complements it by finding bare-global contextual receiver erasure, but it still requires generated receiver-sensitive provenance or a small host-symbol allowlist before production use.
- Neither lint rule can repair an incorrect generated owner type. Generator and transform tests remain authoritative for the blocking cases above.

No TypeScript or typescript-eslint issue should be opened from these results.
