# Issue 474 Lane B: TypeScript receiver rules

Status: research draft. This branch changes no production code and opens no upstream work.

## Conclusion

TypeScript 5.8.3 can express the target call set with one explicit union receiver:

```ts
type WorkerFetch = (
  this: void | WorkerGlobalReceiver,
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
```

Given an accurate owning-global type, that signature accepts both legal forms and rejects the unrelated-property form:

```ts
fetch(url);                 // accepted: bare call supplies void
globalThis.fetch(url);      // accepted: owning global is the receiver
holder.fetch(url);          // TS2684 when holder owns the raw host function
```

The remaining gap is receiver erasure. TypeScript permits assigning a receiver-sensitive function to an ordinary callback type. Calls through the widened value then compile because the target type no longer carries a `this` parameter.

## Reproduction

Fixture: [`receiver-rules.fixture.ts`](./receiver-rules.fixture.ts)

Observed command:

```console
$ tsc --version
Version 5.8.3
$ tsc --strict --noEmit --pretty false --lib ES2022 \
    docs/research/issue-474-lane-b/receiver-rules.fixture.ts
# exit 0; expected rejections are guarded with @ts-expect-error
```

Representative diagnostics observed after removing the `@ts-expect-error` lines:

```text
TS2684: The 'this' context of type 'void' is not assignable to method's
        'this' of type 'WorkerGlobalReceiver'.

TS2684: The 'this' context of type '<unrelated holder>' is not assignable
        to method's 'this' of type 'void | WorkerGlobalReceiver'.

TS2684: A union of callable types produces an effective receiver requirement
        of 'void & WorkerGlobalReceiver'.

TS2322: Type 'GlobalFetch' is not assignable to type 'ReceiverSafeFetch';
        the safe-wrapper brand is missing.
```

## Technique matrix

| Declaration technique | Bare call | Owning-global property call | Unrelated property call | Assessment |
| --- | --- | --- | --- | --- |
| `this: OwningType` | rejected | accepted | rejected | Correct for ordinary receiver-sensitive instance methods; too strict for legal bare global calls. |
| `this: void \| OwningType` in one signature | accepted | accepted | rejected | Exact target call matrix. |
| Callable interface with that one signature | accepted | accepted | rejected | Equivalent spelling; no extra power. |
| Separate `this: void` and `this: OwningType` overloads | accepted | accepted | accepted | The `this: void` overload admits the unrelated property call. |
| Intersection of those two callable signatures | accepted | accepted | accepted | Behaves like the overload set at call sites. |
| Union of those two callable signatures | rejected | rejected | rejected | Effective receiver becomes `void & OwningType`; unusable. |
| Empty receiver interface | accepted | accepted | accepted | `{}`-like receiver types are structurally satisfied by the holder. The owner must have distinguishing members or a nominal brand. |
| `ThisType<OwningType>` | accepted | accepted | accepted | Contextual typing marker for object literals; it creates no call-site receiver rule. |
| `ThisParameterType<T>` | n/a | n/a | n/a | Can inspect the receiver union but does not preserve it through assignment. |
| `OmitThisParameter<T>` | accepted | accepted | accepted | Explicitly erases the receiver. |
| Brand attached to the raw host function | accepted while precise | accepted while precise | rejected while precise | The brand and receiver both disappear when widened to a plain callback. |
| Brand attached only to an application-owned wrapper | accepted | accepted | accepted safely | Prevents raw or plain functions from entering a branded sink; the stored value is an arrow wrapper whose receiver is irrelevant. |

## Receiver erasure

This is the language-level escape that declarations alone cannot close:

```ts
type PlainFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

declare const rawFetch: WorkerFetch;

const widened: PlainFetch = rawFetch;
const holder = { fetch: widened };
holder.fetch(url); // accepted
```

Function assignability intentionally allows a source with an explicit `this` parameter to flow into a target that omits it. Assertions, `any`, `OmitThisParameter`, generic callback containers, and ordinary API boundaries can produce the same result.

A raw-function brand records provenance only while consumers retain that exact type. A safe-wrapper brand guards the application boundary instead:

```ts
type ReceiverSafeFetch = PlainFetch & {
  readonly [safeFetchBrand]: true;
};

const safe = makeReceiverSafeFetch(rawFetch); // accepted
const bad: ReceiverSafeFetch = rawFetch;      // TS2322
```

A compilable draft is in [`receiver-safe-fetch.draft.ts`](./receiver-safe-fetch.draft.ts). The existing `HttpGitHubOAuthClient` constructor already performs the essential runtime repair by storing an arrow wrapper for both injected and ambient fetch implementations:

https://github.com/teamleaderleo/stensibly/blob/main/src/hosted-auth.ts#L339-L360

## TypeScript design history

The TypeScript design discussions already cover this problem family:

- `microsoft/TypeScript#15` explicitly calls out that some global/window methods accept arbitrary receivers while others require their owner: https://github.com/microsoft/TypeScript/issues/15
- `microsoft/TypeScript#3694` proposed invocation-site checking for explicit function receivers: https://github.com/microsoft/TypeScript/issues/3694
- `microsoft/TypeScript#6739` implemented function `this` parameters and demonstrates rejected free or wrongly-owned calls: https://github.com/microsoft/TypeScript/pull/6739
- The current handbook documents explicit `this` parameters: https://www.typescriptlang.org/docs/handbook/2/functions.html#declaring-this-in-a-function

The current feature is sufficient for this call matrix. A new TypeScript language proposal would mainly target receiver preservation across widening, which would be broadly breaking and conflict with deliberate callback patterns.

## Typed ESLint coverage

`@typescript-eslint/unbound-method` checks the usual direction: a member method is detached from its owner and later called without the required receiver. This incident uses the inverse direction: a bare ambient function is stored on an unrelated object, and property-call syntax supplies a new receiver.

Rule documentation and implementation:

- https://typescript-eslint.io/rules/unbound-method/
- https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/eslint-plugin/src/rules/unbound-method.ts

A narrow type-aware rule can cover receiver erasure:

1. Visit property initializers, assignment expressions, variable declarations, constructor assignments, and object-literal properties.
2. Resolve the source symbol and source call signatures through parser services and the TypeScript checker.
3. Detect a meaningful explicit receiver, including `void | OwningType` for context-global methods.
4. Resolve the target callback type and report when it omits or broadens away that receiver.
5. Limit initial coverage to known ambient host symbols or generated receiver-sensitive metadata.
6. Allow arrow wrappers, approved wrapper factories, and deliberate `.bind(...)` calls.

A generic version would flag legitimate library adapters that intentionally erase `this`. Scoping by symbol identity or generated metadata keeps false positives bounded. Stensibly currently has no ESLint/typescript-eslint dependency or lint script, so adding a typed rule solely for this case carries meaningful setup cost.

## Recommendation

1. **Declaration:** after Lane A confirms the exact owning-global type, use one `this: void | OwningGlobalType` signature for global `fetch`. Use `this: OwningType` for ordinary receiver-sensitive JSG methods.
2. **Application boundary:** keep the existing arrow wrapper and runtime regression test. Introduce `ReceiverSafeFetch` only when a shared host-capability boundary earns its extra ceremony, or when immediate compile-time rejection of raw assignment is desired.
3. **Lint:** avoid a broad local rule. Pursue a narrow typed rule when Cloudflare can expose receiver-sensitive metadata, or maintain a very small known-host-symbol list.
4. **TypeScript upstream:** open no language proposal. Existing explicit receiver parameters already express the target call set.
5. **Runtime parity:** retain a real workerd test because casts, widening, JavaScript consumers, and inaccurate declarations can bypass compile-time checks.
