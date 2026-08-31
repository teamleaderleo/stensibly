# Owned Glaeda workstation runner

This is the thin `repo-query/v1` bridge for Stensibly issue #1762. Stensibly remains the owner of
work, context, dispatch, authority, replay, and settlement. Glaeda admits and executes one exact
physical operation. Git/GitHub provide immutable source and fallback request/result transport.

The bridge deliberately has no daemon-owned queue, workstation table, or GitHub mailbox lifecycle.
One invocation claims one already-dispatched Stensibly run and exits with one bounded control
receipt.

## Exact work contract

The Stensibly item context must contain exactly one commit artifact with this metadata:

```json
{
  "schema": "glaeda-repo-query-request/v1",
  "requestId": "owned-workstation-...",
  "requestCommitOid": "<complete Git commit OID>",
  "requestDigest": "sha256:...",
  "transportGeneration": "sha256:...",
  "profileGeneration": "sha256:...",
  "sourceRepository": "owner/repository",
  "sourceCommitOid": "<complete Git commit OID>",
  "sourceTreeOid": "<complete Git tree OID>"
}
```

Its artifact URI must be the immutable request commit URL:

```text
https://github.com/teamleaderleo/glaeda-dispatch/commit/<requestCommitOid>
```

The run must already be dispatched as:

```text
runner type:     glaeda-workstation
runner profile:  repo-query/v1
profile version: <the exact profileGeneration above>
```

The runner maps that project-level contract onto either `big-red` (`linux`/`x86_64`) or `air-blue`
(`macos`/`arm64`). Node generation, capability snapshot digest, and Glaeda runtime digest remain
physical-node facts; changing them does not change the repository query vocabulary.

## One-shot launch

Use an owner-only Stensibly machine-token file (`0600`) and do not put the token on the command
line or in logs:

```sh
bun run glaeda:workstation -- \
  --project stensibly \
  --run-id '<exact-run-id>' \
  --token-file '<owner-only-token-file>' \
  --canary-script '<glaeda-dispatch-checkout>/big_red_canary.py' \
  --profile-generation 'sha256:...' \
  --node-id big-red \
  --node-generation 1 \
  --capability-snapshot 'sha256:...' \
  --glaeda-runtime 'sha256:...' \
  --os-class linux \
  --architecture x86_64
```

For Air Blue, use the same run/profile semantics with `--node-id air-blue --os-class macos
--architecture arm64` and that node's own exact generations.

## Authority and restart behavior

The runner performs this bounded sequence:

```text
claim exact Stensibly run
-> enter running state under its generation/lease fence
-> check exact request/source/profile/runtime on the physical node
-> reserve the existing workstation adapter command
-> execute only when the reservation authorizes first dispatch
-> settle the exact bounded Glaeda receipt
-> succeed the Stensibly run with an immutable result-commit URL
```

If a fresh process sees an unsettled reservation, it never interprets replay as permission to run
again. It asks Glaeda to reconcile the exact published result. Glaeda verifies the result commit's
parent, closed tree, unchanged request blob, canonical byte bound, source/profile/runtime bindings,
and stable remote ref without invoking `repo-query`. A valid result settles the original command;
a missing result leaves the run waiting for reconciliation.

For the physical response-loss exercise, run the first process with
`--simulate-response-loss-after-consume`. It publishes the exact result, deliberately hides that
one successful response, and exits. Start a new ordinary process with identical node/run inputs;
it must reconcile and settle the published result without invoking `repo-query` again.

The result reference stored on the run is immutable:

```text
https://github.com/teamleaderleo/glaeda-dispatch/commit/<resultCommitOid>
```

The terminal Stensibly receipt contains no repository patch, credentials, host paths, environment,
or arbitrary process output. The result commit is the separately inspectable bounded evidence.

## Security boundary

- The Stensibly machine token may claim/reserve/settle only its allowed project/run surface.
- The Glaeda controller revalidates exact local source, tree, binary, and profile facts.
- `repo-query/v1` is observation-only and cannot encode shell, argv, environment, path, fetch, or
  publication behavior.
- Source-executing profiles require a separate execution identity and are not added by this bridge.
- A GitHub request/result ref is fallback transport evidence, never work or redispatch authority.
