# Atlas follow-up: exact global receiver union

The coordinator and runtime lanes added two useful corrections after the original Lane B report.

## Updated receiver declaration

For exact parity with the observed V8/Web IDL call set, the global declaration should include `null` as well as the bare-call and owning-global cases:

```ts
type ReceiverAwareFetch = (
  this: void | null | OwningGlobalType,
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
```

The original `this: void | OwningGlobalType` result remains sufficient for ordinary bare calls and owner-property calls. Adding `null` covers the explicit `fetch.call(null, input)` form accepted after V8 converts a nullish receiver to the realm global before applying the JSG-installed receiver signature.

Compile fixture: [`null-receiver.fixture.ts`](./null-receiver.fixture.ts)

Validated with:

```console
tsc --version
# Version 5.8.3

tsc --strict --noEmit --pretty false --lib ES2022 \
  docs/research/issue-474-lane-b/null-receiver.fixture.ts
# exit 0; expected failures use @ts-expect-error
```

## Cross-lane runtime evidence

Current `workerd` accepts:

- a bare `fetch(input)` call;
- `globalThis.fetch(input)` and `self.fetch(input)`;
- a detached `fetch` called normally;
- `.call(undefined, input)`, `.call(null, input)`, and `.call(globalThis, input)`.

It rejects `.call({}, input)` and a raw native fetch invoked through an unrelated holder property with an illegal-invocation `TypeError`.

Bun 1.3.14 and Node accept the unrelated-holder forms, while Chromium and `workerd` reject them. That confirms the value of the existing wrapper and a native-`workerd` regression test.

Issue evidence:

- runtime matrix: https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110331378
- Atlas verification and extraction caveat: https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110454396
- V8 nullish-receiver conversion note: https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110465204
- Bun/runtime-parity conclusion: https://github.com/teamleaderleo/stensibly/issues/474#issuecomment-5110410658

## Repository decision

A TypeScript fork is unnecessary. TypeScript already supports the required explicit receiver union, and the remaining widening escape follows existing function assignability semantics.

The likely upstream code target is Cloudflare's `workerd` repository because the proposed change concerns JSG receiver metadata and generated Worker declarations. Forking `workerd` can wait until the coordinator settles the exact owner type and chooses between a narrow declaration override, a generator fixture, or a broader metadata change.
