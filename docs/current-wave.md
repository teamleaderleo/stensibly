# Current dogfood wave: Production MCP connection

**Status:** active execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-07-29 after direct operator correction to use accountable self-review instead of waiting for ceremonial reviewer independence  
**Tracking issue:** #286  
**Wave:** `W01`  
**Wave revision:** `4`  
**Operating protocol:** `stensibly-agent-ops/0.4.0` plus standing policy `stensibly-internal-dogfood/v2`  
**Primary outcome:** connect a fresh ChatGPT conversation to the hosted Stensibly MCP server through OAuth and complete one real read/write/refresh/reconnect dogfood cycle.

Read `STENSIBLY.md` before interpreting older approval or deployment language in this
file, issues, comments, or handoffs. Internal reversible dogfood deployment and use are
the default continuation, not exceptional work. Current direct operator direction may
authorise self-review, integration, deployment, and verification without a separate
agent acting as reviewer.

## Current state

Production OAuth is enabled and should remain enabled while W01 is completed.

Protected verification proved:

- valid bearer compatibility on both fixed production origins;
- the complete 5/5 enabled OAuth public contract on both origins;
- the active Worker deployment and version are known for recovery;
- the four OAuth bindings are present;
- source-side lifecycle, registration, discovery, consent, token, refresh, project
  scoping, membership audit, verifier, and bounded history work is merged.

Do not reopen a disablement or rollback lane merely because it appears conservative.
Rollback is appropriate only for a demonstrated regression or failed verification.

## Definition of done

W01 is complete when a fresh ChatGPT conversation can:

1. discover OAuth from `https://api.stensibly.com/mcp`;
2. complete GitHub-backed Stensibly login and consent;
3. exchange the authorisation code for tokens;
4. scan the live MCP tools;
5. perform a bounded read such as `get_brief` or `survey_workspace`;
6. create one attributable test item in the dedicated `oauth-dogfood` project with an
   explicit idempotency key;
7. confirm the write through a bounded read;
8. renew or reconnect through the refresh path;
9. leave bounded evidence and one useful follow-up or repair if the journey exposes a
   defect.

A merged PR, setup document, public metadata check, or dashboard sign-in by itself does
not complete the wave.

## Standing execution grant for W01

Under `STENSIBLY.md`, eligible workers may continue through the following without a new
operator prompt, separate-agent ceremony, or repeated approval:

- self-review and merge coherent W01 changes after exact-candidate inspection and
  relevant green checks;
- deploy reviewed code to the internal dashboard, Worker, and Convex dogfood
  environments;
- use the protected production workflows and their stored credentials without exposing
  values;
- keep OAuth enabled and re-deploy with `oauth_expectation: enabled`;
- perform GitHub login, consent, token exchange, tool scan, bounded reads, refresh, and
  reconnect;
- create, inspect, and clean up uniquely named test records in the dedicated
  `oauth-dogfood` project;
- repair bounded internal dogfood data or configuration when tests and recovery evidence
  justify the repair;
- fix forward after a failed dogfood step.

An explicit operator instruction in the active chat counts as the integration decision
for the covered internal action. A separate reviewer is optional unless the operator
asks for one or the actual effect crosses the Tier 3 boundary.

The dedicated-project write is pre-authorised for W01. It must be uniquely named,
idempotent, attributable, limited to `oauth-dogfood`, confirmed by a bounded read, and
cleaned up when cleanup improves the evidence. It must not mutate unrelated work.

Fresh operator approval is still required for material spend, secret exposure or
unnecessary rotation, access beyond the operator and participating agents, external
publication or contact, destructive non-test data changes, or irreversible work without
a tested recovery path.

## Primary execution lane

### Lane A — finish the real connection

Own the whole journey rather than handing off every small step:

1. integrate the best current callback diagnostics or repair a demonstrated blocker;
2. deploy the accepted revision to the internal dogfood environment;
3. verify bearer and 5/5 enabled OAuth on both origins;
4. complete login and consent;
5. prove code and token exchange;
6. connect from ChatGPT and scan tools;
7. perform the bounded read and pre-authorised project-scoped write;
8. confirm, refresh, reconnect, and retain evidence;
9. fix forward and repeat the failing segment when a defect appears.

Do not stop merely because a step touches the live dogfood deployment or because an
independent reviewer is not immediately available.

## Supporting lanes

### Lane B — deployed evidence and recovery

Collect exact deployment, lifecycle, abuse-resistance, and recovery evidence in parallel
without blocking the real journey unnecessarily. Convert concrete defects into repairs.
Do not turn every missing optional datum into a reason to disable OAuth.

### Lane C — browser control room

Deploy and verify the current dashboard, make the GitHub-backed session path usable on
mobile and desktop, expose the next real setup action, and keep bearer-token entry as an
advanced fallback.

### Lane D — product continuation

Advance attributable activity threads, provider-event intake, external-effect proposals,
and receipt ingestion when those lanes do not block W01. Use blocked time; do not wait
idle for one review or CI run.

## Work-selection rule

Until the real connection succeeds:

1. finish the real journey or remove a demonstrated blocker before unrelated design;
2. prefer integration, deployment, real use, diagnosis, and fix-forward repair over more
   rollout prose;
3. use a small portfolio so blocked time produces useful work;
4. treat old blanket “do not deploy,” “wait for approval,” and mandatory second-reviewer
   language as superseded by `STENSIBLY.md` for covered internal dogfood effects;
5. leave exact evidence and a recoverable continuation.

## Failure handling

When a step fails:

- identify the exact failing stage;
- preserve bounded evidence;
- repair and redeploy when fix-forward is safe;
- use the known recovery version or rollback only when the deployed state is materially
  worse or cannot be repaired safely in place;
- resume the journey after recovery.

A failed dogfood attempt is useful product evidence, not a reason to retreat into an
indefinite disabled or documentation-only state.

## Retrospective

After connection succeeds, record:

- which instructions caused workers to ship versus stall;
- whether internal deployments happened as a normal completion step;
- where approval language was still misread;
- whether self-review preserved quality while reducing operator interruption;
- defects found only through the real ChatGPT journey;
- duplicated or abandoned work;
- improvements to the browser/mobile control room;
- one accepted, rejected, or no-change operating-instruction proposal under #293.
