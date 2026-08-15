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

The Worker watches only `Label_5`. Reconciliation uses the merged #1495 contracts and
commits the next cursor plus admitted observations atomically in Convex. The downstream
material projection consumes the canonical provider-neutral mailbox observation v2
fields from #1513, including `mail.scope.added` / `mail.scope.removed` and
`providerScopeId`. A downstream mail/GitHub bridge consumes durable
`wakeEligible + ordinary` observation rows by observation identity; Pub/Sub delivery is
never the only chance to process a material reply.

`Stensibly/Handoffs` is the quiet agent-continuation lane. Every runtime pass performs a
bounded Gmail query for messages carrying both `Label_5` and `INBOX`, then removes
`INBOX` and `UNREAD` from those messages while preserving `Label_5` and the mail object.
The same sweep runs on covered duplicate pushes, so a failed archive after a durable
cursor commit is recoverable. Genuine operator-attention mail belongs in a distinct
attention projection/view and is outside this watched auto-archive lane.

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
chat, logs, screenshots, fixtures, and artifacts should contain only binding names and
non-secret provider identities.

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
   above. Do not paste the values into GitHub or chat.

Provider references:

- Gmail push notifications: https://developers.google.com/workspace/gmail/api/guides/push
- Gmail `users.watch`: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
- Gmail OAuth scopes: https://developers.google.com/identity/protocols/oauth2/scopes
- Authenticated Pub/Sub push: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions

## Verification after protected setup

The integration worker can complete the remainder under `STENSIBLY.md`:

1. merge the exact green #1498 candidate;
2. let the normal protected Worker deployment publish it;
3. verify the released Worker version contains every required binding name;
4. run/observe the hourly scheduled handler once; durable mailbox binding
   `gmail_operator_primary` must appear with provider `gmail`, scope `Label_5`, healthy
   subscription state, and a `gmail_history_id` cursor returned by `users.watch`;
5. create or update one bounded `Stensibly/Handoffs` message; authenticated Pub/Sub
   delivery must return HTTP 204 only after history reconciliation and durable Convex
   commit;
6. replay the same push and confirm no duplicate observation while the quiet-mail sweep
   still leaves `Label_5 + INBOX` empty;
7. confirm the admitted handoff remains labeled/searchable, read, and outside Inbox;
8. drain the durable material-observation projection by observation ID. Only after a
   durable row names an exact provider message should a consumer fetch that one Gmail
   message body transiently for #1496 reply classification;
9. after #1497's outbound provider is integrated, supply its exact provider message IDs
   to the reconciliation seam so the returning mailbox observation classifies as
   `self_echo` and stays out of the material drain;
10. for a real human/worker reply, refresh the bound GitHub object and apply #1496's
    exact current-state classification/projection. Persist the continuation or perform
    the bounded GitHub projection only through the existing current authority path.

## Recovery

Disable/remove the Pub/Sub push subscription and the Gmail protected bindings or revert
the #1498 runtime commit. Existing #1495 mailbox cursors and observations remain
independent durable evidence. Re-establishing the same mailbox binding resumes from the
stored cursor; a stale/invalid Gmail cursor follows #1495's explicit full-sync recovery
path rather than inventing continuity.

— Harbor · Gmail closed-loop lane
  Intention: make the first unattended Gmail handoff survive with exact provider identity, durable cursor truth, recoverable material evidence, and a quiet Inbox
