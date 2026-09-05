# Antigravity Gemini worker harness

`antigravity-gemini:worker` runs one first-party Google Antigravity CLI worker with the operator's cached Google-account subscription session. It never accepts or forwards a Gemini API key.

The fixed first slice is `gemini-3.7-flash-high` with explicit `high` effort. The task brief travels over stdin. Antigravity emits streaming JSON and a required structured result. The wrapper enables Antigravity's terminal sandbox, keeps normal permission review, disables slash-command expansion, and never passes `--dangerously-skip-permissions`. It launches with a fresh temporary home so interactive global permission rules cannot widen the worker; Subscription authentication uses the native keyring over the allowlisted session bus by default. For installations that store their subscription profile on disk, explicitly pass `--subscription-auth-file PATH`. The wrapper validates a private operator-owned regular file with canonical, trusted ancestors outside the task workspace and evidence directory, then links only that file into the temporary home. It never reads or copies profile bytes and does not import settings or permission rules.

In-place provider token refresh deliberately updates the original profile through the link. If the provider replaces the link itself (for example through an atomic rename), the wrapper marks the run failed and retains the private temporary home for explicit protected recovery; it must not discard a newly refreshed credential. Otherwise cleanup removes the temporary home and link without deleting the original profile. The receipt records only the authentication mechanism and recovery flag, never the source profile path or contents. Native provider profile selectors should replace this link when the CLI exposes a supported selector; version 1.1.22 help does not expose one.

```bash
bun run antigravity-gemini:worker -- \
  --repository /home/leo/Projects/worktrees/owned-task \
  --brief /absolute/task/brief.md \
  --output-dir /absolute/evidence/task-01/attempt-1 \
  --run-id task-01-attempt-1 \
  --node-id big-red \
  --node-generation 1 \
  --agy-bin /home/leo/.local/bin/agy \
  --timeout-ms 1800000
```

The repository must already be a task-private Git workspace admitted by the existing Stensibly/Glaeda path. The output directory must be new and outside that workspace. Antigravity may read and write the active workspace, but shell commands that still need approval are soft-denied in headless mode. Repository-owned focused/required verification remains an external Glaeda step; the worker may report attempts, but it cannot accept its own work.

`receipt.json` records exact node generation, Git before/after identity, Antigravity version, Google-account subscription auth class, model/effort, sandbox/permission flags, bounded artifacts, token categories, turns/steps/tools/subagents, pre/post quota snapshots, wall time, and explicit unknown acceptance/verification/economics fields. `/usage` is a provider text surface: percentages and reset timestamps are recorded only when the client states them. Missing quota dimensions remain `null`.

Big Red is the primary execution site. Air Blue replication should use the same wrapper, model, effort, and receipt schema, but should remain an awake/interactive overflow or cross-platform cohort rather than the default heavy worker.

For 24/7 work, Stensibly must first classify the task as explicitly deferrable. Run CPU-heavy repository verification or repair loops through Glaeda's existing `big-red-background` resource profile: `CPUWeight=25`, no CPU pinning or quota, and the normal bounded deadline/descriptor-bound cleanup contract. That profile remains work-conserving while Big Red is idle and yields relative CPU share to foreground work. Antigravity does not select the profile, find work, retry work, or decide acceptance. Favor research synthesis, independent bounded attempts, test repair, and documentation synchronization only when the task's expected accepted-work-per-quota value beats saving the subscription allowance for foreground work.

This wrapper is the manual composition requested by Glaeda #990. It is not a scheduler, work ledger, generic shell, publication owner, or replacement for `develop-project/v1`. The exact handoff into #990 is: replace only task-private workspace admission and terminal receipt settlement when that profile exists; retain this harness invocation and accounting contract.

After Glaeda verifies the exact Git result and Stensibly accepts or rejects the task, project one privacy-bounded Scrapbook envelope without mutating the immutable worker receipt:

```bash
bun run antigravity-gemini:account -- \
  --receipt /absolute/evidence/task-01/attempt-1/receipt.json \
  --output /absolute/evidence/task-01/attempt-1/accounting.json \
  --usage-sample-id task-01-attempt-1 \
  --accepted-outcome accepted \
  --verification-outcome passed \
  --operator-intervention-minutes 3 \
  --cleanup-rework none
```

The usage sample ID must be the same ID used by Scrapbook's existing
`agent-telemetry-report/v1` Antigravity adapter. Token and provider-quota truth
stay in that canonical usage path; this command emits only the externally
settled task outcome and derived quota deltas needed to join accepted work to
usage. Supply `--subscription-monthly-dollars` only for the operator's actual
subscription charge and currency-normalized reporting decision. The projector
refuses to label a task accepted unless external verification passed. The
envelope contains no prompt, response, command, path, repository,
conversation, or raw quota text.
