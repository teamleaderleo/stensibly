# Hosted Gmail outbound runtime

Refs #1488, #1518, merged #1497, #1522. Composition seams: #1511, #1508/#1506.

## Purpose

The merged outbound-mail engine already owns canonical `STN-*` thread identity, deterministic material fingerprints, provider projections, retry/reconciliation semantics, and delivery receipts. This lane supplies the hosted durability, Gmail runtime mount, and exact-message mailbox disposition required for unattended workers.

Production flow:

```text
admitted current STN material + server-owned current attention state
  -> HostedGmailOutboundService
  -> ConvexMailThreadStore
  -> atomic outbound reservation / active lane
  -> GmailMailProvider
  -> GmailOutboundApiClient
  -> protected Gmail access-token provider
  -> Gmail API
  -> durable #1497 receipt + exact provider identity
  -> ConvexGmailMailboxDispositionStore
  -> exact-message disposition lane/effect
  -> GmailMailboxDispositionApiClient
  -> exact Gmail label read/mutation/readback
  -> durable disposition settlement
```

Canonical STN thread identity remains the durable conversation key. Gmail thread/message IDs stay provider projections. Mail semantic class and Gmail presentation state do not decide human visibility.

## Hosted durability

`ConvexMailThreadStore` implements the same `MailThreadStore` interface used by `MailOutboundService`. The Convex tables preserve:

- canonical thread rows with exact source and handle lookup;
- provider projection rows with exact provider/account/mailbox destination;
- outbound effect attempts with deterministic IDs and fingerprints;
- one active delivery lane per canonical thread/provider/account;
- successful/reconciled provider-message identity for restart-safe self-echo lookup.

`ConvexGmailMailboxDispositionStore` adds the separate #1522 durability boundary:

- current server-owned STN mailbox state and revision per canonical thread;
- the latest exact successful/reconciled Gmail delivery target for that thread;
- immutable deterministic disposition effects;
- one unresolved exact-message mutation lane across account, mailbox, Gmail thread, and Gmail message identity;
- reconciliation phase and settled outcome for restart/readback recovery.

Convex mutations perform read + reservation/settlement writes atomically. Competing Worker instances therefore converge through Convex OCC onto one logical effect lane. Exact effect replay returns the durable record; altered replay under the same effect ID conflicts. Every returned JSON record is re-admitted before it reaches provider logic.

## Crash and replay contract

Hosted conformance covers these boundaries:

1. **Before outbound reservation** — a fresh process can publish the same admitted material and create one send effect.
2. **After outbound reservation, before dispatch** — the #1497 active lane fences later publishers; reconciliation may safely select deterministic attempt `N+1`.
3. **After Gmail accepts, before outbound durable settlement** — #1497 reconciles by deterministic RFC `Message-ID` plus Stensibly effect identity; provider success settles without a second send.
4. **After outbound durable settlement, before disposition reservation** — a repeated hosted service call replays the durable mail receipt, records the exact Gmail target, and applies disposition without sending another message.
5. **After disposition reservation, before Gmail mutation** — the exact-message lane survives restart and requires readback/reconciliation rather than a blind mutation replay.
6. **Gmail applies a label mutation but the response is lost** — exact-message label readback deterministically settles the same effect when the required/forbidden label set is satisfied.
7. **Gmail fails before applying** — same-revision uncertainty stays fenced until exact readback establishes a safe retry.
8. **Partial Gmail mutation** — same-revision ambiguity stays fenced. A newer genuine operator-attention revision may supersede an older partially applied quiet effect under the landed #1542 rule, then converge the current attention state.
9. **After durable disposition settlement, before caller response** — process restart replays the settled effect with zero second Gmail mutation.
10. **Duplicate hosted invocation** — durable outbound and disposition identities converge with zero duplicate mail or mutation.

Material change after a successful send creates one new mail effect and replies on the existing Gmail provider thread. A state-only attention transition calls `updateCurrentMailboxState()` and converges the same durably settled provider message without creating another email.

## Operator-attention authority

`operatorAttentionRequired` enters the hosted path only inside `source: "durable_stn_state"` with an explicit durable revision. The service persists that state separately from mail content and Gmail labels.

These inputs never grant or clear operator attention:

- `handoff`, `review`, `decision`, or `incident` semantic class;
- subject/body/quoted text or `STN-*` handle spelling;
- sender or plus-address;
- Gmail `INBOX` or `UNREAD` state;
- thread temperature or any mail-semantic admission content.

The provider side carries exact identity and presentation evidence only. Opening an STN email and changing Gmail `UNREAD` to read does not acknowledge work, accept responsibility, resolve attention, change eligibility, or grant authority. Durable current state remains authoritative per #1547. A later convergence for a new durable revision may restore `INBOX`/`UNREAD` when current policy still requires human attention.

## Protected Gmail composition

`GmailOutboundApiClient` and `GmailMailboxDispositionApiClient` both accept the narrow `GmailAccessTokenProvider` seam. The disposition client is label-only and bounded to one configured server-owned account/mailbox plus the exact message ID from the durable settled receipt.

Allowed disposition provider effects are only:

- exact-message label metadata read;
- retain/add the configured existing Stensibly label;
- add/remove `INBOX`;
- add/remove `UNREAD`;
- exact-message label readback.

It has no send/reply/thread/search/label-creation surface. OAuth client secrets, refresh tokens, access-token refresh policy, Pub/Sub identities, `users.watch`, history reconciliation, and mailbox cursors remain #1511 ownership.

`createHostedGmailOutboundRuntime(...)` composes:

- a Convex caller;
- the protected Convex service secret;
- one server-owned workspace/project/Gmail account/mailbox/Stensibly-label binding;
- a `GmailAccessTokenProvider` supplied by the protected runtime;
- the existing `GmailMailProvider` semantics from #1497;
- the durable Convex Gmail disposition store;
- the exact-message Gmail label client.

The publish surface accepts admitted STN material plus server-owned current mailbox state/revision. Destination, provider, workspace, project, and Stensibly label ID come from server configuration. Provider-message lookup stays narrow so #1511 can classify returning Gmail as known outbound/self-echo.

## Deployment requirements

Repository/runtime implementation can ship independently of provider provisioning. Live hosted Gmail delivery and disposition require the protected provider boundary described by #1511 plus the hosted Convex binding:

- production Convex deployment reachable by the Worker;
- `STENSIBLY_SERVICE_SECRET` in the Worker and Convex environment;
- fixed hosted binding for workspace, project, Gmail account binding, mailbox address, and existing Stensibly label ID;
- protected Gmail OAuth client/refresh-token values from #1511 stored directly in the runtime secret interface;
- Gmail access-token provider created from that protected refresh boundary;
- Gmail API scope accepted by the #1511 provisioning contract.

Keep credential values in Google/Cloudflare protected interfaces. Durable mail/disposition rows contain canonical IDs, provider IDs, revisions, fingerprints, bounded receipts, exact mailbox identity, and label-policy outcomes only.

## Tiny live verification after provider bindings exist

1. Publish one harmless admitted routine `STN-HANDOFF:*` continuation through `createHostedGmailOutboundRuntime` with durable `active + operatorAttentionRequired=false` state.
2. Confirm one Gmail message, one durable #1497 sent receipt, and automatic exact-message disposition to Stensibly + archived/read.
3. Replay the same service command and confirm both Gmail send count and label-mutation count stay unchanged.
4. Publish one fresh harmless current operator-attention specimen with `operatorAttentionRequired=true`; confirm Stensibly + `INBOX` + `UNREAD` on its exact receipt-bound message.
5. Open/read that message and confirm only Gmail presentation changes; durable current state remains active + human-required.
6. Persist a newer resolved state for the same canonical thread through `updateCurrentMailboxState()` and confirm the same Gmail message loses `INBOX` + `UNREAD` while retaining Stensibly, with no new mail.
7. Exercise one response-lost/ambiguous label mutation and confirm exact readback settles it without blind duplicate mutation.
8. Restart the Worker/process and confirm durable state, provider target, effect identity, and settled outcome replay without extra mail or label mutation.
9. Resolve the provider message through `getKnownOutboundProviderMessage` and feed only that exact identity to #1511's known-outbound seam for self-echo classification.

The official interactive Gmail connector remains useful for coordination and mailbox inspection. Production proof comes from the hosted Worker + Convex + protected Gmail provider path above.
