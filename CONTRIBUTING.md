# Contributing to Stensibly

Start repository work by reading [`AGENTS.md`](AGENTS.md) and [`STENSIBLY.md`](STENSIBLY.md), then inspect the current issue or pull request and any provider/repository facts that can change the action you are about to take. Read generated or tool-specific guidance for the code you actually touch.

Use [`docs/engineering-handbook.md`](docs/engineering-handbook.md) and [`docs/code-atlas.md`](docs/code-atlas.md) when their examples or invariants help the current source change. They are references, not a mandatory startup packet.

Read [`docs/documentation-system.md`](docs/documentation-system.md) when creating or materially changing a durable decision or shared documentation convention. Ordinary code and mechanical documentation changes do not need a separate documentation-process pass.

When progress requires a human-only action such as authentication, protected secret configuration, provider access, DNS, or an approval outside standing authority, follow [`docs/operator-action-required.md`](docs/operator-action-required.md). Put the action block before every other section in the owning record, request the minimum safe scope, and never ask anyone to paste a secret value into GitHub, chat, logs, screenshots, or artifacts.

## Local setup

Install Bun and repository dependencies:

```bash
bun install
```

Run the deterministic checks appropriate to the changed surface:

```bash
bun run typecheck
bun test
bun run test:convex
bun run worker:check
```

The canonical repository CI remains the integration owner for its declared profiles. Reuse an exact valid receipt when its complete inputs are unchanged instead of rerunning it for freshness alone.

## Managed agent files

The matching files under `.agents/skills/` and `.claude/skills/` are managed by Convex AI Files. They are expected mirrors, not independently maintained duplicate code.

Use the owning CLI instead of hand-editing or deleting one tree:

```bash
npx convex ai-files status
npx convex ai-files update
```

For initial installation and recovery rules, read [`docs/convex-ai-files.md`](docs/convex-ai-files.md).

## Pull requests

Lead a meaningful pull request with the information required to decide it: purpose, behavior or contract change, proof, and the remaining integration action when one exists. Add file/effect boundaries, risks, authority, or recovery only when they change review or continuation. Keep mechanical changes brief.

Before integration, refresh the exact facts that can change the decision: candidate head, relevant base/merge relation, required checks, unresolved substantive findings, current authority, and provider state where applicable. A moved base by itself does not invalidate evidence whose complete inputs remain equivalent.

Final pull-request heads should contain the intended source and documentation only. Temporary workflows, copied status reports, generated diagnostics, and hand-maintained queue state should disappear once their owning deterministic mechanism exists.
