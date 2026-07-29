# Service activity ingestion boundary

The aggregate contract intentionally counts every normalized observation supplied to it.
It does not deduplicate transport deliveries and it does not retain request IDs, trace IDs,
provider log IDs, or source cursors inside an activity bucket.

That separation is required for both accuracy and privacy.

## Exactly-once accounting

A later ingestion implementation must reconcile duplicate delivery before calling the
aggregate functions. The durable write path should atomically:

1. validate one server-owned source delivery identity or bounded source cursor;
2. prove that delivery has not already contributed to an aggregate;
3. normalize the content-minimised observation;
4. update the matching activity bucket;
5. record the delivery as consumed.

If the transaction is retried, the same source identity must return the original
consumption result without incrementing the bucket again. A changed payload under the
same source identity must fail closed.

The source identity belongs in a separate, access-controlled ingestion receipt or
short-lived deduplication table. It must not become:

- an aggregate dimension;
- a dashboard field;
- an MCP response field;
- a retained raw request log;
- a replacement for the bounded Worker, release, or manifest identities already in the
  aggregate contract.

## Ambiguous delivery

When an ingestion response is lost after commit, the producer must reconcile the source
identity before retrying. Blindly resubmitting the same observation would be counted
again because the pure aggregate helper cannot distinguish a legitimate second request
from duplicate delivery of the first request.

## Retention

Ingestion receipts should have an explicit bounded retention period long enough to cover
expected retries and source redelivery. Hour/day rollups do not require the raw delivery
identity after the deduplication window closes.

This boundary keeps accounting truthful without putting private per-request identifiers
into durable operator telemetry.
