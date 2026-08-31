# Sol / Luna / Gemini controlled task comparison

Run this only after the exact task, base source, and all three harnesses are ready. The comparison is an experiment receipt, not a scheduler or work ledger.

Freeze one manifest before the first arm:

```json
{
  "schema": "owned-model-capacity-comparison/1",
  "repository": "owner/name",
  "base_commit": "40-hex Git commit",
  "base_tree": "40-hex Git tree",
  "brief_sha256": "sha256:...",
  "brief_bytes": 0,
  "completion_contract_sha256": "sha256:...",
  "verification_profile": "repository-owned exact profile/revision",
  "node": { "id": "big-red", "generation": 0 },
  "workspace_class": "task-private-git-worktree",
  "permissions": {
    "workspace_read": true,
    "workspace_write": true,
    "network": false,
    "model_shell": false,
    "commit": false,
    "publish": false
  },
  "arms": [
    { "provider": "openai-codex", "model": "gpt-5.6-sol", "effort": "high", "harness": "codex" },
    { "provider": "openai-codex", "model": "gpt-5.6-luna", "effort": "max", "harness": "pi" },
    { "provider": "google-antigravity", "model": "gemini-3.7-flash-high", "effort": "high", "harness": "agy" }
  ]
}
```

Create three new workspaces from the exact commit/tree. Give every arm the identical brief and completion contract bytes. Keep the physical node fixed to Big Red; do not compare a Big Red arm with an Air Blue arm and call the model the cause. Match effective authority rather than UI labels: repository read/write only, no network, no model-owned verification command, no commit/push/publication, and one external repository-owned verification oracle after the worker exits.

Use the current harness owners:

- Sol High: current reviewed Codex permission-profile worker path with explicit `gpt-5.6-sol` / `high`;
- Luna Max: `pi-luna:worker` with the pinned Pi extension and no model-visible verification command for this comparison;
- Gemini Flash High: `antigravity-gemini:worker`, which pins the model/effort, uses an isolated home plus native subscription keyring, enables the Antigravity sandbox, and requires streaming structured output.

For each arm, preserve the immutable worker receipt, external verification receipt, exact Git after-state, and a separate settlement/accounting projection. Record tokens only from the client/provider. Record five-hour and weekly quota before/after only when exposed. `null` is evidence; a price-derived estimate is not a quota sample.

Accept or reject the exact result against the frozen contract. Then compare:

```text
accepted tasks / 1% five-hour quota
accepted tasks / 1% weekly quota
accepted tasks / subscription dollar
accepted tasks / wall-clock hour / 1% quota
tokens / accepted task
operator minutes / accepted task
retries, intervention, cleanup, and rework
```

If a workspace, node generation, source OID, brief, oracle, model, effort, harness version, or effective permission changes, mark the arm confounded and rerun all affected arms fresh. Do not repair one arm in place and compare its accumulated attempt with another arm's first pass.
