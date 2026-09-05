# Local verify intent admission

Compiles one current `verify` `local_action_intent/v1` into one
`GlaedaWorkstationCommandV1` for the existing
`GlaedaWorkstationAdapterV1` reservation/execution/receipt/settlement path
(Stensibly #1834, `verify` slice).

```sh
bun scripts/local-action-verify-admission.ts < admission-request.json > workstation-command.json
```

`admission-request.json` carries `{intent, current}`:

- `intent`: a `local_action_intent/v1` input with `actionClass: "verify"` and a
  reviewed `profileId` (`verify-focused/v1` or `verify-required/v1`).
- `current`: dispatch-time facts re-read before dispatch — project, item ID and
  claim generation, run ID and run/lease generations, authority holder and
  expiry, exact node, exact source commit/tree plus task workspace generation,
  and the current reviewed profile generation.

## What it checks

- intent is unexpired and authority-compatible; stale item, claim, project,
  repository, commit/tree, or workspace generation refuses;
- only the two reviewed verification profiles compile; any other `profileId`
  refuses as unsupported policy;
- `measurement` latency and `quiet_required` interference refuse until their
  dedicated admissions are wired;
- the intent resource profile must equal the named profile's own resource class
  (no synthesized limits);
- the intent deadline must cover the named profile's worst-case deadline;
- verify cannot carry an overlay artifact.

The emitted command binds `profileRequestSha256` to the exact physical
verification request the Glaeda client enforces, and derives a deterministic
`commandId`/`idempotencyKey` so exact replay returns the identical command
identity (the adapter settles it once). Publication, merge, and redispatch
authority are unchanged: the command, like every adapter result, authorizes no
work or effects.

The command performs no dispatch, provider reads, or ledger writes. Feed its
output to the existing workstation reservation path.
