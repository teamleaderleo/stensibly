# Stensibly Vercel deployment rule

Apply this rule to dashboard release, hosted route verification, Vercel project configuration, domain attachment, and rollback work.

Read `docs/vercel-agent-deployment.md` and `docs/dashboard-deployment.md` before acting.

- Project: `stensibly` (`prj_xqnSfQgycWE3moaDjDp3xGCMgtac`).
- Team: `leo-lis-projects` (`team_bJ8gnlt7WISN7WwIgAHHo0aG`).
- Root Directory: `site`.
- Current operator direction permits direct Vercel deployment for reviewed, reversible internal dogfood work.
- Bind every release to an exact GitHub commit.
- Compare `site/**` between live source and current `main`; preserve the live deployment when dashboard bytes are identical.
- Upload the complete configured project when using file-based deployment.
- Verify the immutable deployment URL, `/`, `/labs/`, one nested variant, critical assets, and route-specific CSP before recording success.
- Treat Vercel Authentication, SSO loops, DNS, and custom-domain attachment as explicit observable states.
- Keep the previous deployment ID as the rollback candidate.
- Post exact source, deployment, route, CSP, blocker, and recovery receipts on #687 and #605.

Vercel's `vercel agent init` command can generate generic best-practice guidance. This repository rule owns the Stensibly-specific project and release contract.
