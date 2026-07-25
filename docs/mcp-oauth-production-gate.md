# MCP OAuth production gate

The OAuth implementation is intentionally mergeable before production enablement. Production rollout remains blocked until the public dynamic-client-registration surface has edge abuse controls.

Before enabling `STENSIBLY_OAUTH_SIGNING_SECRET` in production:

- apply a Cloudflare rate limit to `POST /oauth/register`;
- constrain accepted redirect origins to the ChatGPT callback origin used by the configured client;
- define an expiry and bounded cleanup policy for unused dynamic client registrations;
- verify that registration-limit exhaustion produces an observable, actionable failure;
- load-test registration and authorization without exposing credentials in logs.

The Convex authority already caps persistent OAuth clients per workspace. That cap is a storage bound, not a substitute for edge rate limiting: an attacker who can fill the cap can still deny future registrations.

This gate does not affect existing `stn.tok_...` clients. OAuth should remain disabled in production until the controls above are implemented and verified.
