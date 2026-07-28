# Tess: TypeScript and ESLint receiver matrix

Status: executable research fixture. No upstream issue or PR opened.

## Toolchain

Observed in GitHub Actions on Ubuntu:

```text
node v22.23.1
typescript 5.8.3
eslint 10.7.0
typescript-eslint 8.65.0
```

Commands:

```console
npx --no-install tsc -p tsconfig.eslint.json --pretty false
npx --no-install eslint receiver-eslint-matrix.fixture.ts --format json
npx --no-install eslint --config eslint.custom.config.mjs \
  receiver-eslint-matrix.fixture.ts --format json
```

The compiler command exits 0. Every intended compiler rejection is guarded by `@ts-expect-error`.

Fixture: [`receiver-eslint-matrix.fixture.ts`](./receiver-eslint-matrix.fixture.ts)

Observed outputs:

- [`tsc-observed.txt`](./tsc-observed.txt)
- [`eslint-observed.json`](./eslint-observed.json)
- [`custom-rule-observed.json`](./custom-rule-observed.json)

## Declaration under test

```ts
interface WorkerGlobalReceiver {
  fetch(
    this: void | null | WorkerGlobalReceiver,
    input: string,
  ): Promise<string>;
}

type ReceiverAwareFetch = WorkerGlobalReceiver["fetch"];
declare const fetch: ReceiverAwareFetch;
```

`PlainFetch` deliberately omits the receiver:

```ts
type PlainFetch = (input: string) => Promise<string>;
```

## Matrix

Legend:

- **accept**: no diagnostic and the form is intentional.
- **TS2684 / TS2345**: compiler catches the receiver error.
- **erase**: TypeScript accepts because assignment/contextual typing removes the explicit receiver.
- **report**: lint rule reports.
- **false positive**: lint reports a call form accepted by the proposed declaration and current runtime matrix.

| ID | Form | TypeScript 5.8.3 | `unbound-method` 8.65.0 | Tess prototype |
| --- | --- | --- | --- | --- |
| T01 | bare `fetch(input)` | accept | none | none |
| T02 | `workerGlobal.fetch(input)` | accept | none | none |
| T03 | `{ fetch }.fetch(input)` with precise inferred type | TS2684 | none | none |
| T04 | `this.fetchImpl = fetch` where target is `PlainFetch` | erase | none | **report** |
| T05 | `this.fetchImpl = workerGlobal.fetch` where target is `PlainFetch` | erase | **report** | none; existing rule covers member source |
| T06 | inferred `{ fetchImpl: fetch }`, then property call | TS2684 at call | none | none |
| T07 | contextually typed `{ fetchImpl: fetch }` as `PlainFetch` | erase | none | **report** |
| T08 | inferred `{ fetchImpl: workerGlobal.fetch }`, then property call | TS2684 at call | **report** | none |
| T09 | contextually typed `{ fetchImpl: workerGlobal.fetch }` as `PlainFetch` | erase | **report** | none |
| T10 | `const { fetch: detached } = workerGlobal; detached(input)` | accept | **report — false positive** | none |
| T11 | destructured precise value moved to unrelated holder | TS2684 at call | report already emitted at destructuring | none |
| T12 | `acceptsPlain(fetch)` | erase | none | **report** |
| T13 | `acceptsPlain(workerGlobal.fetch)` | erase | **report** | none |
| T14 | `acceptsAware(fetch)` | accept; receiver preserved | none | none |
| T15 | `const f: PlainFetch = fetch` | erase | none | **report** |
| T16 | `const f: PlainFetch = workerGlobal.fetch` | erase | **report** | none |
| T17 | `fetch.bind(undefined/null/workerGlobal)` | accept | none | none |
| T18 | `fetch.bind({})` | TS2345 | none | none |
| T19 | `workerGlobal.fetch.bind(workerGlobal)` | accept | none | none |
| T20 | `fetch.call(undefined/null/workerGlobal, input)` | accept | none | none |
| T21 | `fetch.call({}, input)` | TS2345 | none | none |
| T22 | `workerGlobal.fetch.call(workerGlobal, input)` | accept | none | none |

## Existing `unbound-method` result

The pinned rule emitted six diagnostics, at fixture lines 40, 58, 64, 69, 81, and 92:

- member assignment into a plain callback;
- member values in inferred and contextually typed object literals;
- destructuring from the owner;
- passing an owner member as a plain callback argument;
- widening an owner member into a plain callback variable.

It emitted no diagnostics for bare ambient `fetch` identifiers. That leaves T04, T07, T12, and T15 uncovered.

The destructuring diagnostic at T10 is a false positive for this global declaration. `unbound-method` treats only an exact syntactic `this: void` parameter as safe. `this: void | null | Owner` is classified as receiver-dependent even though a detached bare call supplies an accepted receiver.

Direct calls and chained `.bind` / `.call` uses receive no lint diagnostic. TypeScript performs the useful receiver check for `.bind` and `.call` under `strictBindCallApply`.

## Smallest complementary rule

Prototype: [`no-receiver-erasure.rule.mjs`](./no-receiver-erasure.rule.mjs)

The minimum useful rule does not duplicate `unbound-method`. It visits **bare identifier value references** and reports only when contextual typing erases an owning receiver:

1. Resolve the source expression type with typed parser services.
2. Find a call signature whose explicit `this` type contains an owning, non-nullish constituent.
3. Ask the TypeScript checker for the expression's contextual type.
4. Report when the contextual callable has no explicit owning receiver—missing `this`, or a receiver composed only of `void`, `undefined`, `null`, `any`, `unknown`, or `never`.
5. Ignore property keys, member names, declarations, direct calls, inference without a contextual target, receiver-aware callback parameters, and `.bind` / `.call` chains.

The refined prototype emits exactly four diagnostics:

```text
line 35  this.fetchImpl = fetch
line 54  contextually typed object-literal value
line 78  acceptsPlain(fetch)
line 87  const widenedBare: PlainFetch = fetch
```

Those are precisely the bare-global erasure cases missed by `unbound-method`.

### Production scoping

The proof-of-mechanics prototype recognizes receiver-sensitive sources by their call signature. A production rule should add one narrow provenance guard:

- a generated JSDoc/RTTI marker such as `@receiverSensitive`;
- generated machine-readable metadata; or
- a small symbol-identity allowlist for Worker host functions.

That guard avoids reporting application APIs that intentionally adapt a receiver-aware function into a plain callback.

## Limitations

- Type assertions, `any`, JavaScript files, and deliberate `OmitThisParameter` can still bypass both declaration and lint checks.
- `unbound-method` is declaration-syntax-sensitive and over-reports legal extraction for the mixed global receiver union.
- The complementary rule covers contextual receiver erasure. Extending it to assertions or return-value adaptation requires additional visitors and increases false-positive risk.
- Runtime parity coverage remains necessary because generated declarations or host metadata can be incomplete.

## Recommendation

1. Generate the accurate explicit receiver declaration: `this: void | null | OwningGlobalType` for global `fetch`; `this: OwningType` for ordinary receiver-sensitive methods.
2. Keep `@typescript-eslint/unbound-method` for ordinary object methods. Treat its global-fetch destructuring diagnostic as a known false positive.
3. Add the small contextual-erasure rule only when generated receiver-sensitive metadata or a tightly bounded host-symbol allowlist is available.
4. Keep the application arrow wrapper and native-`workerd` regression test as the final safety net.
5. Open no TypeScript or typescript-eslint upstream issue from this result. The remaining work belongs primarily in Cloudflare declaration generation/metadata and local enforcement.
