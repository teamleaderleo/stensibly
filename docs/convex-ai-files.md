# Convex AI Files ownership and reconciliation

Stensibly commits agent-native Convex guidance in two project-scoped locations:

- `.agents/skills/` is the canonical Convex AI Files project install;
- `.claude/skills/` is the managed Claude Code mirror or link target.

The matching files are expected generated packaging. They are not two independently maintained copies of product code.

## Contributor setup

Install the project-scoped files from the repository root:

```bash
npx convex ai-files install
```

Before changing or reviewing generated guidance, inspect the managed state:

```bash
npx convex ai-files status
```

Reconcile the committed files with the currently installed Convex package through the owning CLI:

```bash
npx convex ai-files update
```

Run these commands from a clean worktree. Review the complete generated diff before committing it, including both `.agents/skills/` and `.claude/skills/`.

## Ownership rules

- Do not hand-edit one mirrored tree and leave the other unchanged.
- Do not delete `.claude/skills/` as apparent duplicate code.
- Do not copy files manually between the two trees as the normal update path.
- Do not mix unrelated generated changes into a feature branch.
- Use `status` to diagnose drift and `update` to reconcile it.
- Keep generated Convex guidance changes in a bounded commit with the package revision and command used recorded in the pull request.

If an update produces unexpected removals or broad unrelated changes, discard the generated diff, confirm the Convex package version and clean-tree state, and rerun `status` before trying again.

## Review checklist

A managed-files update is ready when:

1. `npx convex ai-files status` reports the expected state after reconciliation;
2. canonical and Claude-facing paths remain aligned for every managed skill;
3. the diff contains no hand-written product or credential content;
4. repository checks appropriate to any accompanying source change pass;
5. recovery is one revert of the bounded generated-files commit.

The repository cleanup audit records the original ownership finding and upstream reference in [`docs/repository-cleanup-audit-2026-07-31.md`](repository-cleanup-audit-2026-07-31.md#managed-mirrored-skills).
