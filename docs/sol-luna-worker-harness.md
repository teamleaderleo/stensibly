# Sol→Luna worker harness

- **Issue:** #1663
- **Prior implementation:** #1661
- **Audit:** Palisade post-merge findings on #1661

## Purpose

`scripts/sol-luna-worker.ts` runs one disposable Codex ("Luna") worker turn for a
Sol commander inside a target repository. It refuses API-key authentication,
delivers a canonical brief on stdin as raw argv-only process data, retains
bounded structured evidence, and publishes a truthful receipt even when the
worker hangs, dies early, floods its output pipes, or fails mid-run.

```bash
bun run sol-luna:worker -- \
  --repository /path/to/worktree \
  --brief brief.md \
  --output-schema worker-result.schema.json \
  --output-dir /path/to/evidence \
  --run-id sol-luna-2026-08-25-01 \
  --assigned-role "implementation worker" \
  [--sandbox read-only|workspace-write] \
  [--confinement permission-profile|legacy-sandbox] \
  [--edit-authority read-only|workspace-write] \
  [--git-metadata-authority none|write] \
  [--reasoning-effort low|medium|high|xhigh|max] \
  [--codex-bin codex] \
  [--timeout-ms 600000] \
  [--capture-cap-bytes 8388608]
```

The harness is deliberately local and disposable. One run owns one output
directory; see [Lifecycle rules](#lifecycle-rules).

## Lifecycle rules

1. **Run-start clearing.** Before any launch, the harness removes its managed
   artifact names (`stdout.jsonl`, `stderr.log`, `worker-result.json`,
   `receipt.json`) and every `.sol-luna-worker-tmp-*` temporary file from the
   output directory. Cleanup must succeed before launch; an unreadable directory
   or undeletable managed artifact fails the run before a child starts. Unmanaged
   files are left untouched.
2. **Atomic receipt publication.** The final receipt is written to a
   same-directory `.sol-luna-worker-tmp-*` file and then renamed onto
   `receipt.json`. Observers never see a partially written receipt, and failed
   publications clean their temporary file before surfacing the error.
3. **Single-run directories.** Treat each output directory as owned by one run.
   Concurrent runs sharing one directory race on managed names and are not
   supported.
4. **Absence is truthful.** Because artifacts are cleared at start and the
   receipt is published last, a crashed run leaves no receipt rather than a
   previous run's success.

## Timeout and process-tree termination

- `--timeout-ms` (default `600000`, ten minutes) bounds **each spawned Codex
  invocation**: the authentication preflight and the worker execution are
  bounded independently by the same value.
- On expiry the harness sends `SIGTERM` to the child's whole **process group**
  (the child is spawned detached, so it is its own group leader), waits a fixed
  750 ms grace period, then escalates to `SIGKILL` for the same group. This
  reaps children that ignore `SIGTERM` and descendants they spawned. The direct
  child is waited on and reaped before the capture resolves.
- A timed-out run still parses partial stdout, still retains bounded output
  artifacts and Git evidence, and writes a receipt with
  `child.outcome: "timeout"`, `child.timedOut: true`, and `success: false`.
  The CLI exits `124` (GNU timeout convention).
- Process groups require Unix semantics. On platforms without them the harness
  falls back to signalling only the direct child; this fallback is best-effort,
  and the supported targets are macOS and Linux.

## Stdin delivery observation

The brief is delivered in 64 KiB chunks honoring pipe backpressure. Delivery is
fully observed; a child that exits without draining the brief can never produce
an unhandled `EPIPE` rejection or contradict the receipt:

- `child.stdinOutcome: "delivered_without_error"` — all bytes were handed to
  the child's stdin pipe without an observed error.
- `child.stdinOutcome: "child_closed_stdin_early"` — writing observed a broken
  pipe because the child closed its stdin before consuming the brief. This is
  recorded as a benign note in `child.stdinDetail` (the OS error code, e.g.
  `EPIPE`); it does not fail the run. The child's own exit code governs the
  outcome.
- `child.stdinOutcome: "not_started"` — no child was launched, or spawn failed
  before any stdin existed.

Caveat: bytes that fit inside the OS pipe buffer can be absorbed after a child
exits without ever producing an error, so `"delivered_without_error"` means "no
delivery error was observed", not proof the child consumed the brief.

## Bounded output retention

- `--capture-cap-bytes` (default `8388608`, 8 MiB) caps retained bytes **per
  stream** for stdout and stderr. Coordinator memory stays bounded no matter how
  hostile the child's output volume is.
- Retention keeps a deterministic head window plus a deterministic tail window
  of at most half the cap each, snapped outward to complete-line boundaries
  where possible. The beginning (thread/session events) and the end (final
  result and usage events) therefore survive truncation.
- Truncation is disclosed exactly in the receipt:
  - `artifacts.stdoutJsonl.truncated` / `artifacts.stderr.truncated`
  - `artifacts.*.fullOutputBytes` — total bytes the child produced;
  - `artifacts.*.omittedBytes` — bytes not retained;
  - `artifacts.*.bytes` and `sha256` describe the retained artifact on disk.
- JSONL parsing runs over the retained text. Lines cut by retention bounds fail
  JSON parsing and are skipped deliberately; the raw retained stdout remains
  the authoritative artifact.
- Each artifact is retained independently. Receipt metadata is published only
  after that file's write succeeds; a failed retention is represented by
  `null` and a specific `harnessError`, while successfully retained sibling
  artifacts remain available.
- Child execution and harness evidence remain orthogonal when both fail. A
  non-zero child stays `child.outcome: "worker_failed"` while the retention
  defect remains in `harnessError`; `success` is false and the harness exits
  `1` rather than reusing the child's exit code. The receipt therefore preserves
  both causes instead of collapsing one into the other.

## Git evidence and causality

The receipt records content-aware working-tree activity, every descendant
commit, and head movement:

| Field | Meaning |
| --- | --- |
| `git.headBefore` / `git.headAfter` | Resolved `HEAD` before the preflight and after the child exits (`null` when unreadable). |
| `git.headRelationship` | `unchanged`, `descendant`, `non_descendant`, or `unknown`; commit attribution is admitted only for descendants. |
| `git.dirtyPathsBefore` | Working-tree changes including untracked files present before the run. |
| `git.dirtyPathsAfter` | Same snapshot taken after the run. |
| `git.workerCreatedDirtyPaths` | Dirty paths whose staged diff, unstaged diff, or worktree object identity differs between the two valid snapshots. This includes changes to paths that were already dirty and paths cleaned during the run. |
| `git.commitsMade` | Descendant commits created between the two heads, in oldest-first order. Empty unless ancestry is established. |
| `git.committedPaths` | Union of paths touched by each commit in `commitsMade`; an add followed by a revert remains visible. Renames list both old and new names. |
| `git.baselineContaminatedCommittedPaths` | Committed paths that were already dirty before the run; their byte authorship is uncertain. |
| `git.changedPaths` | **Observed path activity:** `committedPaths ∪ workerCreatedDirtyPaths`. This is activity evidence, not exclusive authorship of bytes. |

Pre-existing worktree dirt stays visible in the before/after lists. Content
fingerprints distinguish an unchanged dirty path from one the worker actually
modified, including staged-plus-unstaged state. Exact restoration to the
baseline state is intentionally invisible unless commit history records it. A
path committed during the run remains in `committedPaths`, but baseline
contamination is explicit and no exclusive byte authorship is claimed. If
either Git snapshot is unreadable, working-tree attribution is empty and the
failure appears in `harnessError`; causality is never guessed.

## Receipt schema example

`schemaVersion: "sol-luna-worker-receipt/2"`. Field-level notes:

- `preflight.exitCode` is the raw `codex login status` exit code; a timed-out
  preflight reports `null` and fails closed through `harnessError`.
- `child.exitCode` is `null` when the child was killed or never ran;
  `child.signal` carries the terminating signal name (for example `SIGKILL`)
  when one was delivered.
- `child.outcome` precedence: `timeout`, then non-zero child exit
  (`worker_failed`), then any harness fault (`harness_failed`), then
  `not_started`, then `worker_succeeded`.
- `success` is `true` only for `worker_succeeded`: ChatGPT-authenticated
  preflight, zero child exit, a parsed structured result, successful artifact
  retention, and successful atomic receipt publication. Any other state writes
  a truthful failing receipt instead.

```json
{
  "schemaVersion": "sol-luna-worker-receipt/2",
  "run": { "id": "sol-luna-2026-08-25-01", "assignedRole": "implementation worker" },
  "repository": "/absolute/path/to/worktree",
  "sandbox": "workspace-write",
  "preflight": {
    "command": ["codex", "login", "status"],
    "exitCode": 0,
    "chatGptAuthenticated": true
  },
  "git": {
    "headBefore": "f933a72d8b5f9296d81a5f51b0403bcaeba44795",
    "headAfter": "95748b009896267810c60da95a1fc50492043bb2",
    "headRelationship": "descendant",
    "dirtyPathsBefore": [],
    "dirtyPathsAfter": ["notes/untracked-scratch.md"],
    "workerCreatedDirtyPaths": ["notes/untracked-scratch.md"],
    "commitsMade": ["95748b009896267810c60da95a1fc50492043bb2"],
    "committedPaths": ["src/feature.ts"],
    "baselineContaminatedCommittedPaths": [],
    "changedPaths": ["src/feature.ts", "notes/untracked-scratch.md"]
  },
  "child": {
    "commandShape": {
      "executable": "codex",
      "args": ["exec", "--ephemeral", "--json", "--model", "gpt-5.6-luna",
               "--config", "model_reasoning_effort=\"max\"", "--sandbox",
               "workspace-write", "--cd", "<repository>", "--output-schema",
               "<output-schema>", "-"],
      "stdin": "canonical-brief"
    },
    "exitCode": 0,
    "signal": null,
    "timedOut": false,
    "outcome": "worker_succeeded",
    "stdinOutcome": "delivered_without_error",
    "stdinDetail": null
  },
  "codex": {
    "sessionOrThreadId": "thread-01",
    "threadId": "thread-01",
    "tokenUsage": { "input_tokens": 21, "cached_input_tokens": 4,
                    "output_tokens": 13, "total_tokens": 34 }
  },
  "artifacts": {
    "stdoutJsonl": {
      "path": "/evidence/stdout.jsonl",
      "bytes": 4096,
      "sha256": "sha256:…",
      "truncated": false,
      "fullOutputBytes": 4096,
      "omittedBytes": 0
    },
    "stderr": {
      "path": "/evidence/stderr.log",
      "bytes": 0,
      "sha256": "sha256:…",
      "truncated": false,
      "fullOutputBytes": 0,
      "omittedBytes": 0
    },
    "finalWorkerResult": {
      "path": "/evidence/worker-result.json",
      "bytes": 512,
      "sha256": "sha256:…"
    }
  },
  "success": true,
  "harnessError": null
}
```

A timeout receipt instead carries, for example:
`"exitCode": null`, `"signal": "SIGKILL"`, `"timedOut": true`,
`"outcome": "timeout"`, `"success": false`, plus whatever partial stdout,
thread ID, usage, and Git evidence existed at termination.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Worker succeeded; receipt says `success: true`. |
| Child's code | Child exited non-zero with no harness fault. |
| `124` | Wall-clock timeout expired. |
| `1` | Any other failing outcome (auth refusal, missing result, artifact or Git failures, killed child). |
| `2` | CLI misuse (invalid or missing arguments); also used when receipt publication itself throws. |

The process exit code and the receipt can never contradict each other: the
receipt is published before the exit code is chosen, stdin errors cannot crash
the run, and a failed receipt publication aborts with exit code `2` rather than
reporting success.

## Authentication and spawning contract

- ChatGPT-only enforcement: `codex login status` must report
  ChatGPT authentication, mention no API key, and exit `0`; ambiguous output
  mentioning both fails closed.
- All spawns use argv arrays. No shell interpolation exists anywhere; hostile
  repository/brief/schema paths reach Codex as data values.
- The harness constructs child environments from an explicit allowlist; it does
  not inherit arbitrary parent variables. The worker shell itself uses
  `inherit="none"` with an isolated single-run `HOME` and `TMPDIR`.
- `permission-profile` is the default confinement. It mechanically denies
  network access, sibling repositories, the target repository's writes, Git
  metadata writes, and the durable evidence directory. It is therefore a
  read/review/research and patch-as-data profile on the current macOS host, not
  a direct-edit profile. Durable evidence must live outside both the repository
  and system temp.
- `legacy-sandbox` remains explicit for direct workspace edits. The separate
  edit authority declaration is preflighted before launch. The current Codex
  `workspace-write` sandbox mechanically protects Git metadata, as confirmed by
  the Run 03G discriminator, so both confinement modes reject
  `--git-metadata-authority write` instead of promising a capability the child
  cannot exercise. Git activity is still observed if an out-of-contract or
  concurrent actor moves the head; authority is never inferred from that
  evidence.
- A successful worker result is provisional. The receipt's `integration`
  object remains `not_adjudicated` until Sol settles the promised integration
  gates at the exact semantic head.
