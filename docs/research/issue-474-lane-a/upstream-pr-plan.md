# Draft upstream PR plan: preserve JSG receiver requirements in generated TypeScript

Target repository: `cloudflare/workerd`

Status: implementation planning only. No upstream branch or pull request has been opened.

## Goal

Make generated Worker declarations reflect receiver requirements already enforced by JSG and V8, while preserving legal Worker-global calls and leaving runtime behavior unchanged.

The patch should answer two related cases separately:

1. ordinary non-static JSG methods, where `this: OwningType` is the direct declaration;
2. methods extracted into free Worker globals, where the top-level copy needs a receiver union that accepts bare/null/global calls.

## Entry conditions

Before implementation begins:

- run the full generated Worker declarations through a compile fixture;
- settle the TypeScript type that represents the legal Worker global receiver;
- confirm `globalThis.fetch(...)` compiles in the actual generated model;
- select representative JSG methods for compatibility testing;
- agree whether the first patch is generator-wide or limited to a small API set.

The current candidate for globals remains provisional. An isolated fixture accepts:

```ts
this: ServiceWorkerGlobalScope | null | void
```

A closer model of Cloudflare's extracted globals may also require `typeof globalThis` or a generated helper alias. The complete output must decide this before the PR claims a final signature.

## Likely files

Primary candidates:

- `types/src/generator/structure.ts`
- `types/src/transforms/globals.ts`
- `types/test/transforms/globals.spec.ts`
- generator snapshot tests under `types/test/`
- a new compile fixture for receiver-aware declarations

Possible later files:

- `src/workerd/jsg/rtti.h`
- `src/workerd/jsg/rtti.capnp`
- RTTI generated bindings and tests

The initial generator-only patch should avoid the RTTI files unless parent context proves insufficient.

## Phase 0: executable declaration fixture

Create a fixture that consumes generated declarations and compiles a receiver matrix with `--strict` and `--strictBindCallApply`.

### Ordinary method cases

Using a known receiver-sensitive API such as `crypto.getRandomValues`:

```ts
crypto.getRandomValues(array); // accept

const detached = crypto.getRandomValues;
detached(array); // reject

detached.call(crypto, array); // accept
detached.call({}, array); // reject

({ method: crypto.getRandomValues }).method(array); // reject
```

The exact API may need an override during the fixture stage if its generated declaration has special transforms.

### Global fetch cases

```ts
fetch(url); // accept
globalThis.fetch(url); // accept
self.fetch(url); // accept

const detached = fetch;
detached(url); // accept

detached.call(undefined, url); // accept
detached.call(null, url); // accept
detached.call(globalThis, url); // accept

detached.call({}, url); // reject
({ fetch: detached }).fetch(url); // reject
```

Also cover:

```ts
Reflect.apply(fetch, globalThis, [url]); // accept
Reflect.apply(fetch, undefined, [url]); // accept
Reflect.apply(fetch, null, [url]); // accept
Reflect.apply(fetch, {}, [url]); // reject

fetch.bind(globalThis)(url); // accept
fetch.bind(undefined)(url); // accept
fetch.bind(null)(url); // accept
fetch.bind({})(url); // reject
```

### Widening case

Record the known TypeScript escape explicitly:

```ts
type PlainFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const widened: PlainFetch = fetch;
({ fetch: widened }).fetch(url); // currently compiles
```

This fixture documents the limit without making receiver-preserving assignability a requirement for the first PR.

## Phase 1: ordinary JSG methods

### Candidate generator change

In `createMethodPartial()`, prepend a TypeScript `this` pseudo-parameter for non-static methods:

```ts
this: FullyQualifiedParentName
```

Conceptually:

```ts
if (!method.static) {
  params.unshift(createThisParameter(fullyQualifiedParentName));
}
```

The real implementation should use TypeScript factory nodes and the generator's existing name-resolution helpers.

### Inclusion boundary

Include:

- ordinary non-static resource methods registered through the normal JSG method path.

Exclude initially:

- static methods;
- constructors;
- properties and accessors;
- callable resources;
- iterator call signatures unless their runtime receiver behavior is confirmed;
- handwritten overrides that already control their own declaration.

### Inheritance decision

Test both choices:

- declaring owner type;
- generated leaf/parent context supplied to `createMethodPartial()`.

The runtime signature is tied to the JSG resource template and supports inherited templates. The declaration should choose the least restrictive type that still rejects unrelated holders.

A base owner often gives useful substitutability:

```ts
method(this: BaseResource, ...)
```

A leaf owner can become unnecessarily strict when the same method is inherited. Generator fixtures should settle this with one real hierarchy.

### Phase 1 tests

Add snapshots proving:

- instance methods include the `this` parameter;
- static methods remain unchanged;
- overridden declarations remain stable;
- inheritance produces the selected owner type;
- existing visible parameter counts and return types remain unchanged.

Add compile fixtures proving accepted and rejected calls.

## Phase 2: Worker global extraction

### Preserve strict interface members

The `ServiceWorkerGlobalScope` interface member should retain the ordinary owning receiver:

```ts
interface ServiceWorkerGlobalScope {
  fetch(
    this: ServiceWorkerGlobalScope,
    input: RequestInfo | URL,
    init?: RequestInit<RequestInitCfProperties>,
  ): Promise<Response>;
}
```

### Widen only the free global copy

`globals.ts` currently copies `node.parameters` directly when it converts a method into a top-level `declare function`.

Change the extraction path so the first `this` parameter is replaced or widened only for free global functions.

Conceptual result:

```ts
declare function fetch(
  this: WorkerGlobalReceiver | null | void,
  input: RequestInfo | URL,
  init?: RequestInit<RequestInitCfProperties>,
): Promise<Response>;
```

`WorkerGlobalReceiver` is a placeholder for the type chosen by the full fixture.

### Candidate receiver encodings

Evaluate in order:

#### A. Owning interface union

```ts
ServiceWorkerGlobalScope | null | void
```

Simple and close to the runtime model. It may reject `globalThis.fetch(...)` in the complete generated declaration model.

#### B. Include typeof globalThis

```ts
ServiceWorkerGlobalScope | typeof globalThis | null | void
```

Preserves the direct call set in a minimal extracted-global fixture. It may introduce recursive or unstable global typing.

#### C. Generated helper interface

Generate a small receiver interface or alias that captures the members needed to identify the actual Worker global without referring back to the complete `globalThis` type.

This can avoid recursion while preserving `globalThis.fetch(...)`. It needs enough specificity to reject ordinary holders.

#### D. Context-global marker metadata plus transform-owned alias

Teach the global transform that these methods are context-global and generate one shared receiver alias for all extracted methods.

This carries more generator work and may be cleaner if many globals share the same rule.

### Global inheritance

`extractGlobalNodes()` recursively visits superclasses. The transform must widen receiver parameters for inherited global methods as well as methods declared directly on `ServiceWorkerGlobalScope`.

Test examples from:

- `WorkerGlobalScope`;
- `EventTarget` methods copied into globals;
- `ServiceWorkerGlobalScope` direct methods such as `fetch` and `btoa`.

Receiver semantics may differ across inherited APIs. A blanket transform should begin only after representative runtime checks confirm they share the context-global rule.

## Phase 3: compatibility audit

Run generated declarations against representative internal fixtures and known Worker idioms.

### Expected safe patterns

```ts
fetch(url);
globalThis.fetch(url);
self.fetch(url);
crypto.getRandomValues(array);
```

### Expected new diagnostics

```ts
const holder = { fetch };
holder.fetch(url);

class Client {
  fetchImpl = fetch;
  run() {
    return this.fetchImpl(url);
  }
}

const random = crypto.getRandomValues;
random(array);
```

### Deliberate adapters

Verify clear repairs:

```ts
const request = (input, init) => globalThis.fetch(input, init);
const random = crypto.getRandomValues.bind(crypto);
```

Check `.call(owner)` and `.bind(owner)` with `--strictBindCallApply`.

### Ecosystem sampling

Search representative Worker repositories or existing workerd tests for:

- detached Web API methods;
- stored ambient globals;
- generic callback containers receiving JSG methods;
- helper libraries that intentionally preserve a receiver later.

Classify each new error as:

- current runtime-invalid code;
- valid code needing a more accurate annotation;
- false positive caused by an overly narrow owner type;
- TypeScript limitation outside the initial patch.

## Phase 4: RTTI metadata decision

Proceed only when the generator-only approach lacks enough information or another consumer needs receiver semantics.

Possible schema:

```capnp
enum ReceiverPolicy {
  none @0;
  owningType @1;
  contextGlobal @2;
}

struct Method {
  # existing fields
  receiverPolicy @5 :ReceiverPolicy;
}
```

Possible owner representation:

- derive owner from the enclosing `Structure`;
- add an explicit owner reference only for cases that differ from the enclosing type.

Consumers:

- TypeScript generator;
- global extraction transform;
- future typed lint metadata;
- declaration or documentation generators outside the current TypeScript path.

Costs:

- Cap'n Proto schema update;
- builder changes;
- generated code refresh;
- more test cases;
- a wider review packet.

## Alternative proof path: narrow override

When generator scope remains uncertain, use a handwritten override for one API.

Candidate goals:

- prove `Crypto.getRandomValues` diagnostics for an ordinary method;
- prove `fetch` direct-call behavior for an extracted global;
- measure downstream source compatibility.

This path offers a small demonstration and should remain temporary because duplicated signatures can drift.

## Review checklist

### Correctness

- Does every generated `this` type match current runtime behavior?
- Are static methods unchanged?
- Do inherited methods use the correct owner?
- Do all legal Worker-global forms compile?
- Do unrelated holders fail?
- Does the generated file avoid circular aliases?

### Runtime boundary

- Is all runtime code unchanged?
- Does the patch add zero JavaScript parameters at runtime?
- Do existing workerd receiver tests remain green?

### Compatibility

- Which existing generated-type tests changed?
- Which downstream idioms gain errors?
- Are runtime-valid adapters still expressible through `.bind`, `.call`, or wrappers?
- Does an opt-in transition provide value, or would it prolong inaccurate declarations?

### Maintenance

- Is the receiver rule derived from one source?
- Can overrides preserve custom signatures?
- Does the global transform avoid duplicating method-specific knowledge?
- Is the known widening escape documented?

## Suggested commit sequence

1. `types: add receiver compile fixtures`
2. `types: emit owning this for non-static JSG methods`
3. `types: preserve legal receivers for extracted globals`
4. `types: add compatibility and inheritance coverage`
5. optional: `jsg: expose receiver policy in RTTI`

Keeping the fixture first makes the intended behavior reviewable before generator code changes.

## Verification commands

Exact commands depend on workerd's current build setup. The PR description should include:

```console
# type generator unit tests
npm test -- <relevant types test target>

# generated declaration snapshots
npm test -- <generator snapshot target>

# strict compile fixture
tsc --strict --strictBindCallApply --noEmit <receiver fixture>

# relevant workerd runtime tests
bazel test <receiver-sensitive runtime targets>
```

Use repository-native commands discovered from the current workerd checkout rather than treating these placeholders as final.

## Rollback and fallback

The patch changes generated declarations only. Recovery options are straightforward:

- revert the generator change;
- retain the compile fixture as documentation;
- reduce scope to a narrow override;
- split ordinary methods from globals into separate PRs;
- defer RTTI metadata.

A split PR sequence may make review easier:

1. ordinary non-static methods;
2. context-global extraction;
3. metadata/tooling, if earned.

## Out of scope

- modifying JSG/V8 receiver enforcement;
- making global fetch receiver-independent;
- adding a TypeScript language feature;
- enforcing receiver provenance after every function-type widening;
- introducing nominal brands across all Worker APIs;
- changing Stensibly production code in the upstream patch.

## Upstream issue dependency

This plan should follow a maintainer-reviewed issue that confirms:

- generated receiver fidelity is desired;
- the initial API scope;
- the global receiver representation;
- the source-compatibility release approach.

Draft issue: [`upstream-issue-draft.md`](./upstream-issue-draft.md)

— Kestrel · bounded implementation plan for issue 474 Lane A
