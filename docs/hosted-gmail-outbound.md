# Hosted Gmail outbound runtime

Refs #1488, #1518, merged #1497. Composition seams: #1511, #1522, #1508/#1506.

## Purpose

The merged outbound-mail engine already owns canonical `STN-*` thread identity, deterministic material fingerprints, provider projections, retry/reconciliation semantics, and delivery receipts. This lane supplies the hosted durability and Gmail runtime mount required for unattended workers.

Production flow:

```text
admitted current STN material
  -> HostedGmailOutboundService
  -> ConvexMailThreadStore
  -> atomic outbound reservation / active lane
  -> GmailMailProvider
  -> GmailOutboundApiClient
  -> protected Gmail access-token provider
  -> Gmail API
  -> Convex receipt + provider projection + provider-message index
```

Canonical STN thread identity remains the durable conversation key. Gmail thread/message IDs stay provider projections.

## Hosted durability

`ConvexMailThreadStore` implements the same `MailThreadStore` interface used by `MailOutboundService`. The Convex tables preserve:

- canonical thread rows with exact source and handle lookup;
- provider projection rows with exact provider/account/mailbox destination;
- outbound effect attempts with deterministic IDs and fingerprints;
- one active delivery lane per canonical thread/provider/account;
- successful/reconciled provider-message identity for restart-safe self-echo lookup.

Convex mutations perform read + reservation/settlement writes atomically. Competing Worker instances therefore converge through Convex OCC onto one active effect lane. Every returned JSON record is re-admitted through the merged #1497 validators before it reaches domain logic.

## Crash and replay contract

Hosted conformance covers these boundaries:

1. **Before reservation** — a fresh process can publish the same admitted material and create one effect.
2. **After reservation, before dispatch** — the active lane fences later publishers; reconciliation marks a completely absent provider effect failed, then deterministic attempt `N+1` may dispatch.
3. **After Gmail accepts, before durable settlement** — restart reconciles by deterministic RFC `Message-ID` plus Stensibly effect identity; provider success settles without a second send.
4. **After durable settlement, before caller response** — replay returns the durable receipt and sends zero additional messages.
5. **Ambiguous provider result** — the lane remains fenced until bounded exact provider readback resolves the outcome.
6. **Definite failure** — the next publish reserves the same deterministic retry identity for attempt `N+1`.

Material change after a successful effect creates one new effect and replies on the existing Gmail provider thread. Thread splits create a new canonical handle with explicit parent ancestry.

## Protected Gmail composition

`GmailOutboundApiClient` accepts only a `GmailAccessTokenProvider`. It owns Gmail send/search/metadata calls and bounded response admission. OAuth client secrets, refresh tokens, access-token refresh policy, Pub/Sub identities, `users.watch`, history reconciliation, and mailbox cursors belong to #1511.

`createHostedGmailOutboundRuntime(...)` composes:

- a Convex caller;
- the protected Convex service secret;
- one server-owned workspace/project/Gmail account/mailbox binding;
- a `GmailAccessTokenProvider` supplied by the protected runtime;
- the existing `GmailMailProvider` semantics from #1497.

The publish surface accepts bounded admitted STN material. Destination, provider, workspace, and project come from server configuration. Provider-message lookup is intentionally narrow so #1511 can classify a returning Gmail message as known outbound/self-echo.

Inbox/archive/read disposition remains the #1522 lane. Bridge-handle convergence remains #1508/#1506.

## Deployment requirements

Repository/runtime implementation can ship independently of provider provisioning. Live hosted Gmail delivery requires the protected provider boundary described by #1511 plus the hosted Convex binding:

- production Convex deployment reachable by the Worker;
- `STENSIBLY_SERVICE_SECRET` in the Worker and Convex environment;
- fixed hosted outbound binding for workspace, project, Gmail account binding, and mailbox address;
- protected Gmail OAuth client/refresh-token values from #1511 stored directly in the runtime secret interface;
- Gmail access-token provider created from that protected refresh boundary;
- Gmail API scope accepted by the #1511 provisioning contract.

Keep credential values in Google/Cloudflare protected interfaces. Durable mail rows contain canonical IDs, provider IDs, fingerprints, bounded receipts, and exact mailbox identity only.

## Tiny live verification after provider bindings exist

1. Publish one harmless admitted `STN-HANDOFF:*` continuation through `createHostedGmailOutboundRuntime`.
2. Confirm Gmail receives one message and Convex records the sent receipt, Gmail thread ID, Gmail message ID, and deterministic RFC message ID.
3. Restart the Worker/process and construct a fresh hosted runtime using the same Convex deployment and protected binding.
4. Publish one material update for the same canonical source and confirm exactly one Gmail reply on the same Gmail thread.
5. Replay the old material/effect and confirm the Gmail send count stays unchanged.
6. Resolve the latest Gmail message ID through `getKnownOutboundProviderMessage` after restart.
7. Feed that exact provider message identity to #1511's known-outbound seam and confirm self-echo classification.
8. Treat Inbox visibility as separate #1522 evidence.

The official interactive Gmail connector remains useful for coordination and mailbox inspection. Production proof comes from the hosted Worker + Convex + protected Gmail provider path above.
