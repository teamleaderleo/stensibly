import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import {
  MCP_CORE_SERVER_VERSION,
  MCP_CORE_TOOL_MANIFEST_FINGERPRINT,
  MCP_CORE_TOOL_MANIFEST_REVISION,
  MCP_CORE_TOOL_NAMES,
  MCP_ENROLMENT_TOOL_MANIFEST,
  MCP_GITHUB_TOOL_MANIFEST,
  MCP_FAILURE_STAGE_HEADER,
  MCP_SERVER_VERSION,
  MCP_TOOL_COUNT_HEADER,
  MCP_TOOL_MANIFEST_FINGERPRINT,
  MCP_TOOL_MANIFEST_FINGERPRINT_HEADER,
  MCP_TOOL_NAMES,
  mcpToolManifestForLedger,
  withMcpDiagnostics,
} from "../src/mcp-diagnostics.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { FAILURE_CATEGORY_HEADER } from "../src/worker-observability.ts";
import {
  initializeMessage,
  mcpRequest,
  toolsListMessage,
} from "./support/mcp-http.ts";
import {
  withHostedGitHubDelegatedReadProvider,
  withHostedMcpProviders,
  withHostedWorkerEnrolmentProvider,
} from "./support/hosted-mcp-ledger.ts";

const diagnosticsClient = { clientName: "mcp-diagnostics-test" };

describe("MCP connector diagnostics", () => {
  test("publishes one stable manifest identity that matches initialize and tools/list", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      expect(MCP_CORE_TOOL_MANIFEST_REVISION).toMatch(/^[a-f0-9]{12}$/);
      expect(MCP_CORE_SERVER_VERSION).toBe(
        `0.0.1+manifest.${MCP_CORE_TOOL_MANIFEST_REVISION}`,
      );
      expect(MCP_CORE_TOOL_MANIFEST_FINGERPRINT).toContain(
        MCP_CORE_TOOL_MANIFEST_REVISION,
      );

      const token = createApiToken(store, {
        name: "Manifest diagnostics reader",
        scopes: ["read"],
      });
      const app = createServerApp(store);
      const initialized = await mcpRequest(
        app,
        token.token,
        initializeMessage(1, diagnosticsClient),
      );
      expect(initialized.status).toBe(200);
      expect(initialized.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
        MCP_CORE_TOOL_MANIFEST_FINGERPRINT,
      );
      expect(initialized.headers.get(MCP_TOOL_COUNT_HEADER)).toBe(
        String(MCP_CORE_TOOL_NAMES.length),
      );
      const initializedPayload = await initialized.json() as {
        result?: { serverInfo?: { name?: unknown; version?: unknown } };
      };
      expect(initializedPayload.result?.serverInfo).toEqual({
        name: "stensibly",
        version: MCP_CORE_SERVER_VERSION,
      });

      const listed = await mcpRequest(app, token.token, toolsListMessage(2));
      const payload = await listed.json() as {
        result?: { tools?: Array<{ name?: unknown }> };
      };
      const names = (payload.result?.tools ?? [])
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === "string")
        .sort();
      expect(names).toEqual([...MCP_CORE_TOOL_NAMES]);
      expect(listed.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
        MCP_CORE_TOOL_MANIFEST_FINGERPRINT,
      );
    } finally {
      store.close();
    }
  });

  test("returns typed stage and reconciliation guidance for gateway MCP failures", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const token = createApiToken(store, {
        name: "Failure diagnostics reader",
        scopes: ["read"],
      });
      const app = createServerApp(store, {
        mcp: {
          createServer() {
            throw new Error("synthetic construction failure");
          },
        },
      });
      const response = await mcpRequest(
        app,
        token.token,
        initializeMessage(9, diagnosticsClient),
        { "x-request-id": "diag-construction-1" },
      );
      expect(response.status).toBe(500);
      expect(response.headers.get(MCP_FAILURE_STAGE_HEADER)).toBe("server_construction");
      expect(response.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
        MCP_CORE_TOOL_MANIFEST_FINGERPRINT,
      );
      const payload = await response.json() as {
        error?: { data?: Record<string, unknown> };
      };
      expect(payload.error?.data).toEqual({
        layer: "mcp",
        stage: "server_construction",
        requestId: "diag-construction-1",
        retryable: true,
        reconciliation: "safe_to_retry",
        recommendedAction: "retry_with_same_request_id",
        manifestFingerprint: MCP_CORE_TOOL_MANIFEST_FINGERPRINT,
        manifestToolCount: MCP_CORE_TOOL_NAMES.length,
        method: "initialize",
      });
    } finally {
      store.close();
    }
  });

  test("distinguishes keyed and unkeyed writes when execution may have completed", async () => {
    const keyed = await writeFailureDiagnostic("create_item", {
      project: "oauth-dogfood",
      title: "Ambiguous keyed write",
      idempotencyKey: "diagnostic-write-key",
    }, "diag-keyed-write");
    expect(keyed).toMatchObject({
      stage: "request_execution",
      retryable: false,
      reconciliation: "read_after_write_before_retry",
      recommendedAction: "reconcile_by_idempotency_key_before_retry",
      tool: "create_item",
      idempotencyKeyPresent: true,
    });

    const unkeyed = await writeFailureDiagnostic(
      "run_continuation_supervisor_policy",
      { project: "oauth-dogfood" },
      "diag-unkeyed-write",
    );
    expect(unkeyed).toMatchObject({
      stage: "request_execution",
      retryable: false,
      reconciliation: "read_after_write_before_retry",
      recommendedAction: "read_after_write_before_retry",
      tool: "run_continuation_supervisor_policy",
      idempotencyKeyPresent: false,
    });
  });

  test("publishes the full hosted manifest only when its optional providers are mounted", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const token = createApiToken(store, {
        name: "Hosted manifest diagnostics reader",
        scopes: ["read"],
      });
      const ledger = withHostedMcpProviders(new SqliteWorkLedger(store));
      const app = createServerApp(store, { ledger });
      const initialized = await mcpRequest(
        app,
        token.token,
        initializeMessage(10, diagnosticsClient),
      );
      const initializedPayload = await initialized.json() as {
        result?: { serverInfo?: { name?: unknown; version?: unknown } };
      };
      expect(initializedPayload.result?.serverInfo).toEqual({
        name: "stensibly",
        version: MCP_SERVER_VERSION,
      });
      expect(initialized.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
        MCP_TOOL_MANIFEST_FINGERPRINT,
      );
      expect(initialized.headers.get(MCP_TOOL_COUNT_HEADER)).toBe(
        String(MCP_TOOL_NAMES.length),
      );

      const listed = await mcpRequest(app, token.token, toolsListMessage(11));
      const payload = await listed.json() as {
        result?: { tools?: Array<{ name?: unknown }> };
      };
      const names = (payload.result?.tools ?? [])
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === "string")
        .sort();
      expect(names).toEqual([...MCP_TOOL_NAMES]);
      expect(names).toContain("github_call_tool");
      expect(names).toContain("enrol_worker");
      expect(listed.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
        MCP_TOOL_MANIFEST_FINGERPRINT,
      );
      expect(listed.headers.get(MCP_TOOL_COUNT_HEADER)).toBe(
        String(MCP_TOOL_NAMES.length),
      );
    } finally {
      store.close();
    }
  });

  test("keeps optional-provider manifest identities truthful for partial compositions", () => {
    const githubStore = new StensiblyStore(":memory:");
    const enrolmentStore = new StensiblyStore(":memory:");
    try {
      expect(mcpToolManifestForLedger(withHostedGitHubDelegatedReadProvider(
        new SqliteWorkLedger(githubStore),
      ))).toBe(MCP_GITHUB_TOOL_MANIFEST);
      expect(mcpToolManifestForLedger(withHostedWorkerEnrolmentProvider(
        new SqliteWorkLedger(enrolmentStore),
      ))).toBe(MCP_ENROLMENT_TOOL_MANIFEST);
    } finally {
      githubStore.close();
      enrolmentStore.close();
    }
  });
});

async function writeFailureDiagnostic(
  tool: string,
  args: Record<string, unknown>,
  requestId: string,
): Promise<Record<string, unknown>> {
  const request = new Request("https://api.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const response = new Response(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id: 1,
  }), {
    status: 500,
    headers: {
      "content-type": "application/json",
      [FAILURE_CATEGORY_HEADER]: "mcp_failure",
      [MCP_FAILURE_STAGE_HEADER]: "request_execution",
    },
  });
  const diagnosed = await withMcpDiagnostics(request, response);
  const payload = await diagnosed.json() as {
    error?: { data?: Record<string, unknown> };
  };
  if (!payload.error?.data) throw new Error("Missing MCP failure diagnostics");
  return payload.error.data;
}

describe("MCP gateway validation diagnostics", () => {
  test("classifies origin and Host denials as exact gateway validation failures", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const token = createApiToken(store, {
        name: "Gateway diagnostics reader",
        scopes: ["read"],
      });
      const app = createServerApp(store, {
        mcp: {
          allowedOrigins: ["https://allowed.example"],
          allowedHosts: ["allowed.example"],
        },
      });
      const cases = [
        {
          requestId: "diag-origin-validation",
          stage: "origin_validation",
          origin: "https://blocked.example",
          host: "allowed.example",
        },
        {
          requestId: "diag-host-validation",
          stage: "host_validation",
          origin: "https://allowed.example",
          host: "blocked.example",
        },
      ] as const;

      for (const entry of cases) {
        const response = await mcpRequest(
          app,
          token.token,
          initializeMessage(31, diagnosticsClient),
          {
            "x-request-id": entry.requestId,
            origin: entry.origin,
            host: entry.host,
          },
        );
        expect(response.status).toBe(403);
        expect(response.headers.get(MCP_FAILURE_STAGE_HEADER)).toBe(entry.stage);
        const payload = await response.json() as {
          error?: { data?: Record<string, unknown> };
        };
        expect(payload.error?.data).toEqual({
          layer: "gateway",
          stage: entry.stage,
          requestId: entry.requestId,
          retryable: false,
          reconciliation: "not_required",
          recommendedAction: "fix_request",
          manifestFingerprint: MCP_CORE_TOOL_MANIFEST_FINGERPRINT,
          manifestToolCount: MCP_CORE_TOOL_NAMES.length,
          method: "initialize",
        });
      }
    } finally {
      store.close();
    }
  });
});
