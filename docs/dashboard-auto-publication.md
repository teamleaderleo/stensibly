# Dashboard publication windows

Dashboard production changes are published through a two-hour release window. The operator explicitly requested hourly or two-hour batching during the active 2026-08-01 dogfood session, with a manual queue retained. That direction is the fixed-window exception allowed by `STENSIBLY.md`.

`.github/workflows/auto-deploy-dashboard.yml` runs at minute 17 every two hours and may also be started manually from `main`. It reads GitHub metadata only, compares current `main` with the newest successful `publish-dashboard-on-main.yml` run, and dispatches that guarded publisher once when dashboard-relevant changes accumulated.

Dashboard-relevant changes are the complete `site/` tree plus the exact package, lock, dashboard verifier, deployment diagnostics, domain linker, coordinator, publisher, and manual recovery workflow files.

Several relevant commits inside one window become one publication of the latest `main` revision. An active publication coalesces the window. A window exits successfully when production already covers current `main` or the comparison contains no dashboard path.

A failed publication remains eligible at the next two-hour window because the comparison baseline is the newest successful publication. Manual `force: true` remains the immediate retry path between scheduled windows.

Automatic publication fails closed when the successful baseline is unavailable, behind, or diverged; the comparison reaches its bounded file ceiling; or GitHub returns malformed repository, revision, run, path, or text data. Those exits use no Vercel credential and leave the public dashboard unchanged.

## Exact revision lease

The coordinator admits one lowercase full `main` SHA, evaluates the comparison against that SHA, and sends it to the publisher as required input `expected_revision`.

The publisher checks the input format and requires `github.sha` to equal the admitted revision as its first validation step. A branch movement between evaluation and workflow dispatch therefore fails before checkout. The protected publication job depends on validation, so a mismatch reaches no production environment, Vercel credential, project API, build, deployment, or alias step.

A branch-move rejection remains eligible for the next scheduled window against the newly resolved `main` revision. The final publication receipt records both `github.sha` and `expected_revision`.

## Guarded publisher

`.github/workflows/publish-dashboard-on-main.yml` has `workflow_dispatch` only. The coordinator is its sole automatic caller. The publisher keeps candidate validation separate from protected production effects, then:

1. validates the exact admitted revision before checkout;
2. validates the exact Vercel project name and `site` root directory;
3. limits Vercel Authentication to previews so production routes remain public;
4. performs an exact target-project lookup for `www.stensibly.com`;
5. when the target lookup proves the domain absent, reads every bounded page of project-domain records for apex `stensibly.com`;
6. fails closed on discovery errors, malformed responses or records, repeated or invalid cursors, contradictory target records, conflicting source projects, or invalid project identities;
7. moves `www.stensibly.com` from the one discovered project in the same Vercel team, or adds it to project `stensibly` only after complete discovery proves no source project;
8. requires Vercel to confirm the domain's exact target project identity after mutation;
9. pulls project settings and builds the complete configured project from the repository root;
10. creates an immutable production-targeted deployment without assigning domains;
11. verifies `/`, `/labs/`, `/labs/quiet-control/`, `/labs/soft-companion/`, and `/labs/field-console/` through authenticated Vercel CLI requests;
12. assigns the canonical domain to that exact verified deployment;
13. verifies the same public routes before recording success.

Provider domain failures emit one fixed GitHub annotation containing only the operation and HTTP status. Provider codes and messages are stripped of control characters, truncated to fixed byte bounds, and printed only as prefixed ordinary log lines. Tokens, verification values, full provider responses, and unbounded provider text stay out of workflow commands and retained artifacts.

`test/link-vercel-project-domain.test.ts` executes the domain script against a local fake `curl`. It covers an existing binding, complete paginated move discovery, add after proven absence, hostile discovery failure, malformed records, invalid source identity, cursor cycles, mutation failure, exact request bodies, and the final target-project postcondition. No real Vercel request or credential is used by the test.

## Manual recovery

`Deploy Dashboard Production` remains available for staged recovery and deliberate releases. Both production workflows share the `stensibly-dashboard-production` concurrency group, so production changes run serially.

A failure before domain assignment leaves the current public deployment unchanged. A failure after alias assignment is a release incident: inspect the immutable deployment receipt, restore the previous verified alias when needed, and keep DNS recovery separate from application rollback.

Reverting the release-window squash restores immediate publication policy. It changes cadence only; it does not alter dashboard content, application data, Vercel domains, aliases, deployments, or credentials.
