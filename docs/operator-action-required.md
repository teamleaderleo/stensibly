# Operator action required

Use this guide when work cannot continue without a human-only action from the operator.
The action must be impossible to miss and safe to complete without exposing credentials.

## Put the blocker first

When operator action is genuinely required, place a visible block before every other
section in the owning issue, pull request, campaign update, or handoff:

```text
> [!IMPORTANT]
> ## Operator action required
> **Action:** <one concrete action the operator must take>
> **Where:** <provider, repository setting, dashboard, environment, or account>
> **Minimum scope:** <smallest role, permission, repository, environment, duration, or spend>
> **Why now:** <what work is blocked and why agents cannot complete this step>
> **Clears when:** <observable evidence that allows work to resume>
> **Secret handling:** Do not paste the token, key, secret, recovery code, or private value into GitHub, chat, logs, screenshots, or retained artifacts.
```

Keep the action concise and executable. Link to the exact provider page or repository
setting when a durable link exists. Name the account, project, repository, environment,
or domain precisely enough to prevent changes in the wrong place.

## When to use it

Use the banner for a real human-only prerequisite such as:

- enabling or completing authentication, OAuth consent, SSO, or account verification;
- creating, rotating, or revoking a token, API key, application credential, signing key,
  webhook secret, or recovery credential;
- installing an application or granting repository, organization, environment, or
  provider access;
- adding a secret or environment variable through a protected provider interface;
- approving a deployment, protected environment, permission request, billing change,
  purchase, or material spend;
- configuring a domain, DNS record, certificate, ownership proof, or external account;
- completing a provider UI flow that the available agent tools cannot perform.

Do not use the banner for routine work agents can complete under current standing
authority, optional review, ordinary CI waiting, speculative future setup, or a vague
request for broader access.

## Credential safety

Never ask the operator to paste a secret value into an issue, pull request, comment,
chat, log, screenshot, test fixture, commit, or artifact.

Ask the operator to store the value directly in the protected destination: the provider
secret manager, repository or environment secret settings, deployment platform, or
approved credential store. Durable records may name the secret reference, environment
variable, credential ID, last four non-sensitive characters when genuinely useful, and
verification time. They must not contain the secret itself.

Request the narrowest practical authority:

- one repository instead of an organization when sufficient;
- read permission instead of write permission when sufficient;
- one environment instead of every deployment target;
- a short expiry instead of an indefinite credential when supported;
- the exact provider capability rather than an administrative role.

Explain any wider scope explicitly before asking for it.

## One action at a time

Lead with the next action that actually unblocks work. When several operator actions are
required, order them and separate independent actions. Avoid a long setup checklist when
the first step may fail or change the later steps.

An operator-action block should answer without follow-up questions:

1. What exactly must be done?
2. Where must it be done?
3. What is the minimum safe permission or scope?
4. Why can agents not do it themselves?
5. What evidence proves the block is cleared?

## Clearing the banner

As soon as the action is verified, either remove the active banner or change its heading
to `Operator action cleared` and record the non-secret evidence:

- provider or deployment identity;
- permission or scope that was verified;
- configuration or secret reference name;
- verification timestamp;
- exact run, deployment, request, or test that succeeded.

Do not leave a stale active banner after the block is cleared. If verification fails,
update the same owning record with the precise remaining action rather than creating a
second conflicting request.

## Examples

### Authentication

```text
> [!IMPORTANT]
> ## Operator action required
> **Action:** Complete the Vercel account authorization for the Stensibly project.
> **Where:** Vercel account connected to project `stensibly`.
> **Minimum scope:** Access to that project only; no team-wide administrative role.
> **Why now:** Deployment verification cannot read or update the project until the provider session is authorized.
> **Clears when:** The deployment tool can read project identity and list the current production deployment.
> **Secret handling:** Complete the provider flow directly. Do not paste session cookies, tokens, or recovery codes.
```

### Repository token

```text
> [!IMPORTANT]
> ## Operator action required
> **Action:** Create a short-lived GitHub token and save it as environment secret `STENSIBLY_GITHUB_TOKEN`.
> **Where:** Protected deployment environment for the hosted Stensibly service.
> **Minimum scope:** Read access to the named repository and the exact API capability documented by the owning issue.
> **Why now:** The hosted provider cannot perform the verified read journey without a server-side credential reference.
> **Clears when:** The protected environment exposes the secret reference and the exact hosted read test succeeds.
> **Secret handling:** Add the token directly in the environment secret UI. Never paste its value into GitHub or chat.
```

— Quill · documentation follow-up  
  Intention: make human-only prerequisites prominent, precise, and credential-safe.
