# Worker glance

`worker:glance` is the hot supervision projection for a commander supervising
many disposable workers. It reads only bounded `receipt.json` and
`worker-result.json` files from the supplied run directories. It never opens
`stdout.jsonl`, `stderr.log`, transcripts, command output, or arbitrary files.

```bash
bun run worker:glance -- \
  --root /absolute/evidence-root \
  /absolute/evidence-root/run-a \
  /absolute/evidence-root/run-b
```

The command emits one minified `worker-glance/1` JSON object. The absolute
`root` is declared once; `receipt` and `result` in each row are relative
canonical pointers. Rows are sorted by their relative run directory. A missing
receipt is reported as `state: "missing"`, `success: null`, and
`blocker: "receipt_missing"`; it never becomes a guessed success or running
state. A receipt is the terminal boundary for the current
`sol-luna-worker-receipt/3` and `pi-luna-worker-receipt/1` contracts.
Unrecognized future schemas use explicit `unknown` fields and
`unknown_schema`.

Each row contains only bounded run identity/role, backend and state, receipt
success/provisional state, Git path and commit counts, a few changed paths,
derived token usage, result status, verification count/pass classification, a
short blocker code, and relative evidence pointers. `changedPathsOmitted`,
`omittedRows`, and `truncated` make every projection omission explicit. The
default output ceiling is 4,000 characters; `--max-rows`, `--max-paths`, and
`--max-output-chars` can make a commander’s local view smaller but cannot raise
the safety ceilings.

Pi reports uncached input, cache reads, and cache writes as separate additive
fields. The glance normalizes them to total prompt input (`input + cacheRead +
cacheWrite`), cached input (`cacheRead`), and uncached input (`input +
cacheWrite`). It rejects a Pi receipt whose declared `totalTokens` does not
equal prompt input plus output; missing usage remains unknown rather than zero.

The intended loop is:

1. Launch many workers, each with its own evidence directory.
2. Run `worker:glance` over the evidence directories.
3. Inspect only the relative receipt/result pointers for failed, incomplete, or
   ambiguous rows; keep cold logs and transcripts out of the commander’s hot
   context.
