# Workspace surveyor

Stensibly exposes one read-only `survey_workspace` MCP tool for centralized dispatch and monitoring.

The tool does not claim work, run models, edit repositories, or decide business transitions. It turns the current ledger into one bounded snapshot that a ChatGPT conversation, scheduled task, script, or inexpensive model can consume.

## What the survey returns

Each response includes:

- counts across ready, active, blocked, done, and archived work
- per-project counts and latest activity
- ready work ordered as dispatch candidates
- active work ordered by lease urgency
- invalid, expired, and soon-expiring claim groups
- blocked work and recent completions
- a SHA-256 fingerprint over material ledger state
- `changed` when the caller supplies a previous fingerprint
- `notifyRecommended` when actionable state is new or changed

Elapsed seconds are excluded from the fingerprint. A repeated check remains unchanged until ledger data changes or a lease crosses into another urgency class.

## MCP input

```json
{
  "project": "smolrunner",
  "limit": 10,
  "expiringWithinSeconds": 900,
  "previousFingerprint": "sha256:..."
}
```

All fields are optional. An all-project read token may omit `project`. A token with a project allowlist must name one allowed project.

The hosted endpoint is:

```text
https://api.stensibly.com/mcp
```

It requires an opaque Stensibly Bearer token with read scope. A survey-only token should have no write or admin scope.

## ChatGPT app setup

Create a custom MCP app in ChatGPT developer mode using the hosted MCP endpoint and a read-only survey token. Scan the server tools after connecting so `survey_workspace` appears as a read action.

A scheduled survey prompt can use this policy:

```text
Use the Stensibly survey_workspace tool to inspect current work. Pass the
fingerprint from the previous successful survey when available.

Notify me only when notifyRecommended is true. Prefer one highest-value ready
item that can be assigned to a fresh ChatGPT chat without colliding with active
work. Include the project, item ID, reason it is ready, relevant blockers or
active overlap, expected evidence, and a complete prompt I can copy into a new
chat.

When attention.urgent is true, lead with the exact expired or invalid claim and
the human decision or recovery action required. Do not claim, modify, or
complete work.
```

ChatGPT scheduled tasks can perform recurring app-backed checks. Their cadence and notification delivery remain owned by ChatGPT rather than Stensibly.

## Sub-hour polling without spending a model call every time

A lightweight service can call MCP every few minutes, persist the returned fingerprint, and stop immediately when `changed` is false. Invoke a model only when the survey reports a material change or actionable state.

First request:

```bash
curl --fail-with-body --silent --show-error \
  https://api.stensibly.com/mcp \
  -H "authorization: Bearer $STENSIBLY_TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2025-06-18" \
  --data-binary @- <<'JSON'
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "survey_workspace",
    "arguments": {
      "limit": 10,
      "expiringWithinSeconds": 900
    }
  }
}
JSON
```

On later requests, add the exact fingerprint returned by the previous successful call:

```json
"previousFingerprint": "sha256:0123456789abcdef..."
```

A practical loop is:

1. poll every 5 to 15 minutes with no model involved
2. parse the JSON text from the MCP result
3. persist `fingerprint`
4. exit when `changed` is false
5. when state changed, send the bounded survey to a low-cost model for dispatch wording
6. escalate to a stronger ChatGPT chat only for implementation, review, or a human decision

This keeps scheduling and provider choice outside the ledger while preserving one coordination record for every client.
