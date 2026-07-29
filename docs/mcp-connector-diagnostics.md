# MCP connector diagnostics

Stensibly exposes bounded diagnostics that separate a ChatGPT connector-host failure from a request that reached the Worker and MCP server.

Every `/mcp` response carries:

- `x-stensibly-mcp-tool-manifest-fingerprint`: SHA-256 identity of the exact ordered tool-name manifest;
- `x-stensibly-mcp-tool-count`: the number of tools represented by that manifest;
- the existing Worker request ID, deployed Worker version, and `response_produced` receipt when the Cloudflare gateway handled the request.

The manifest contains tool names only. It excludes descriptions, schemas, arguments, tokens, projects, item identifiers, payloads, and private content.

Gateway-generated JSON-RPC failures also include bounded `error.data` when a valid `x-request-id` is present. The data identifies:

- responsible layer and processing stage;
- request ID;
- whether direct retry is safe;
- whether a possible write must be reconciled by idempotency/read-after-write before retry;
- a bounded recommended action;
- the manifest fingerprint and tool count;
- an allowlisted MCP method and known tool name when available.

This does not repair a ChatGPT registry failure that happens before network dispatch. In that case no Worker receipt or manifest header can exist, which is itself the diagnostic distinction. A discovered schema set can be compared with the server manifest only after a request reaches `/mcp`.

`bun run verify:hosted` requires the exact manifest fingerprint and tool count on MCP initialization, so automatic Worker deployment fails verification if the deployed tool registry and repository contract drift.
