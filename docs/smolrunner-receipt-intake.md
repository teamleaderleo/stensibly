# Historical SmolRunner v1 receipt intake

The current product is **Glaeda**. See [`glaeda-receipt-intake.md`](glaeda-receipt-intake.md) for the current Stensibly integration boundary.

This path is retained as a compatibility pointer because the original #260 receipt contract and its existing fixtures identify the historical SmolRunner v1 wire generation. Exact producer names, `smolrunner:` reference prefixes, and old fixture bytes remain SmolRunner evidence.

The legacy decoder lives at `src/smolrunner-receipt-intake.ts`. Current product-facing code should enter through `src/glaeda-receipt-intake.ts`, which exposes Glaeda-named aliases while preserving exact SmolRunner v1 decoding. A future Glaeda receipt generation belongs behind an explicit versioned successor contract owned upstream by `teamleaderleo/smolrunner#751`.
