# Frontend browser evidence and research adapters

**Owner issue:** #667  
**Related:** #605, #615, #618, #620

## Canonical repository proof

Stensibly uses Playwright Test with Chromium for fixture-only browser evidence.

Run:

```bash
bun install --frozen-lockfile
bun run typecheck:browser
bunx playwright install chromium
bun run test:browser
bun run verify:browser-artifacts
```

The suite starts `scripts/serve-frontend-fixtures.ts` on loopback, serves only files under the real `site/` tree, and applies a restrictive local content-security policy. Browser tests fail on any HTTP or WebSocket request whose origin differs from the loopback fixture server. Dialogs, downloads, console errors, uncaught browser errors, and page crashes also fail the applicable evidence flow.

`tsconfig.browser.json` keeps the Playwright configuration, browser tasks, fixture server, artifact verifier, and narrow browser-global declaration under strict TypeScript checking without widening the main application compiler inputs.

Current first-slice coverage:

- fixture-server read, missing-route, traversal, method, and symlink boundaries;
- the `/labs/` catalogue and every registered prototype route;
- exact wide, narrow, and 200%-zoom-equivalent planner cases;
- supported light/dark, reduced-motion, and degraded planner cases;
- explicit fixture, experiment, and source-revision labeling;
- two-variant sandboxed comparison;
- every shared Quiet Control task and expected identity;
- numbered view switching, J/K movement, command focus, and exact return focus;
- narrow-screen list/detail focus continuity;
- deterministic overflow and visible-control naming checks;
- path-backed JSON receipts and PNG screenshots for successful cases;
- local failure traces and automatic screenshots for diagnosis on the ephemeral runner.

Artifacts are written to:

```text
artifacts/playwright-report/report.json
artifacts/playwright-results/
browser-test-output.txt
```

The suite uses compact bounded attachment names. Every receipt retains the complete canonical case ID, planner artifact stem, fixture revision, plan revision, route, source revision, viewport, zoom, presentation axes, task ID, and expected identity.

Playwright's JSON reporter base64-embeds in-memory attachments, so canonical evidence uses path-backed attachments. The report contains paths while the copied PNG and JSON files remain individually inspectable under `artifacts/playwright-results/`; temporary source files are deleted after each attachment copy.

Before CI uploads evidence, `scripts/verify-browser-evidence-artifacts.ts` requires the exact JSON report, result tree, and browser output. It rejects:

- symbolic links, private-data filename families, compressed archives, oversized files, excessive file counts, and excessive total bytes;
- JSON reports with embedded `body` or `buffer` payloads;
- attachment paths outside verified results, missing referenced files, unreferenced result files, and report-directory siblings;
- PNG files with invalid signatures, excessive dimensions, missing image chunks, trailing data, or metadata chunks outside the reviewed visual chunk set;
- high-confidence Stensibly, GitHub, OpenAI-style, and AWS credential patterns.

Playwright 1.62 writes one runner-owned `artifacts/playwright-results/.last-run.json`. The verifier admits exactly that unreferenced result file and requires the exact `status` and `failedTests` fields, `status: "passed"`, and an empty failed-test list.

The dedicated upload runs only after both the Chromium suite and artifact fence succeed. Browser output stays outside the generic diagnostics artifact.

Playwright can create compressed traces after a failure. The privacy fence rejects those opaque archives, and CI never uploads browser evidence from a failed Chromium run. Canonical CI retains only green, verified fixture-only artifacts for seven days.

## Determinism boundary

The first slice does not commit pixel baselines. It proves behavior and produces reviewable render evidence from one exact browser environment.

Before adopting `toHaveScreenshot()` baselines:

1. record the exact Playwright package and Chromium revision;
2. confirm repeated CI renders are stable;
3. choose the canonical OS, viewport, color scheme, locale, timezone, fonts, and motion preference;
4. define an explicit baseline update command and review fence;
5. verify screenshot files contain only invented public fixture content;
6. measure artifact size and CI duration;
7. add one baseline at a time for high-value states.

Playwright documents that screenshots can vary across operating systems, browser versions, hardware, power state, and headless settings. Baselines must be generated in the same controlled environment used for comparison.

## Local exploratory browser work

Playwright CLI and Playwright MCP are optional research and QA interfaces. They do not replace repository tests.

Playwright 1.62 bundles both interfaces in the exact pinned repository toolchain:

```bash
bun run browser:cli -- --help
bun run browser:mcp -- --help
```

Use an isolated profile by default. Restrict allowed origins, avoid unrestricted file access, and store no credentials in repository artifacts. Connecting to an existing operator browser is reserved for an exact logged-in task where the existing state is genuinely required.

A bounded MCP client entry can invoke the repository-pinned server from the repository root:

```json
{
  "mcpServers": {
    "playwright-research": {
      "command": "bun",
      "args": [
        "run",
        "browser:mcp",
        "--",
        "--isolated",
        "--headless",
        "--sandbox",
        "--block-service-workers",
        "--allowed-origins",
        "https://example.com;https://www.example.com",
        "--image-responses",
        "omit",
        "--output-mode",
        "file",
        "--output-dir",
        "/temporary/path/stensibly-browser-research/run-id",
        "--output-max-size",
        "25000000",
        "--viewport-size",
        "1440x900"
      ]
    }
  }
}
```

Set the MCP client's working directory to the Stensibly repository. Replace the example origins with the exact sites required for one research question and put the output directory outside the repository. Do not add `--allow-unrestricted-file-access`, `--secrets`, `--storage-state`, or `--save-session` for ordinary public research.

Playwright MCP states that origin filters are not a complete security boundary and do not constrain redirects. Keep research profiles isolated and free of sensitive logins even when an allowlist is configured. The browser extension can attach to an existing Chrome or Edge tab, but that exposes the selected tab's logged-in state and requires an explicit connection approval by default; reserve it for a narrowly reviewed authenticated task.

A browser research result should record:

- the research question;
- source URLs and inspection date;
- wide and narrow navigation paths;
- semantic or accessibility observations;
- concrete praise and friction;
- screenshots only when they clarify a finding;
- the applicable Stensibly task or prototype lane;
- an adopt, adapt, test, or reject disposition;
- access, terms, robots, login, and evidence limitations.

Do not bypass access controls, CAPTCHAs, paywalls, robots restrictions, or site terms.

## Optional Browserbase use

Browserbase is an occasional hosted adapter for remote execution, session replay, or pages that are difficult to inspect locally. It is not a required CI service.

The free plan inspected on 2026-07-31 included one browser hour per month and 15-minute maximum sessions. Stay within the free plan unless the operator separately approves paid capacity.

Use one bounded question per hosted session. Prefer fresh isolated contexts. Do not use retained hosted sessions for private accounts or secret-bearing pages without a reviewed need. Do not contact, purchase, submit, publish, or act as the operator during market research.

## Dependency and browser updates

`@playwright/test` is an exact-pinned development dependency governed by `docs/dependency-lockfile-workflow.md`. Playwright 1.62 includes the matching test runner, browser library, MCP server, and CLI. A package declaration change intentionally causes canonical CI to publish an exact `bun.lock` candidate before frozen validation resumes.

For a Playwright update:

1. update the exact package version on a same-repository branch;
2. let the lockfile writer publish the exact generated lock;
3. inspect package, lock, browser revision, license, and transitive changes;
4. run both strict typechecks and the complete repository gate;
5. compare browser evidence duration and artifact size;
6. exercise every browser task and the artifact fence before integration.

## Removal

Remove:

- `@playwright/test` from `package.json` and regenerate `bun.lock`;
- the `browser:cli` and `browser:mcp` scripts;
- `playwright.config.ts` and `tsconfig.browser.json`;
- `browser-tests/`;
- `scripts/serve-frontend-fixtures.ts` and `scripts/verify-browser-evidence-artifacts.ts`;
- the browser typecheck/install/test/verification/artifact steps in canonical CI;
- generated Playwright artifact ignores.

No production route, authentication, API, persistence, or live-data migration is involved.

## Reusable upstream lane

After a second operator-owned repository adopts the same controls, evaluate extracting:

- fixture-only static serving;
- external-network denial;
- console and page-error collection;
- responsive viewport matrices;
- public-fixture leakage scans;
- screenshot and receipt artifact conventions;
- reusable browser installation and caching;
- a machine-readable evidence manifest.

Keep Stensibly-specific tasks, terminology, status semantics, and fixtures in this repository. Open upstream issues or pull requests only after a reproducible general defect or gap is demonstrated with exact versions and privacy-safe evidence.
