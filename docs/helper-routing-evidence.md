# Project workstation receipts into routing research

The read-only projection consumes existing `glaeda_workstation_adapter_result`
JSON from `GlaedaWorkstationAdapterV1`. Supply one result or an array of at most
128 results (1 MiB total); short runner CLI status summaries do not contain the
command/check/source identities needed for this projection.

```sh
bun scripts/helper-routing-evidence.ts < adapter-results.json > research-evidence.json
python3 /path/to/cultist/scripts/helper_routing_evidence.py research-evidence.json
```

The output follows Cultist's `cultist-helper-routing-evidence/v1` contract. Each
record represents incomplete evidence about a parent work/source identity and retains the work/run reference,
command fingerprint, source commit/tree, and physical result digest. Duplicate
parent work/source identities are refused, including distinct commands or runs, so
multiple checks cannot inflate the task count. The reader
validates the existing command/check/receipt contracts and their matching identities;
it does not fetch referenced objects or prove the provenance of supplied JSON.

Successful named verification supplies `verified: true`; a failed named
verification supplies `false`. Query success does not prove verification. Refusal,
timeout, cleanup failure, and absent receipts retain unknown verification/process
outcomes. Process completion of the parent work always remains unknown; the receipt
only establishes a particular command's outcome. Settlement-only replay does not
reconstruct missing physical evidence. `verified` describes only the named check,
not all checks required by the parent task.

Acceptance, provider success, routing/classification, retries, repair effort, and
whole-task usage remain unknown. These execution receipts carry no canonical
source-work acceptance decision. Even successful verification cannot fill that gap.
Physical elapsed time is not substituted for total task wall time. The next richer
projection must bind any acceptance or usage receipt to the same exact work/source
before filling those fields.

The command performs no dispatch, provider reads, or ledger writes. The optional
output file is a derived research artifact, not another owner of work state.
