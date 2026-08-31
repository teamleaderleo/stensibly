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

Create a runner-audience credential in the protected Stensibly operator environment. The command
registers only the token hash, writes the one-time credential directly to a new absolute file with
mode `0600`, and prints only the non-secret token record:

```sh
bun run tokens create-runner -- \
  --name big-red-glaeda \
  --project glaeda \
  --actor-id service:big-red-glaeda \
  --runner-type glaeda-workstation \
  --adapter-id glaeda-workstation \
  --profiles repo-query/v1 \
  --output-file /protected/runner-credentials/big-red-glaeda.token
```

The grant has exactly `write` scope for one project and an explicit actor, runner type, adapter,
profile list, and the four tools used by this one-shot runner (claim, transition, reserve, settle).
It does not grant heartbeat or recovery. Ordinary API/MCP endpoints reject it. The runner endpoint
rejects another actor, runner type, profile, adapter, tool, or project before dispatch. Use the
owner-only token file and do not put the token on the command line or in logs:

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

## Rotation, revocation, and recovery

For Big Red, `.github/workflows/provision-owned-workstation-runner.yml` is the protected delivery
surface. Mint accepts only a non-secret one-time RSA public key and its DER SHA-256 fingerprint,
creates the exact runner grant inside the `production` environment, and uploads an immutable
one-day artifact containing ciphertext plus non-secret token metadata. Decrypt only on Big Red into
the final owner-only token path. The same workflow revokes one exact `tok_` ID without handling a
raw token.

List token records in the protected operator environment with `bun run tokens list`; the token ID,
grant, creation time, and revocation time are safe control metadata, while the raw token is never
recoverable from Stensibly. To rotate, create a new credential at a fresh owner-only path, verify one
authenticated runner refusal/claim probe, switch the one-shot runner to that path, then run
`bun run tokens revoke <old-token-id>`. To recover from a lost or suspect file, revoke its retained
token ID and mint a successor; never copy a value out of logs, process listings, GitHub, or chat.
Credential rotation changes runner authentication only. Existing Stensibly run, reservation,
settlement, and replay identities remain canonical and do not authorize duplicate physical work.
