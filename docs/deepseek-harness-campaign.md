# DeepSeek V4 Flash coding-harness campaign

**Issue:** #782  
**Parent:** #721  
**Model inquiry:** #715  
**Runner contract:** #50  
**Conformance lab:** #536

## Purpose

Prepare one measurable, reversible coding-worker campaign before a DeepSeek key or paid request enters the repository workflow.

The first slice adds a pure campaign profile, cost calculator, OpenCode launch planner, repository-context inventory, eval catalogue, and focused tests. It creates no live provider connection and grants no GitHub, merge, deployment, credential, or canonical-state authority.

## Current provider identity

The callable model alias is `deepseek-v4-flash`. The campaign target label is `DeepSeek-V4-Flash-0731`, supplied by the operator from the July 31 release. Durable receipts require both:

- the exact requested alias;
- an attributable provider response identity or model fingerprint tied to the intended release.

An alias-only response remains ambiguous because an API provider can update a mutable model name. The first live adapter must stop when the release identity cannot be attributed.

## Harness order

### 1. OpenCode

OpenCode is the first executable candidate because DeepSeek publishes an integration guide for it and OpenCode provides:

- a noninteractive `opencode run` command;
- raw JSON events through `--format json`;
- provider/model selection;
- reasoning variants;
- bounded agent steps;
- session export and usage statistics;
- a headless server and SDK for a later supervisor adapter.

DeepSeek currently recommends OpenCode `1.14.24` or newer. The planner therefore requires that minimum version and probes the installed DeepSeek catalogue for exact selector `deepseek/deepseek-v4-flash` before execution.

The generated runtime uses a fresh external directory for `HOME`, XDG state, OpenCode data, and configuration. Sharing, plugins, MCP servers, Claude Code imports, external-directory access, web tools, GitHub commands, push, commit, and deployment paths stay disabled. Project-local `.env`, `.dev.vars`, `opencode.json`, and `.opencode` paths are listed as prohibited because OpenCode can load them automatically or give them higher configuration precedence.

OpenCode merges remote, global, custom, project, inline, and managed settings. A future executor must inspect the resolved configuration, prove that only DeepSeek is enabled, and reject any managed or project rule that widens tools, sharing, plugins, MCP, instructions, providers, or network behavior. The printed plan is an input receipt, not proof of the effective OpenCode configuration.

OpenCode reports token and cost usage, while its ordinary CLI lacks a pre-turn dollar breaker. This first slice therefore emits a launch plan only. Paid execution remains blocked until recorded JSON events prove exact `model` and `system_fingerprint` admission, DeepSeek reasoning/tool-turn replay, usage parsing, and a supervisor-owned budget breaker.

The future executor also needs a minimal child environment containing only required runtime variables and the one DeepSeek secret. It must create a fresh runtime under an operator-owned root, reject symlinked ancestors and final files, and use exclusive writes. Candidate execution needs one additional boundary: an external process/container sandbox that removes the provider key from tool subprocesses, denies egress, and mounts only the disposable worktree. An edit-capable worker can otherwise write test code that reads inherited environment variables or opens network connections.

### 2. Claude Code over the Anthropic-compatible endpoint

DeepSeek also documents Claude Code against `https://api.deepseek.com/anthropic`. This is the second harness candidate because it exercises a separately maintained agent loop and DeepSeek-supported compatibility path. It receives its own recorded fixture and permission review before live use.

### 3. Codex compatibility probe

Codex CLI supports user-defined model providers through user-level configuration. That establishes a possible transport, while DeepSeek reasoning and tool-turn continuity still require an executable recorded probe. The Codex desktop model picker is not the first integration path.

The probe must prove:

- exact provider/model selection with zero silent fallback;
- reasoning/tool item continuity across multiple tool turns;
- JSONL event and usage completeness;
- cancellation behavior;
- current sandbox and approval policy;
- alias/release drift rejection.

Until that probe passes, Codex remains a reference harness for the OpenAI frontier profile and a DeepSeek compatibility experiment.

## Campaign budget

All monetary values are stored as integer micro-dollars.

| Pool | Daily amount |
| --- | ---: |
| High-effort work | $0.70 |
| Max-effort escalation | $0.20 |
| Retry and diagnosis reserve | $0.10 |
| Total | $1.00 |

Each planned episode reserves at most `$0.10`. Cost admission distinguishes:

- cache-hit input tokens;
- cache-miss input tokens;
- output tokens, including reported reasoning tokens where the provider bills them as output.

The repository calculator uses current inquiry prices of `$0.0028`, `$0.14`, and `$0.28` per million tokens, represented as exact integer micro-dollar rates. The first live receipt must compare the provider's current price schedule with the campaign revision before accepting cost evidence.

## Phases

### Simulation

Recorded and fake-provider traffic only. Validate event mapping, model identity, usage, interruption, cancellation, malformed tool results, rate limits, context pressure, and alias drift.

### Observe

A real provider may inspect one public or fictional worktree after the pre-live gates pass. OpenCode receives read, glob, grep, and list access. Shell, edits, web access, task delegation, external directories, GitHub, and external actions remain denied.

### Candidate

One disposable worktree may receive edits and a narrow local shell allowlist for Git inspection and repository tests after the external sandbox exists. Commit, push, `gh`, network utilities, external directories, package installation, merge, deployment, credentials, and canonical issue state remain denied. A separate trusted publisher can later turn an accepted diff into a branch or draft PR under its own authority.

## Eval catalogue

The same exact task packet should run across DeepSeek High, DeepSeek Max, Gemini Flash High, GPT-5.6 Sol High, Opus 5, and Fable 5 where available.

1. Repository survey with source-linked findings.
2. Focused deterministic test repair.
3. Exact-head review separating observed, inferred, and unobserved facts.
4. Branch, PR, and changed-path overlap reconciliation.
5. Start, checkpoint, block, resume, artifact, completion, and reread lifecycle.
6. Arithmetic, token cost, count, SHA, and checklist verification.
7. Ambiguous external effect requiring reconciliation before replay.
8. Refusal of credential, deployment, and canonical-state expansion.
9. Compact durable handoff that a fresh worker can resume.

Record model and harness effects separately. The useful operating measures are accepted tasks per operator minute, first-pass acceptance, repair cycles, reviewer minutes, token/cost receipts, context growth, cancellation/recovery, and overlap cleanup.

## Repository context inventory

Run:

```sh
bun scripts/measure-repository-context.ts .
```

The command reads tracked regular files only, skips symbolic links, binary files, and individual files above five megabytes, and emits:

- exact revision;
- tracked/text/binary/symlink/oversized counts;
- text bytes by top-level directory;
- largest tracked text files;
- a byte-derived token estimate range.

The estimate range is deliberately labelled inexact. An exact DeepSeek tokenizer pass can be added later as a separate optional research adapter after its package, provenance, and generated-lock impact are reviewed.

## Dry-run planner

Create a prompt file, then print the complete secret-free plan:

```sh
bun scripts/plan-deepseek-opencode.ts \
  --episode issue-782-observe-1 \
  --phase observe \
  --effort high \
  --worktree /absolute/path/to/disposable-worktree \
  --runtime /absolute/path/outside-the-worktree \
  --prompt /absolute/path/to/prompt.txt
```

The plan prints the exact model probe, run command, isolated environment, OpenCode configuration, permissions, limits, prompt digest/byte count, budget facts, false authority fields, and every missing pre-live control. Prompt text stays out of the printed plan. The API key appears only as `<secret-handle:deepseek>`.

Paid execution is deliberately absent from this script. The next slice must add recorded OpenCode JSON-event fixtures and an admitted executor. The first eventual paid run remains an observe episode against public or fictional data, with concurrency one until at least twenty episodes establish median cost, cache-hit rate, useful checkpoint rate, repair burden, and reviewer demand.

## Integration with existing runner work

This campaign consumes the merged `RunnerAdapterV1` vocabulary and the conformance approach already present in the repository. It leaves PR #659's OpenAI Agents adapter untouched.

After model-free review:

1. add recorded OpenCode JSON-event fixtures;
2. map them to `RunnerObservationV1` without storing private transcript content;
3. verify effective configuration, model identity, `system_fingerprint`, reasoning/tool continuity, and bounded usage;
4. add a minimal child environment and symlink-safe exclusive runtime creation;
5. implement a supervisor-owned usage breaker and daily reservation ledger;
6. run one live observe episode;
7. compare the same task through Claude Code;
8. run the Codex compatibility probe;
9. graduate a worktree-local candidate episode only after the external sandbox, exact receipts, and independent review.

## Recovery

Delete the five additive campaign files or revert their eventual squash commit. No provider key, account resource, durable session, branch mutation, deployment, or production data migration is created by this slice.
