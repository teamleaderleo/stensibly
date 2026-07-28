## Tess — TypeScript and ESLint matrix complete

I tested the proposed receiver-aware global declaration against TypeScript 5.8.3, ESLint 10.7.0, and typescript-eslint 8.65.0 across assignments, object literals, destructuring, callback parameters, widening, `.bind`, and `.call`.

### Reproducible branch evidence

- matrix and analysis: https://github.com/teamleaderleo/stensibly/blob/research/issue-474-lane-b/docs/research/issue-474-lane-b/eslint-matrix.md
- 22-case fixture: https://github.com/teamleaderleo/stensibly/blob/research/issue-474-lane-b/docs/research/issue-474-lane-b/receiver-eslint-matrix.fixture.ts
- pinned `unbound-method` output: https://github.com/teamleaderleo/stensibly/blob/research/issue-474-lane-b/docs/research/issue-474-lane-b/eslint-observed.json
- four-case custom-rule output: https://github.com/teamleaderleo/stensibly/blob/research/issue-474-lane-b/docs/research/issue-474-lane-b/custom-rule-observed.json
- custom-rule prototype: https://github.com/teamleaderleo/stensibly/blob/research/issue-474-lane-b/docs/research/issue-474-lane-b/no-receiver-erasure.rule.mjs

Observed toolchain:

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

The compiler exits 0 with all expected rejections guarded by `@ts-expect-error`.

### TypeScript result

With:

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

TypeScript catches:

- unrelated property calls while the precise receiver-aware type is retained (`TS2684`);
- inferred object-literal properties later called through the wrong owner (`TS2684`);
- destructured precise values later moved to an unrelated holder (`TS2684`);
- `.bind({})` and `.call({}, ...)` under `strictBindCallApply` (`TS2345`).

TypeScript accepts and erases the receiver when the target is a plain callback type:

```ts
this.fetchImpl = fetch;
const x: PlainFetch = fetch;
acceptsPlain(fetch);
const x: { fetchImpl: PlainFetch } = { fetchImpl: fetch };
```

The same erasure occurs from `workerGlobal.fetch` into a plain callback target.

Legal detached, bound, and called forms compile:

```ts
const { fetch: detached } = workerGlobal;
detached(input);
fetch.bind(undefined);
fetch.bind(null);
fetch.bind(workerGlobal);
fetch.call(undefined, input);
fetch.call(null, input);
fetch.call(workerGlobal, input);
```

### Existing `@typescript-eslint/unbound-method`

The pinned rule emitted six diagnostics at fixture lines 40, 58, 64, 69, 81, and 92. It catches owner-member extraction in:

- `this.fetchImpl = workerGlobal.fetch`;
- inferred and contextually typed object literals;
- destructuring;
- callback arguments;
- explicit widening variables.

It emits no diagnostic for bare ambient `fetch`, so these four receiver-erasure cases remain uncovered:

```ts
this.fetchImpl = fetch;
const x: { fetchImpl: PlainFetch } = { fetchImpl: fetch };
acceptsPlain(fetch);
const f: PlainFetch = fetch;
```

It also reports one legal form: destructuring `workerGlobal.fetch` and invoking the detached value as a bare function. The rule treats only an exact syntactic `this: void` as safe; `this: void | null | Owner` is classified as receiver-dependent.

Relevant rule source:

- visitor scope (`MemberExpression` and `ObjectPattern`): https://github.com/typescript-eslint/typescript-eslint/blob/v8.65.0/packages/eslint-plugin/src/rules/unbound-method.ts#L252-L319
- exact `this: void` test: https://github.com/typescript-eslint/typescript-eslint/blob/v8.65.0/packages/eslint-plugin/src/rules/unbound-method.ts#L383-L409
- direct-call / chained-member safe-use logic: https://github.com/typescript-eslint/typescript-eslint/blob/v8.65.0/packages/eslint-plugin/src/rules/unbound-method.ts#L411-L459
- rule docs: https://typescript-eslint.io/rules/unbound-method/

### Smallest custom rule

The minimal complement visits bare identifier **value references** only:

1. Resolve the source expression type through typed parser services.
2. Find a call signature whose explicit `this` includes an owning, non-nullish constituent.
3. Read the expression's contextual type from the TypeScript checker.
4. Report when the contextual callable omits the owning receiver.
5. Skip property keys, member names, declaration identifiers, direct calls, uncontextualized inference, receiver-aware targets, and `.bind` / `.call` chains.

The refined prototype emits exactly four diagnostics:

```text
line 35  this.fetchImpl = fetch
line 54  contextually typed object-literal value
line 78  acceptsPlain(fetch)
line 87  const widenedBare: PlainFetch = fetch
```

Those are precisely the bare-global erasures missed by `unbound-method`.

Typed custom-rule APIs used here are documented at https://typescript-eslint.io/developers/custom-rules/.

For production, add a narrow provenance guard: generated `@receiverSensitive` metadata, machine-readable RTTI metadata, or a small Worker-host symbol allowlist. The signature-only prototype proves mechanics but would be too broad as a general application rule.

### Recommendation

1. Generate `this: void | null | OwningGlobalType` for global `fetch`, and `this: OwningType` for ordinary receiver-sensitive methods.
2. Keep `unbound-method` for ordinary methods; treat global-fetch destructuring as a known false positive.
3. Add the contextual receiver-erasure rule only after Cloudflare exposes receiver-sensitive metadata or Stensibly adopts a very small host-symbol allowlist.
4. Keep the arrow wrapper and native-`workerd` regression test.
5. Open no TypeScript or typescript-eslint upstream issue from this result. The remaining upstream target is Cloudflare declaration generation/metadata.
