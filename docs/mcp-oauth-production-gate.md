# MCP OAuth production gate

The OAuth implementation is intentionally mergeable before production enablement. Production rollout remains blocked until every item below is implemented and verified.

## Registration edge controls

The Worker applies the edge-control slice before `POST /oauth/register` reaches the OAuth application or Convex:

- `OAUTH_REGISTRATION_RATE_LIMITER` allows 10 registration attempts per 60 seconds for the bounded constant key `oauth-register` in each Cloudflare location;
- `STENSIBLY_OAUTH_REGISTRATION_REDIRECT_ORIGINS` contains exact HTTPS origins, initially `https://chatgpt.com` for the product callback;
- missing or malformed origin configuration, a missing limiter binding, and limiter failures fail closed;
- limiter exhaustion returns OAuth-compatible HTTP `429` with a bounded `Retry-After: 60` response;
- the gate does not use or log client metadata, redirect URIs, credentials, cookies, or IP addresses;
- every parsed redirect URI must match an allowed exact origin. Wildcards, suffix matching, subdomains, userinfo, fragments, and HTTP downgrade are rejected.

Cloudflare rate-limit counters are an edge abuse-control mechanism, not exact global accounting. The Convex per-workspace client ceiling remains a separate storage bound.

## Dynamic-client lifecycle

New dynamic clients begin in explicit `unused` state and expire after **24 hours** unless they participate in authorisation-code creation. Authorisation use permanently changes the client to `used`; the lifecycle is not inferred from mutable display metadata.

Lifecycle records have one strict classification:

- `legacy` means every lifecycle field is absent and remains readable/non-expiring;
- valid `unused` requires one fixed expiry, the same scheduled deadline, one positive schedule generation, and no `firstUsedAt`;
- valid `used` requires `firstUsedAt` and no unused-expiry or schedule fields;
- every partial or contradictory shape is malformed and fails closed for lookup, authorisation, and same-ID replay.

Lifecycle enforcement is bounded and workspace-scoped:

- creation stores the fixed unused deadline and one generation-fenced scheduled cleanup job;
- an early scheduled invocation creates exactly one successor generation at the same deadline;
- stale or duplicate generations do not delete or amplify scheduling;
- an expired unused client is deleted only when no authorisation code and no refresh token in the owning workspace references its exact client ID;
- a discovered code or refresh reference changes an expired or malformed indexed client conservatively to valid `used` state instead of deleting it;
- an unreferenced malformed indexed row is quarantined outside the expiry index, remains unavailable, continues to count toward the workspace ceiling, and requires explicit operator repair rather than unsafe deletion;
- registration attempts one batch of at most 100 expired candidates before enforcing the 1,000-client workspace ceiling;
- bounded deletions, conservative `used` transitions, and malformed-row quarantine commit before either a retryable or terminal limit result is returned;
- if the committed batch cannot recover capacity while more indexed candidates remain, registration returns the stable retryable `MCP_OAUTH_CLIENT_CAPACITY_CLEANUP_REQUIRED` class through the normal non-secret OAuth backend response;
- if no safe indexed candidates remain, registration returns the stable registration-limit class after committing the final preparation batch;
- replaying the same client ID with byte-equivalent normalised metadata returns the original client only while it remains legacy, used, or unexpired-unused, without refreshing its creation time or unused deadline;
- an expired exact-ID replay with a durable owning-workspace reference is promoted to `used`; an expired unreferenced replay returns the stable expired class and requires a fresh client ID;
- changing metadata for an existing client ID conflicts; a different client ID with identical metadata remains a distinct registration.

The hosted service passes a validated current timestamp into client lookup so expiry participates in the Convex query cache key. A client cannot remain readable after its fixed deadline merely because an earlier query result was cached and scheduled cleanup is delayed.

Legacy client rows without lifecycle metadata remain readable and non-expiring. They are changed to explicit `used` state only when actual authorisation use or a durable code/refresh reference establishes that conservative state. No legacy client is expired from `createdAt` alone.

Cleanup logs contain only status and bounded counts. Client IDs, names, redirect values, credentials, provider data, and full registration metadata are excluded.

## Deployment order

OAuth remains disabled during the rollout:

1. deploy the widened Convex schema and the new lifecycle functions;
2. wait for the workspace/lifecycle and workspace/client reference indexes to become available;
3. deploy the Worker build whose Convex references route registration, time-keyed client reads, and authorisation-code creation through the lifecycle module;
4. run the disabled-state verifier and focused load/abuse checks;
5. only then consider enabling `STENSIBLY_OAUTH_SIGNING_SECRET` under the guarded rollout approval.

The prior service-secret Convex functions remain temporarily readable for rolling-deploy compatibility, but the deployed Worker must use the lifecycle references before OAuth is enabled. Existing `stn.tok_...` clients and refresh-family semantics are unaffected.

## Remaining production verification

Before enabling `STENSIBLY_OAUTH_SIGNING_SECRET` in production:

- independently review the exact lifecycle head for storage exhaustion, deletion safety, replay/amplification, workspace isolation, legacy behaviour, malformed-record handling, and sensitive logging;
- verify registration-limit exhaustion and retry recovery in a deployed non-production or guarded environment;
- inspect and explicitly repair any quarantined malformed lifecycle rows before production enablement;
- load-test registration and authorisation without exposing credentials or callback metadata in logs;
- complete the disabled-state metadata/challenge verifier;
- record deployment, rollback, and real ChatGPT read/write/reconnect evidence under #286.

OAuth remains disabled until the lifecycle implementation, independent acceptance, guarded rollout, and real client journey are verified and approved.
