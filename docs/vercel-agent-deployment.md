# Vercel agent deployment contract

Owner: #687  
Programme: #605  
Project: `stensibly`  
Vercel team: `team_bJ8gnlt7WISN7WwIgAHHo0aG` (`leo-lis-projects`)  
Vercel project: `prj_xqnSfQgycWE3moaDjDp3xGCMgtac`  
Configured Root Directory: `site`

This guide gives coding agents one repository-specific path for dashboard publication. It complements `docs/dashboard-deployment.md` and current operator direction.

Vercel offers `vercel agent init` for generic agent guidance. Stensibly keeps the exact project, source, verification, and recovery rules here so generated defaults never replace repository policy.

## Direct-deploy authority

Current operator direction permits direct Vercel deployment for this internal dogfood dashboard.

Use one of these paths:

1. the guarded **Deploy Dashboard Production** GitHub workflow;
2. Vercel CLI or SDK deployment from an exact reviewed GitHub commit;
3. the connected Vercel deployment tool when it can publish the complete dashboard source.

Choose the path that can bind the deployment to an exact commit and produce route evidence. Keep secrets inside the provider boundary.

## Source identity

Before publication:

1. fetch current `main` and record its full 40-character SHA;
2. inspect the current production deployment and record its Git commit SHA;
3. compare those revisions for changes under `site/**` and `site/vercel.json`;
4. keep the existing production deployment when the dashboard tree is byte-equivalent;
5. deploy the complete configured project when dashboard bytes changed.

A later backend or documentation commit does not require a dashboard redeployment when `site/**` is unchanged. Record that comparison as the release receipt.

For Git-backed SDK deployment, set `gitSource` to the exact GitHub organization, repository, branch, and SHA. For file-upload deployment, include the complete configured `site` project plus `site/vercel.json`; partial route uploads can silently remove dashboard assets.

## Project and routing contract

The dashboard project reads repository directory `site` as its project root.

Expected hosted routes:

- `/`;
- `/labs/`;
- `/labs/quiet-control/`;
- `/labs/soft-companion/`;
- `/labs/field-console/`;
- `/labs/signal-atlas/`;
- `/labs/studio-canvas/`.

The production root remains coherent and separate from experiments. Labs data stays fictional and content-minimised. Gradients remain excluded.

## Verification

Verify the immutable deployment URL before relying on an alias.

Required receipts:

- deployment ID, URL, state, target, creator, and source SHA;
- `/` returns the Stensibly dashboard;
- `/labs/` returns the catalogue;
- one nested variant returns its static document;
- root CSP contains `frame-ancestors 'none'`;
- Labs CSP contains `frame-ancestors 'self'`;
- the catalogue can render two same-origin sandboxed comparison frames;
- critical CSS, JavaScript, manifest, fixture, and favicon assets return successfully;
- route content contains no credential-shaped or private evidence.

Use `bun run verify:dashboard -- --url <immutable deployment URL>` when a trusted shell can access the deployment. Vercel Authentication may protect generated aliases. Use `vercel curl`, a valid temporary share URL, or the provider fetch tool. Record an authentication or SSO loop as a verification blocker and avoid claiming route success from deployment metadata alone.

## Promotion and aliases

A direct production deployment may assign generated Vercel aliases. Treat custom-domain attachment as a separate reversible operation.

`www.stensibly.com` belongs to project `prj_xqnSfQgycWE3moaDjDp3xGCMgtac`. Reattach it through Vercel domain settings and required DNS records, then verify the same route and CSP receipts on the canonical hostname.

## Recovery

Keep the previous known-good deployment ID before publication.

Use Vercel Instant Rollback or promote the previous deployment when route, asset, CSP, or dashboard verification fails. Domain attachment can be reversed independently. Post the rollback deployment ID and follow-up verification on #687 and #605.

## Durable record

For every direct release, post:

- current `main` SHA;
- deployed source SHA;
- dashboard-tree comparison;
- deployment ID and immutable URL;
- production aliases and custom-domain state;
- exact route, asset, and CSP results;
- protection or DNS blockers;
- rollback candidate;
- next executable action.
