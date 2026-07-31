# Contributing to Stensibly

Start every repository change by reading [`AGENTS.md`](AGENTS.md), [`STENSIBLY.md`](STENSIBLY.md), and [`docs/current-wave.md`](docs/current-wave.md). Inspect current issues, pull requests, and exact-head handoffs before selecting a file fence.

Read [`docs/documentation-system.md`](docs/documentation-system.md) before creating or materially revising a campaign record, durable decision, operating instruction, or shared documentation convention.

## Local setup

Install Bun and repository dependencies:

```bash
bun install
```

Run the standard development checks appropriate to the change:

```bash
bun run typecheck
bun test
bun run test:convex
bun run worker:check
```

## Managed agent files

The matching files under `.agents/skills/` and `.claude/skills/` are managed by Convex AI Files. They are expected mirrors, not independently maintained duplicate code.

Use the owning CLI instead of hand-editing or deleting one tree:

```bash
npx convex ai-files status
npx convex ai-files update
```

For initial installation, recovery rules, and the review checklist, read [`docs/convex-ai-files.md`](docs/convex-ai-files.md).

## Pull requests

Lead meaningful pull requests with a compact explanation of the work in plain language: purpose, behavior or decision change, proof, and next integration state. Add rationale, file/effect fences, risks, or recovery only when they materially improve review or continuation. Keep mechanical changes brief.

Keep each change bounded and recoverable. Before integration, re-fetch the exact head and current base, inspect the complete diff, confirm relevant checks, reconcile review threads, and record the recovery path. Final pull-request heads should contain the intended source and documentation changes only, without temporary workflow carriers or generated diagnostics.
