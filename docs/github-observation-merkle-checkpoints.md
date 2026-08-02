# GitHub observation Merkle checkpoints

`github-observation-merkle-checkpoint/v1` is a pure, content-minimised checkpoint over an ordered append-only observation ledger. It gives callers two independently verifiable statements:

1. one exact observation identity and semantic fingerprint occupied one exact sequence/index in a named checkpoint;
2. one later checkpoint extends one earlier checkpoint without rewriting the earlier prefix.

It does not prove that GitHub emitted an event, that webhook coverage was complete, that timestamps were honest, that a provider object is current, or that any action is authorised.

## Leaf input

Each admitted leaf contains only:

```text
sequence
observationId
semanticFingerprint
```

Sequences must be positive, contiguous, and ordered inside one checkpoint. Observation IDs are stable content-minimised identities. Semantic fingerprints are lowercase `sha256:` digests produced by the reviewed observation compiler. Raw webhook payloads, issue or comment bodies, patches, logs, credentials, and provider prose never enter this contract.

## Canonical hashing

The algorithm identity is:

```text
sha256-canonical-json-merkle/v1
```

Every hash is SHA-256 over the repository's canonical `stableJson` encoding.

### Leaf

```json
{
  "domain": "stensibly.github-observation-merkle.leaf/v1",
  "ledgerId": "<exact ledger identity>",
  "sequence": 1,
  "observationId": "<stable observation identity>",
  "semanticFingerprint": "sha256:<64 lowercase hex>"
}
```

Binding `ledgerId` in every leaf prevents an otherwise identical history from being substituted across ledgers.

### Node

```json
{
  "domain": "stensibly.github-observation-merkle.node/v1",
  "left": "sha256:<left digest>",
  "right": "sha256:<right digest>"
}
```

Trees use the largest power-of-two split smaller than the current subtree size. This preserves deterministic roots for balanced and odd-sized histories.

### Empty tree

```json
{
  "domain": "stensibly.github-observation-merkle.empty/v1",
  "ledgerId": "<exact ledger identity>"
}
```

## Checkpoint

A checkpoint records:

- version and algorithm;
- exact ledger and compiler identity;
- tree size;
- first and last accepted sequence;
- root digest;
- trusted creation time;
- a deterministic checkpoint fingerprint over every preceding field.

The checkpoint contains no leaves. A producer may persist or publish checkpoints separately from private observation rows.

## Inclusion proof

An inclusion proof contains the exact content-minimised leaf identity, tree position, checkpoint identity, leaf digest, and a bottom-up sibling path. Verification re-hashes the leaf, reconstructs the root, and requires the exact checkpoint fingerprint.

A valid proof means only that the named leaf was committed at that index in that checkpoint.

## Consistency proof

A consistency proof uses the standard prefix-tree audit-path construction: it reconstructs both the earlier root and the later root from a logarithmic sibling path. Verification additionally requires:

- identical ledger, compiler, and algorithm identity;
- nondecreasing checkpoint creation time;
- nonshrinking tree size;
- the same first sequence for nonempty histories;
- exact older and newer checkpoint fingerprints.

An empty checkpoint is a valid prefix of any later checkpoint for the same ledger/compiler. Equal-size checkpoints are consistent only when their roots match.

A valid proof means only that the later committed sequence has the earlier committed sequence as an unchanged prefix. It does not prove the later history is complete.

## Bounds and recovery

The initial pure implementation admits at most 4,096 leaves and at most 64 sibling digests per proof. Inputs require ordinary dense arrays and enumerable data properties; accessors and decorated containers are rejected without getter execution. Returned checkpoints and proofs are deeply frozen.

This module performs no persistence, provider request, public MCP registration, workflow change, or migration. Recovery is deletion or one squash revert. A later hosted design may persist roots and proofs only after separate schema, signing, retention, and disclosure review.
