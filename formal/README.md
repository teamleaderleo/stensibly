# Formal models

This directory contains small executable models for coordination invariants that are difficult to cover completely with example-based tests.

The models do not define product behavior by themselves. Source contracts, implementation tests, and runtime evidence remain authoritative. A useful counterexample should become a focused implementation regression or a documented no-change decision.

## Cancellation settlement

`CancellationSettlement.tla` models the first settlement slice from #574 and #954:

- one authoritative close operation;
- two callers that may wait, cancel their wait, or rejoin;
- three independently settling owned children;
- explicit reconciliation after partial failure;
- fencing of a prior generation;
- admission of one replacement generation;
- attempted late publication by the prior generation.

Run the safe model with TLC:

```text
java -cp tla2tools.jar tlc2.TLC \
  -config formal/CancellationSettlement.cfg \
  formal/CancellationSettlement.tla
```

The safe configuration checks the type and lifecycle invariants. The intentionally weakened configuration permits a replacement generation before the prior generation is settled or fenced; TLC should produce a counterexample to `ReplacementRequiresFenceOrSettlement` or `StaleGenerationCannotPublish`:

```text
java -cp tla2tools.jar tlc2.TLC \
  -config formal/CancellationSettlementUnsafe.cfg \
  formal/CancellationSettlement.tla
```

The repository does not yet pin or execute TLC. Until a reviewed toolchain is added, these commands are the required manual proof and the pull request must report whether they were actually run. Pinning and automating TLC belongs in a separate reviewed change after the model and counterexample are accepted.
