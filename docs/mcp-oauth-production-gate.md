# MCP OAuth production gate

The OAuth implementation is intentionally mergeable before production enablement. Production rollout remains blocked until every item below is implemented and verified.

## Registration edge controls

The Worker now applies the edge-control slice before `POST /oauth/register` reaches the OAuth application or Convex:

- `OAUTH_REGISTRATION_RATE_LIMITER` allows 10 registration attempts per 60 seconds for the bounded constant key `oauth-register` in each Cloudflare location;
- `STENSIBLY_OAUTH_REGISTRATION_REDIRECT_ORIGINS` contains exact HTTPS origins, initially `https://chatgpt.com` for the product callback;
- missing or malformed origin configuration, a missing limiter binding, and limiter failures fail closed;
- limiter exhaustion returns OAuth-compatible HTTP `429` with a bounded `Retry-After: 60` response;
- the gate does not use or log client metadata, redirect URIs, credentials, cookies, or IP addresses;
- every parsed redirect URI must match an allowed exact origin. Wildcards, suffix matching, subdomains, userinfo, fragments, and HTTP downgrade are rejected.

Cloudflare rate-limit counters are an edge abuse-control mechanism, not exact global accounting. The existing Convex per-workspace client ceiling remains a separate storage bound.

## Remaining production blockers

Before enabling `STENSIBLY_OAUTH_SIGNING_SECRET` in production:

- define an expiry and bounded cleanup policy for unused dynamic client registrations;
- verify registration-limit exhaustion in the deployed environment and confirm the operational alert path;
- load-test registration and authorization without exposing credentials or callback metadata in logs;
- complete the remaining lifecycle decisions tracked by #220.

This gate does not affect existing `stn.tok_...` clients or non-registration OAuth routes. OAuth remains disabled in production until the remaining controls are implemented, validated, and approved.
