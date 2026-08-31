# Pi Luna worker harness

`pi-luna:worker` runs one durable Pi 0.84.4 Luna/max worker behind a typed local boundary. Codex remains the visible commander and final adjudicator.

The Pi host process receives the explicitly selected `PI_CODING_AGENT_DIR` only after `pi auth check --provider openai-codex --json` reports `ready` with OAuth. The model receives six tools: bounded read, bounded search, typed Git observation, repository-scoped mutation, fixed verification by command ID, and a terminating structured result. Built-in tools, generic shell, discovered extensions/skills/templates/themes, and context files are disabled.

```bash
bun run pi-luna:worker -- \
  --repository /home/leo/Projects/worktrees/owned-task \
  --brief /absolute/task/brief.md \
  --output-dir /absolute/evidence/task-01/attempt-1 \
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
  --read-only-mount /absolute/main-checkout/.git \
  --verification-command 'tests=["/usr/bin/python3","-m","unittest","path/to/test.py"]' \
  --verification-command 'diff-check=["/usr/bin/git","diff","--check"]'
```

The output directory is an immutable attempt identity and must not already contain managed artifacts. A retry gets `attempt-2`; it never clears `attempt-1`. `receipt.json` records the exact Pi version/provider/model/effort, OAuth class, session/resume identity, tool allowlist, OS boundary and mounts, bounded streams, incremental provider usage, tool counts, Git before/after evidence, timeout outcome, and provisional structured result.

On Linux, `bwrap` is the admitted unattended mode. It gives model-visible child processes an empty home, no network, a writable admitted repository, read-only system/tool mounts, and only coordinator-declared verification argv. Linked worktrees need their main repository `.git` directory mounted read-only so typed Git observations and `git diff --check` can follow the worktree `gitdir`/`commondir` pointers. Do not mount Pi agent/auth state.

`--os-boundary none` is explicit rather than a silent fallback. It keeps the no-generic-shell and fixed-command contract, but repository code executed by verification retains the Pi user's filesystem authority; record that residual limitation and use it only where the repository trust decision permits.

Pi sessions live under the attempt directory and use a deterministic UUID unless `--session-id` is supplied. The receipt contains the exact resume command and identity. External process/background state is not claimed to survive; Git and the session transcript are the durable boundary.

Supervise fleets with `bun run worker:glance`, which reads only bounded receipts/results and emits one shared root with compact relative rows. Inspect raw event streams or worker prose only for a targeted ambiguity. Worker success remains provisional until the commander reviews the actual diff and required verification evidence.
