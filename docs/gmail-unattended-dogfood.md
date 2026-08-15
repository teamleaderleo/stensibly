# Gmail unattended dogfood setup

**Owner:** #1498  
**Programme:** #1488 / #1490  
**Runtime:** Cloudflare Worker + Gmail API + Google Cloud Pub/Sub + Convex  
**Mailbox:** `leoli.4u@gmail.com`  
**Watched label:** `Stensibly/Handoffs` (`Label_5`)

## Runtime contract

The hosted Worker owns two entry points:

- `POST https://api.stensibly.com/internal/gmail/pubsub` — accepts only Google
  Pub/Sub pushes carrying a valid Google-signed OIDC JWT for the configured audience
  and exact push service-account email;
- hourly Worker cron (`7 * * * *`) — bootstraps `users.watch` when the durable mailbox
  binding does not exist, renews the watch before expiry, reconciles missed history
  from the durable Gmail `historyId` cursor, and repairs quiet-mail Inbox hygiene.

Before first watch initialization, and before later unattended Gmail work in a fresh
runtime, the OAuth credential must prove the configured mailbox through
`users.getProfile`. The provider email address must exactly match the configured
`STENSIBLY_GMAIL_MAILBOX` after canonical email casing. A wrong credential/mailbox pair
fails before `users.watch` and before a durable `coverage:continuous` claim.

The Worker watches only `Label_5`. Reconciliation uses the merged mailbox contracts and
commits the next cursor plus admitted observations atomically in Convex. The downstream
material projection consumes provider-neutral mailbox observation v2 fields, including
`mail.scope.added` / `mail.scope.removed` and `providerScopeId`. A downstream semantic
consumer drains durable `wakeEligible + ordinary` observation rows by observation
identity; Pub/Sub delivery is never the only chance to process a material reply.

Merged #1528 supplies the consumer-side semantic boundary: after a durable observation
selects one exact provider message/thread, the consumer resolves exactly one durable
canonical STN/provider binding before fetching that message, transiently admits bounded
MIME/current-reply content, separates quoted ancestry, and records content-minimized
semantic evidence with every authority flag false. Effect-bearing GitHub projection
continues through the server-owned authority fence merged in #1517/#1541.

Hosted outbound thread/effect/provider-message durability remains owned by #1518. Its
exact `(provider, accountBinding, providerMessageId)` lookup is the restart-safe source
for self-echo classification and its provider-thread projection is the durable routing
input consumed by #1528. Do not replace either lookup with mailbox scans or an old chat.

`Stensibly/Handoffs` is the quiet agent-continuation lane. Every runtime pass performs a
bounded Gmail query for messages carrying both `Label_5` and `INBOX`, then removes
`INBOX` and `UNREAD` from those messages while preserving `Label_5` and the mail object.
The same sweep runs on covered duplicate pushes, so a failed archive after a durable
cursor commit is recoverable. Genuine operator-attention mail belongs in the separate
operator-attention policy and never widens this sweep.

## Recovery invariants

The unattended runtime preserves provider truth across the failure cases that matter for
this lane:

1. **Rejected cached access token.** A Gmail 401/403 invalidates only the exact cached
   token that was rejected. The client refreshes through the protected refresh grant and
   retries the request once. A stale failure cannot erase a newer concurrent token.
2. **Convex CAS loser.** A worker that loses the mailbox-state CAS rereads durable state.
   If the winning cursor already covers its zero-observation work, it converges quietly;
   material work performs one bounded reconciliation from the winner before at most one
   further CAS. Cursor victory alone never discards material evidence.
3. **Covered push during watch renewal.** A delayed/duplicate push can take the cheap
   covered path only when renewal did not advance the provider baseline. If
   `users.watch` returns a newer history ID, history catch-up runs before recovery is
   declared.
4. **Expired Gmail history cursor.** The old degraded cursor remains durable. Recovery
   creates a fresh watch baseline, takes a bounded complete `Label_5` membership
   snapshot, reconciles history from that baseline through a final cursor, then commits
   current membership + post-baseline changes + recovered subscription state in one CAS.
   Partial snapshot/history failure leaves the old degraded cursor untouched.
5. **Missed push.** The hourly handler reconciles from the durable history cursor even
   without a Pub/Sub delivery.
6. **Hygiene failure.** Scheduled catch-up and covered duplicate pushes repeat only the
   `Label_5 + INBOX` cleanup, so archive/read state converges independently from cursor
   advancement.

## Fixed checked-in bindings

These values are committed in `wrangler.jsonc`:

```text
STENSIBLY_GMAIL_MAILBOX=leoli.4u@gmail.com
STENSIBLY_GMAIL_MAILBOX_BINDING_ID=gmail_operator_primary
STENSIBLY_GMAIL_WATCH_LABEL_ID=Label_5
STENSIBLY_GMAIL_PUBSUB_AUDIENCE=https://api.stensibly.com/internal/gmail/pubsub
```

The production binding verifier requires the following protected values to exist on the
Worker version without retaining their contents:

```text
STENSIBLY_GMAIL_OAUTH_CLIENT_ID
STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET
STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN
STENSIBLY_GMAIL_PUBSUB_TOPIC
STENSIBLY_GMAIL_PUBSUB_SUBSCRIPTION
STENSIBLY_GMAIL_PUBSUB_SERVICE_ACCOUNT
```

Keep every credential value inside the Google/Cloudflare protected interfaces. GitHub,
chat, Gmail handoffs, logs, screenshots, fixtures, and artifacts contain only binding
names and non-secret provider identities.

## Repository acceptance is separate from provider provisioning

Repository acceptance is exact-head source/CI/review evidence. The implementation may
merge before the six protected Google values exist. The live #1498 dogfood issue remains
open until the provider lane is provisioned and the real no-chat closed loop is proved.
Secret availability is never used as a reason to keep already-accepted source code in a
draft branch.

## One-time Google Cloud setup

Use one operator-controlled Google Cloud project for the Gmail API and Pub/Sub objects.
The project in the Gmail `users.watch` topic name must be the same Google developer
project making the watch request.

1. Create or select a Google OAuth client for the operator mailbox and complete a
   refresh-token grant for `leoli.4u@gmail.com` with the smallest single scope needed by
   this first loop:

   ```text
   https://www.googleapis.com/auth/gmail.modify
   ```

   That scope covers history/watch reads, label modification/archive, and Gmail send.
2. Create a Pub/Sub topic dedicated to Stensibly Gmail handoffs. Grant
   `gmail-api-push@system.gserviceaccount.com` Pub/Sub Publisher on that topic so Gmail
   can publish mailbox notifications.
3. Create one dedicated user-managed service account for authenticated push delivery.
   Create a push subscription on the topic with:

   ```text
   endpoint: https://api.stensibly.com/internal/gmail/pubsub
   authentication: enabled
   push auth service account: <dedicated service account>
   audience: https://api.stensibly.com/internal/gmail/pubsub
   payload wrapping: standard Pub/Sub JSON envelope
   ```

   The Google-managed Pub/Sub service agent
   `service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com` needs Service Account
   Token Creator on the push-auth service account (or equivalent scope granting
   `iam.serviceAccounts.getOpenIdToken`). The principal creating/updating the push
   subscription needs `iam.serviceAccounts.actAs` on that service account.
4. Store the OAuth client ID/secret/refresh token and the exact topic, subscription, and
   push-auth service-account identities in the six protected Worker bindings listed
   above. Never paste the values into GitHub, chat, Gmail, logs, screenshots, tests, or
   artifacts.

Provider references:

- Gmail push notifications: https://developers.google.com/workspace/gmail/api/guides/push
- Gmail `users.watch`: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
- Gmail OAuth scopes: https://developers.google.com/identity/protocols/oauth2/scopes
- Authenticated Pub/Sub push: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions

## Verification after protected setup

After the repository candidate is merged and the protected values are written directly
to the Worker environment:

1. let the normal protected Worker deployment publish current `main`;
2. verify the released Worker version contains every required binding name;
3. run/observe the hourly scheduled handler once; durable mailbox binding
   `gmail_operator_primary` must appear with provider `gmail`, scope `Label_5`, healthy
   subscription state, and a `gmail_history_id` cursor returned by `users.watch`;
4. create or update one bounded `Stensibly/Handoffs` message; authenticated Pub/Sub
   delivery must return HTTP 204 only after history reconciliation and durable Convex
   commit;
5. prove the durable material row survives independently from that push and drain it by
   observation ID after the original Pub/Sub delivery is gone;
6. let merged #1528 resolve its exact provider/STN binding and fetch only that admitted
   Gmail message transiently; persist content-minimized semantic evidence;
7. exercise one governed continuation/outbound effect through the hosted #1518 sender;
   retain the exact outbound effect/provider message/thread identity durably;
8. observe a later real reply through Gmail history and admit it as a new durable
   observation; where the semantic evidence requests a GitHub effect, re-read current
   GitHub state and pass only the server-owned #1517/#1541 authority binding downstream;
9. observe the returning sent agent message in Gmail history and confirm the hosted exact
   provider-message lookup classifies it `self_echo`, with zero material wake;
10. confirm routine handoff mail remains searchable under `Stensibly/Handoffs`, is read,
    and is absent from the normal Inbox.

Then exercise these recovery controls against the real provider path:

- duplicate Pub/Sub delivery;
- missed push recovered by hourly catch-up;
- watch bootstrap and renewal;
- expired/stale Gmail history cursor and full rebaseline;
- callback OIDC/auth failure;
- wrong account/mailbox/label scope;
- delayed continuation drain after the original push is gone;
- repeated `Label_5 + INBOX` hygiene repair;
- provider/API ambiguity and exact readback/reconciliation;
- process restart between observation admission and downstream drain;
- process restart after outbound provider success and before caller response.

Provider notification IDs, Gmail history IDs, provider message/thread IDs, mailbox
metadata, visible recipients, and email prose grant zero GitHub authority throughout.
They carry evidence and continuation identity only.

## Recovery / rollback

Disable/remove the Pub/Sub push subscription and the Gmail protected bindings or revert
the unattended runtime merge. Existing mailbox cursors, observations, semantic evidence,
and outbound provider projections remain independent durable evidence.

When a durable cursor is stale/expired, recovery preserves that degraded cursor until a
complete watch + label snapshot + post-baseline history reconciliation can commit a new
continuous cursor atomically. Never replace the cursor with a fresh watch ID by itself.

— Harbor · Gmail closed-loop lane
  Intention: make the first unattended Gmail handoff survive with exact provider identity, durable cursor truth, recoverable material evidence, and a quiet Inbox
