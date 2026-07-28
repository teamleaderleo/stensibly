# Engineering incident lessons

This document is the durable index for expensive bugs, failed assumptions, misleading diagnostics, and reusable engineering lessons discovered while building Stensibly.

Use it for incidents that are worth remembering even after the immediate issue and pull request are closed. Keep full technical narratives in `docs/postmortems/`; keep this file concise enough that a new worker can scan it before touching a risky subsystem.

## How to add an incident

Add an entry when one or more of the following is true:

- the defect blocked a major dogfood journey or deployment;
- the repair required multiple competing hypotheses or production experiments;
- tests passed while production failed for a systematic reason;
- an abstraction hid an important runtime, authority, data, or compatibility boundary;
- the same class of mistake could recur elsewhere;
- the incident changed how future work should be reviewed, tested, observed, or operated.

Each entry should include:

1. **Symptom** — what users or operators observed.
2. **Root cause** — the smallest causal technical statement supported by evidence.
3. **Why it escaped** — the missing test, misleading abstraction, or observability gap.
4. **Misleading hypotheses** — plausible ideas that were falsified.
5. **Permanent lesson** — the rule future workers should apply.
6. **Evidence** — issue, PR, commit, deployment, and full postmortem links.

Do not turn this into a blame ledger. Record decisions and system conditions precisely enough to improve the next investigation.

---

## 2026-07-29 — Cloudflare Worker fetch receiver broke GitHub OAuth

**Subsystem:** hosted authentication, Cloudflare Workers, GitHub OAuth  
**Impact:** blocked hosted sign-in and the W01 ChatGPT MCP connection journey  
**Full postmortem:** [The GitHub OAuth request that never left the Worker](postmortems/2026-07-29-cloudflare-fetch-receiver.md)

### Symptom

The OAuth callback repeatedly returned a token-exchange `network_exception`. Later bounded diagnostics narrowed it to a `type_error` during `preflight` at the `LAX` Cloudflare colo.

### Root cause

The application stored native Worker `fetch` as a property of `HttpGitHubOAuthClient` and invoked it as `this.fetchImpl(...)`. JavaScript therefore passed the client instance as the function's `this` receiver. The Worker runtime rejected the receiver-sensitive host-function invocation before making an outbound request.

### Why it escaped

- Test doubles were arrow functions and ignored receiver rebinding.
- Direct Worker probes called global `fetch(...)` rather than the production adapter.
- `typeof fetch` imported a host object's broader shape instead of defining the minimal callable capability the client required.
- Initial errors grouped local programming exceptions together with genuine network failures.

### Misleading hypotheses

The incident was not caused by:

- invalid GitHub OAuth credentials;
- callback URL configuration;
- DNS or TLS;
- Vercel/Cloudflare double proxying;
- GitHub unavailability;
- request timeouts;
- `AbortSignal.timeout`;
- `cache: "no-store"`;
- `redirect: "manual"`.

Some of those were reasonable suspects at earlier diagnostic stages. They became wrong only after later evidence falsified them.

### Permanent lesson

Treat host APIs as receiver-sensitive capabilities unless proven otherwise. Wrap ambient runtime functions in application-owned closures and type dependencies by the minimal callable contract. Production probes must execute the production adapter, not merely reproduce its destination and request fields.

### Evidence

- Tracking: #286
- Failure classification: PR #447, merge `a6645e7affbfcb61600df7e95e511a17efcc2d28`
- Bounded diagnostics and preflight: PR #449, merge `527aa0fdb5d50ad66e893eb6c5f1abed2626f613`
- Operation classification: PR #452, merge `daa7a286aea2d897f9daf6c0420881329d8ade33`
- Final repair: PR #455, merge `3aa6a01a6a4543783bf04c1b3c26f55a7e7249fb`
- Production verification: run `30393846940`

### Follow-up checklist

- [ ] Add a Worker-runtime integration test around the production GitHub adapter.
- [ ] Audit stored host functions for receiver-sensitive invocation.
- [ ] Prefer minimal application capability types over ambient `typeof` globals.
- [ ] Keep bounded `stage`, `reason`, `detail`, `operation`, and `colo` diagnostics.
- [ ] Compare probe call syntax with production call syntax during incident review.

---

## Entry template

```md
## YYYY-MM-DD — Incident title

**Subsystem:**  
**Impact:**  
**Full postmortem:**

### Symptom

### Root cause

### Why it escaped

### Misleading hypotheses

### Permanent lesson

### Evidence

### Follow-up checklist

- [ ]
```
