# MCP connector diagnostics

Stensibly exposes bounded diagnostics that separate a ChatGPT connector-host failure from a request that reached the Worker and MCP server.

Every `/mcp` response carries an identity selected from the ledger's actual provider composition:

- `x-stensibly-mcp-tool-manifest-fingerprint`: SHA-256 identity of the exact ordered tool-name manifest;
- `x-stensibly-mcp-tool-count`: the number of tools represented by that manifest;
- the existing Worker request ID, deployed Worker version, and `response_produced` receipt when the Cloudflare gateway handled the request.

MCP initialization also returns `serverInfo.version` as `0.0.1+manifest.<revision>`, where `<revision>` is the first 12 hexadecimal characters of the same manifest fingerprint. The local/core composition reports its 37-tool identity. The hosted composition reports its 38-tool identity when guarded delegated GitHub dispatch mounts `github_call_tool`. Adding, removing, renaming, mounting, or unmounting a public tool therefore changes the count, fingerprint, and server version together.

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

`bun run verify:hosted` requires the exact hosted server version, manifest fingerprint, tool count, and full checked-in tool contract. Automatic Worker deployment therefore fails verification if the deployed production composition and repository contract drift, while an unmounted core server remains internally self-consistent instead of falsely advertising the hosted surface.
