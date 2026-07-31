# Automatic dashboard publication

Merged dashboard changes under `site/**` trigger `.github/workflows/publish-dashboard-on-main.yml`.

The workflow keeps candidate validation separate from protected production effects, then:

1. validates the exact Vercel project name and `site` root directory;
2. limits Vercel Authentication to previews so production routes remain public;
3. reads the target project's domain catalogue;
4. moves `www.stensibly.com` from another project in the same Vercel team when present, or adds it directly to project `stensibly` through the Vercel project-domain API;
5. requires Vercel to confirm the domain's exact target project identity;
6. pulls the project settings and builds the complete configured project from the repository root;
7. creates an immutable production-targeted deployment without assigning domains;
8. verifies `/`, `/labs/`, `/labs/quiet-control/`, `/labs/soft-companion/`, and `/labs/field-console/` through authenticated Vercel CLI requests;
9. assigns the canonical domain to that exact verified deployment;
10. verifies the same public routes before recording success.

Provider domain failures emit only the HTTP status, provider error code, and provider error message. Tokens, verification values, and full provider responses stay out of logs and retained artifacts.

The existing manual `Deploy Dashboard Production` workflow remains available for staged recovery and deliberate releases. Both workflows share the `stensibly-dashboard-production` concurrency group, so production changes run serially.

A failure before domain assignment leaves the current public deployment unchanged. A failure after alias assignment is a release incident: inspect the immutable deployment receipt, restore the previous verified alias when needed, and keep DNS recovery separate from application rollback.
