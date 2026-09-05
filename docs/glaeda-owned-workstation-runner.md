# Owned Glaeda workstation runner

This is the thin `repo-query/v1` bridge for Stensibly issue #1762. Stensibly remains the owner of
work, context, dispatch, authority, replay, and settlement. Glaeda admits and executes one exact
physical operation. Git/GitHub provide immutable source and fallback request/result transport.

The bridge deliberately has no daemon-owned queue, workstation table, or GitHub mailbox lifecycle.
One invocation claims one already-dispatched Stensibly run and exits with one bounded control
receipt.

`repo-query/v1` retains the immutable glaeda-dispatch request/result pair as its proven bootstrap
and recovery transport. `verify-focused/v1` does not add another mailbox round trip. Its one commit
artifact directly binds the exact GitHub source commit/tree, profile generation, `big-red-focused`
resource class, 600-second deadline, `credentialless_project` identity, and canonical request
digest. The existing Stensibly run plus workstation command reservation remains its only work and
replay authority.

On Big Red, the fixed Glaeda profile materializes only the exact shallow commit, bounds that source
to 512 MiB/100,000 entries, and executes repository-owned `scripts/verify focused`. Bubblewrap
provides a read-only source, private PID/user/network/mount namespaces, disabled nested user
namespaces, a cleared allowlisted environment, no network, and read-only package/toolchain inputs.
Writable build, Cargo-home, project-home, and temporary state are size-bounded tmpfs mounts inside
an 8 GiB/4 CPU/512 task systemd service with a 600-second runtime ceiling. Source output is bounded
to 1 MiB in a private pipe; the terminal receipt retains only bytes and digest. Source code receives
no runner/control token, publisher credential, SSH agent, sudo/admin authority, or unrelated
writable project.

The Glaeda command state publishes one private canonical receipt before returning. An exact
Stensibly settlement-response loss reserves the same command and a fresh one-shot process invokes
Glaeda with `--reconcile-only`; a matching receipt settles without source execution. Missing or
ambiguous physical state refuses redispatch.

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

The same item context must also contain exactly one bounded physical capability artifact:

```json
{
  "kind": "other",
  "uri": "urn:stensibly:glaeda-capability:sha256:<snapshot digest>",
  "metadata": {
    "schema": "glaeda-owned-workstation-capability-artifact/v1",
    "snapshotSha256": "sha256:<snapshot digest>",
    "snapshot": {
      "schema": "glaeda-owned-workstation-capability/v1",
      "advisoryOnly": true,
      "authorizesDispatch": false,
      "authorizesExecution": false,
      "observedAt": "<canonical UTC timestamp>",
      "expiresAt": "<no more than 300 seconds after observation>",
      "node": {
        "id": "big-red",
        "generation": 1,
        "osClass": "linux",
        "architectureClass": "x86_64"
      },
      "producer": {
        "glaedaRuntimeSha256": "sha256:...",
        "workspaceCapabilitySha256": "sha256:...",
        "python": { "version": "3.14.4", "executableSha256": "sha256:..." }
      },
      "profiles": [
        { "id": "repo-query/v1", "class": "repo_query", "versionSha256": "sha256:..." }
      ],
      "projects": [{
        "repository": "teamleaderleo/glaeda",
        "source": { "commitOid": "<40 hex>", "treeOid": "<40 hex>" },
        "sourceObjectClass": "exact_commit_and_tree_present",
        "heatClass": "resident_hot",
        "verificationProfiles": ["glaeda.doctor", "glaeda.required"]
      }],
      "admission": {
        "availabilityClass": "available",
        "activeWorkloadsClass": "unobserved",
        "pressureClass": "unobserved"
      }
    }
  }
}
```

The digest covers canonical JSON plus one trailing newline, matching Glaeda's generator. The
snapshot is at most 4096 bytes and is primary Stensibly task context, not a new workstation table
or coordination ledger. A GitHub copy may mirror evidence but is never required for admission.
The runner refuses missing, duplicate, stale, future, unavailable, authority-bearing, or
generation-drifted snapshots. It also resolves and hashes the node-local Python executable and
revalidates the exact source, profile, Glaeda runtime, and physical node before reserving a command.
The capability observation is advisory evidence only; Stensibly dispatch plus the existing command
reservation remains authority for physical work.

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
  --project '<exact-project>' \
  --actor-id service:big-red-glaeda \
  --runner-type glaeda-workstation \
  --adapter-id glaeda-workstation \
  --profiles repo-query/v1,verify-focused/v1 \
  --output-file /protected/runner-credentials/big-red-glaeda.token
```

The grant has exactly `write` scope for one project and an explicit actor, runner type, adapter,
profile list, and the four tools used by this one-shot runner (claim, transition, reserve, settle).
It does not grant heartbeat or recovery. Ordinary API/MCP endpoints reject it. The runner endpoint
rejects another actor, runner type, profile, adapter, tool, or project before dispatch. Use the
owner-only token file and do not put the token on the command line or in logs:

```sh
bun run glaeda:workstation -- \
  --project '<exact-project>' \
  --run-id '<exact-run-id>' \
  --token-file '<owner-only-token-file>' \
  --python-interpreter '/usr/bin/python3.14' \
  --canary-script '<glaeda-dispatch-checkout>/big_red_canary.py' \
  --profile-generation 'sha256:...' \
  --node-id big-red \
  --node-generation 1 \
  --glaeda-runtime 'sha256:...' \
  --os-class linux \
  --architecture x86_64
```

For Air Blue, use the same run/profile semantics with `--node-id air-blue --os-class macos
--architecture arm64`, `--python-interpreter /opt/homebrew/opt/python@3.14/bin/python3.14`, and
that node's own exact generations. The launcher resolves the configured absolute path, probes it
before touching the request, and refuses every runtime except Python 3.14.x. Interpreter selection
is a node mechanic and belongs in the capability generation; it does not alter project semantics.

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

For both nodes, `.github/workflows/provision-owned-workstation-runner.yml` is the protected delivery
surface. Mint selects exactly one recipient (`big-red` or `air-blue`) and one project (`glaeda`,
`stensibly`, or the bounded `quarry` repo-query pilot), accepts only that node's non-secret one-time RSA public key and DER SHA-256
fingerprint, creates a runner grant with the matching service actor inside the `production`
environment, and uploads an immutable one-day artifact containing ciphertext plus non-secret token
metadata. Decrypt only on the selected node into its final owner-only token path. The credential's
project must match the item/run it will claim; it never grants multiple projects. Quarry credentials
grant only `repo-query/v1`; they do not inherit Glaeda's source-executing profiles. The same workflow
revokes one exact `tok_` ID without handling a raw token.

When a connected client cannot yet call the hosted control surface directly, the same workflow can
mint `ephemeral_control`: one selected-project `read,write` token sealed to a separate one-time key.
Use it only in controller/publication logic, never the source-running process, and revoke its exact
token ID as soon as the bounded dispatch/attachment operation is complete. It does not inherit the
runner grant and is not physical execution authority.

List token records in the protected operator environment with `bun run tokens list`; the token ID,
grant, creation time, and revocation time are safe control metadata, while the raw token is never
recoverable from Stensibly. To rotate, create a new credential at a fresh owner-only path, verify one
authenticated runner refusal/claim probe, switch the one-shot runner to that path, then run
`bun run tokens revoke <old-token-id>`. To recover from a lost or suspect file, revoke its retained
token ID and mint a successor; never copy a value out of logs, process listings, GitHub, or chat.
Credential rotation changes runner authentication only. Existing Stensibly run, reservation,
settlement, and replay identities remain canonical and do not authorize duplicate physical work.
