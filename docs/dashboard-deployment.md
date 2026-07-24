# Dashboard production deployment

The static dashboard is the Vercel project named `stensibly`. The parked project named `stensibly-api` is not part of the production request path and must not be used by this workflow.

The preferred controlled release path is the manual GitHub Actions workflow named **Deploy Dashboard Production**. It validates the repository without production secrets, waits for the existing GitHub `production` environment approval, creates a staged production deployment without assigning domains, verifies it, promotes that exact deployment, and then verifies `https://www.stensibly.com`.

## One-time Vercel setup

In the Vercel project `stensibly`:

1. confirm the project Root Directory is exactly `site`
2. confirm `www.stensibly.com` is attached to this project
3. turn off automatic assignment of custom production domains for new production deployments
4. retain the Git integration only when its automatic deployments cannot take production traffic before the guarded workflow promotes a verified deployment
5. create a Vercel access token scoped only to the account or team that owns `stensibly`, with the shortest practical expiration
6. record the project ID and owner/team ID from the `stensibly` project settings or a linked repository-root `.vercel/project.json`

Vercel applies the configured Root Directory to CLI builds. Run the CLI from the repository root; do not combine the `site` project setting with `--cwd site`.

Turning off automatic domain assignment is required for the staged-release sequence. The workflow also passes `--skip-domain`, verifies the generated deployment URL, and uses `vercel promote` only after those checks pass.

## One-time GitHub setup

Use the existing repository environment named `production`. Keep its required reviewers and deployment branch restriction to `main`, then add these environment secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

`VERCEL_PROJECT_ID` must identify the project named `stensibly`. The workflow queries Vercel before linking or building and fails if the configured project has another name or a Root Directory other than `site`.

The dashboard workflow does not receive:

- a Stensibly API token
- `STENSIBLY_SERVICE_SECRET`
- `CONVEX_URL`
- Cloudflare account or API credentials

The generated repository-root `.vercel` directory is ephemeral workflow state and must not be committed.

## Release through GitHub Actions

1. Open **Actions** in the repository.
2. Select **Deploy Dashboard Production**.
3. Choose **Run workflow** from `main`.
4. Wait for the secret-free candidate job to pass.
5. Review the commit and approve the `production` environment deployment.
6. Confirm the job summary records the same staged deployment that was promoted.
7. Open `https://www.stensibly.com` in a clean browser profile and exercise connection, item detail, and the write controls appropriate to the test token.

The workflow performs these stages:

1. rejects refs other than `main`
2. installs the committed Bun lockfile
3. runs typecheck, Bun tests, Convex tests, Worker bundling, and source-shell verification without production secrets
4. validates the three Vercel environment secrets
5. requires the Vercel project name `stensibly` and Root Directory `site`
6. pulls production project settings into the repository-root `.vercel` directory
7. builds the configured `site` project through a pinned Vercel CLI version
8. creates a production deployment with `--skip-domain`
9. uses `vercel curl` to verify protected staged HTML and critical static assets
10. promotes the exact verified deployment
11. retries the public `www.stensibly.com` verifier up to three times
12. records the commit, staged deployment URL, production domain, project name, and successful checks in the job summary

A staged verification failure leaves production domains unchanged. A failure after promotion stops the workflow and requires an explicit rollback decision.

## Dashboard verifier

Verify the public dashboard from a trusted shell:

```bash
bun run verify:dashboard
```

Verify another HTTPS origin:

```bash
bun run verify:dashboard -- --url https://example.vercel.app
```

Verify already-fetched HTML, as the protected staged deployment step does:

```bash
bun run verify:dashboard -- --html-file /path/to/index.html
```

The verifier checks the Stensibly document markers, rejects token-shaped content, and validates the critical CSS, JavaScript module, and favicon graph when it receives a URL.

## Manual CLI fallback

Use this only from a trusted repository-root shell when GitHub Actions is unavailable or being repaired. Export the Vercel token and the IDs for the `stensibly` project without writing them to shell history or repository files.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:convex
bun run worker:check
bun run verify:dashboard -- --html-file site/index.html

npx --yes vercel@56.5.0 pull \
  --yes \
  --environment=production \
  --token="$VERCEL_TOKEN"

npx --yes vercel@56.5.0 build \
  --prod \
  --token="$VERCEL_TOKEN"

npx --yes vercel@56.5.0 deploy \
  --prebuilt \
  --prod \
  --skip-domain \
  --yes \
  --token="$VERCEL_TOKEN"
```

Capture the deployment URL printed on standard output. Verify it with `vercel curl`, then promote that exact URL:

```bash
npx --yes vercel@56.5.0 curl / \
  --deployment "$DEPLOYMENT_URL" \
  --token="$VERCEL_TOKEN" \
  --fail --silent --show-error \
  > /tmp/dashboard-index.html

bun run verify:dashboard -- --html-file /tmp/dashboard-index.html

npx --yes vercel@56.5.0 promote "$DEPLOYMENT_URL" \
  --yes \
  --timeout=5m \
  --token="$VERCEL_TOKEN"

bun run verify:dashboard
```

Do not promote a deployment that has not passed the staged checks.

## Rollback

When the promoted dashboard is unhealthy, use the Vercel deployment history to perform Instant Rollback, or use the linked CLI from a trusted repository-root environment:

```bash
npx --yes vercel@56.5.0 rollback --token="$VERCEL_TOKEN"
npx --yes vercel@56.5.0 rollback status --token="$VERCEL_TOKEN"
```

After rollback:

1. run `bun run verify:dashboard`
2. open the production domain in a clean browser profile
3. confirm no bearer token is rendered or persisted outside `sessionStorage`
4. run the hosted API verifier separately when the incident may involve API connectivity

Dashboard rollback changes static code only. It does not reverse Convex ledger records or Worker deployments.
