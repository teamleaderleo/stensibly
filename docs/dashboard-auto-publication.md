# Automatic dashboard publication

Merged dashboard changes under `site/**` trigger `.github/workflows/publish-dashboard-on-main.yml`.

The workflow keeps candidate validation separate from protected production effects, then:

1. validates the exact Vercel project name and `site` root directory;
2. limits Vercel Authentication to previews so production routes remain public;
3. performs an exact target-project lookup for `www.stensibly.com`;
4. when the target lookup proves the domain absent, reads every bounded page of project-domain records for apex `stensibly.com`;
5. fails closed on discovery errors, malformed responses or records, repeated/invalid cursors, contradictory target records, conflicting source projects, or invalid project identities;
6. moves `www.stensibly.com` from the one discovered project in the same Vercel team, or adds it directly to project `stensibly` only after complete discovery proves no source project;
7. requires Vercel to confirm the domain's exact target project identity after mutation;
8. pulls the project settings and builds the complete configured project from the repository root;
9. creates an immutable production-targeted deployment without assigning domains;
10. verifies `/`, `/labs/`, `/labs/quiet-control/`, `/labs/soft-companion/`, and `/labs/field-console/` through authenticated Vercel CLI requests;
11. assigns the canonical domain to that exact verified deployment;
12. verifies the same public routes before recording success.

Provider domain failures emit one fixed GitHub annotation containing only the operation and HTTP status. Provider codes and messages are stripped of control characters, truncated to fixed byte bounds, and printed only as prefixed ordinary log lines. Tokens, verification values, full provider responses, and unbounded provider text stay out of workflow commands and retained artifacts.

`test/link-vercel-project-domain.test.ts` executes the domain script against a local fake `curl`. It covers an existing binding, complete paginated move discovery, add after proven absence, discovery failure with hostile provider text, malformed domain records, invalid source identity, mutation failure, exact request bodies, and the final target-project postcondition. No real Vercel request or credential is used by the test.

The existing manual `Deploy Dashboard Production` workflow remains available for staged recovery and deliberate releases. Both workflows share the `stensibly-dashboard-production` concurrency group, so production changes run serially.

A failure before domain assignment leaves the current public deployment unchanged. A failure after alias assignment is a release incident: inspect the immutable deployment receipt, restore the previous verified alias when needed, and keep DNS recovery separate from application rollback.
