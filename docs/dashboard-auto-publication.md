# Automatic dashboard publication

Merged dashboard changes under `site/**` trigger `.github/workflows/publish-dashboard-on-main.yml`.

The workflow keeps candidate validation separate from protected production effects, then:

1. validates the exact Vercel project name and `site` root directory;
2. limits Vercel Authentication to previews so production routes remain public;
3. attaches or reassigns `www.stensibly.com` to project `stensibly` when the domain is absent;
4. pulls the project settings and builds the complete configured project from the repository root;
5. creates an immutable production-targeted deployment without assigning domains;
6. verifies `/`, `/labs/`, `/labs/quiet-control/`, `/labs/soft-companion/`, and `/labs/field-console/` through authenticated Vercel CLI requests;
7. assigns the canonical domain to that exact verified deployment;
8. verifies the same public routes before recording success.

The existing manual `Deploy Dashboard Production` workflow remains available for staged recovery and deliberate releases. Both workflows share the `stensibly-dashboard-production` concurrency group, so production changes run serially.

A failure before domain assignment leaves the current public deployment unchanged. A failure after alias assignment is a release incident: inspect the immutable deployment receipt, restore the previous verified alias when needed, and keep DNS recovery separate from application rollback.
