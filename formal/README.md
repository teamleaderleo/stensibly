# Formal models

This directory contains small executable models for coordination invariants that are difficult to cover completely with example-based tests.

The models do not define product behavior by themselves. Source contracts, implementation tests, and runtime evidence remain authoritative. A useful counterexample should become a focused implementation regression or a documented no-change decision.

## Cancellation settlement

`CancellationSettlement.tla` models the first settlement slice from #574 and #954:

- one authoritative close operation;
- two callers that may wait, cancel their wait, rejoin, or repeat close after settlement;
- three independently settling owned children, including results produced before close;
- explicit reconciliation after partial failure;
- preservation of successful child identities after aggregate failure;
- fencing of a prior generation;
- admission of one replacement generation;
- attempted late publication by the prior generation.

Run the safe model with a pinned TLC distribution:

```text
java -cp tla2tools.jar tlc2.TLC \
  -config formal/CancellationSettlement.cfg \
  formal/CancellationSettlement.tla
```

The safe configuration checks type, authority, admission, settlement, visibility, fencing, stale-publication, repeated-close, and terminal-result invariants.

Two intentionally unsafe configurations demonstrate why replacement admission must wait for settlement or fencing and why an unfenced prior generation must not publish after replacement admission:

```text
java -cp tla2tools.jar tlc2.TLC \
  -config formal/CancellationSettlementUnsafeFence.cfg \
  formal/CancellationSettlement.tla

java -cp tla2tools.jar tlc2.TLC \
  -config formal/CancellationSettlementUnsafe.cfg \
  formal/CancellationSettlement.tla
```

`CancellationSettlementWitnesses.tla` and its four configurations prove required schedules are reachable by using deliberately false “witness absent” invariants:

- a successful child before close remains visible after aggregate failure;
- a failure before close can lead to reconciliation;
- the same caller can observe the same terminal result from repeated close;
- a caller can cancel its first wait and later retry after settlement.

A proof receipt should record the exact model/config blobs, TLC release and checksum, Java runtime, commands, exit codes, generated/distinct state counts, and counterexample or witness trace digests. The canonical repository CI does not currently pin TLC, so formal execution remains a separate exact-ref proof step and is not implied by ordinary TypeScript test success.
