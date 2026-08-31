# Pi Luna worker harness

`pi-luna:worker` runs one durable Pi 0.84.4 Luna/max worker behind a typed local boundary. Codex remains the visible commander and final adjudicator.

The Pi host process receives the explicitly selected `PI_CODING_AGENT_DIR` only after `pi auth check --provider openai-codex --json` reports `ready` with OAuth. The model receives six tools: bounded read, bounded search, typed Git observation, repository-scoped mutation, fixed verification by command ID, and a terminating structured result. Built-in tools, generic shell, discovered extensions/skills/templates/themes, and context files are disabled.

```bash
bun run pi-luna:worker -- \
  --repository /home/leo/Projects/worktrees/owned-task \
  --brief /absolute/task/brief.md \
  --output-dir /absolute/evidence/task-01/attempt-1 \
  --session-dir /absolute/task-state/task-01/pi-session \
  --run-id task-01-attempt-1 \
  --assigned-role implementation-worker \
  --pi-bin /absolute/pinned/pi \
  --pi-agent-dir /absolute/private/pi-agent-state \
  --timeout-ms 1800000 \
  --capture-cap-bytes 8388608 \
  --edit-authority workspace-write \
  --os-boundary bwrap \
  --bwrap-bin /usr/bin/bwrap \
  --verification-path /usr/bin:/bin \
  --verification-command 'tests=["/usr/bin/python3","-m","unittest","path/to/test.py"]' \
  --verification-command 'diff-check=["/usr/bin/git","diff","--check"]'
```

The output directory is an immutable attempt identity and must not already contain managed artifacts. A retry gets `attempt-2`; it never clears `attempt-1`. `receipt.json` records the exact Pi version/provider/model/effort, OAuth class, session/resume identity, tool allowlist, OS boundary and effective mounts, bounded streams, incremental provider usage, tool counts, Git before/after evidence, timeout outcome, and provisional structured result. Pi's usage `cost` field is an estimated API-price equivalent, not evidence of billed spend under subscription authentication.

On Linux, `bwrap` is the admitted unattended mode. It gives model-visible child processes an empty home, no network, a writable admitted repository, read-only system/tool mounts, and only coordinator-declared verification argv. The runner resolves the admitted repository's Git common directory before Pi starts and automatically adds it as a read-only mount, including for linked worktrees. Retain `--read-only-mount` for other coordinator-declared dependencies. Do not mount Pi agent/auth state.

`--os-boundary none` is explicit rather than a silent fallback. It keeps the no-generic-shell and fixed-command contract, applies no OS containment or read-only mounts, and leaves repository code executed by verification with the Pi user's filesystem authority; record that residual limitation and use it only where the repository trust decision permits.

Without `--session-dir`, Pi sessions live under each attempt as `.pi-session`. For durable retries, set `--session-dir` to the same existing or creatable real directory outside the admitted repository and attempt evidence, and use the same `--session-id` while giving every attempt a new `--output-dir`. Session paths may not contain symlink components. The runner creates only the session directory; it does not copy or expose provider credentials. The receipt contains the exact resume command and identity. External process/background state is not claimed to survive; Git and the session transcript are the durable boundary.

Supervise fleets with `bun run worker:glance`, which reads only bounded receipts/results and emits one shared root with compact relative rows. Inspect raw event streams or worker prose only for a targeted ambiguity. Worker success remains provisional until the commander reviews the actual diff and required verification evidence.
