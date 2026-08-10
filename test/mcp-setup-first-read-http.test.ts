import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleMcpHttpRequest } from "../src/mcp-http.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import { mcpHeaders, toolCall } from "./support/mcp-http.ts";

const oauthPrincipal: TokenPrincipal = {
  tokenId: "oauth_access_test",
  authorizationId: "oauth_grant_test",
  oauthAccountId: "acct_test",
  name: "OAuth user",
  scopes: ["read", "write"],
  projects: null,
};

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(async () => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
  await ledger.createItem({
    project: "scrapbook",
    kind: "task",
    title: "First read target",
    nextAction: "Read it.",
    priority: 50,
    actor: { id: "leo", name: "Leo", kind: "human" },
  });
});

afterEach(() => store.close());

describe("hosted MCP first-read evidence path", () => {
  test("records only a successful OAuth read with one server-resolved project", async () => {
    const recorded: Array<{ accountId: string; project: string }> = [];
    const options = {
      ledger,
      authenticator: authenticator(oauthPrincipal),
      mcpSetupFirstReadRecorder: {
        async recordSetupFirstRead(input: { accountId: string; project: string }) {
          recorded.push({ ...input });
        },
      },
    };

    const read = await call(options, 1, "get_brief", { project: "scrapbook" });
    expect(read.status).toBe(200);
    expect(recorded).toEqual([{ accountId: "acct_test", project: "scrapbook" }]);

    const write = await call(options, 2, "create_item", {
      project: "scrapbook",
      kind: "task",
      title: "A write does not count",
      priority: 50,
    });
    expect(write.status).toBe(200);
    expect(recorded).toHaveLength(1);

    const unscoped = await call(options, 3, "survey_workspace", {});
    expect(unscoped.status).toBe(200);
    expect(recorded).toHaveLength(1);

    const failedRead = await call(options, 4, "get_item", { id: "missing-item" });
    expect(failedRead.status).toBe(200);
    const failedBody = await failedRead.json() as {
      result?: { isError?: boolean };
    };
    expect(failedBody.result?.isError).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  test("does not record an API-token principal even when the read succeeds", async () => {
    const recorded: unknown[] = [];
    const principal: TokenPrincipal = {
      tokenId: "tok_api_reader",
      name: "API reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    };
    const response = await call({
      ledger,
      authenticator: authenticator(principal),
      mcpSetupFirstReadRecorder: {
        async recordSetupFirstRead(input: unknown) {
          recorded.push(input);
        },
      },
    }, 5, "get_brief", { project: "scrapbook" });
    expect(response.status).toBe(200);
    expect(recorded).toEqual([]);
  });

  test("keeps a successful read successful when first-read persistence fails", async () => {
    const response = await call({
      ledger,
      authenticator: authenticator(oauthPrincipal),
      mcpSetupFirstReadRecorder: {
        async recordSetupFirstRead() {
          throw new Error("private evidence backend failure");
        },
      },
    }, 6, "get_brief", { project: "scrapbook" });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      result?: { isError?: boolean };
    };
    expect(body.result?.isError).not.toBe(true);
  });
});

function authenticator(principal: TokenPrincipal): ApiTokenAuthenticator {
  return {
    async authenticate(token: string) {
      return token === "test-token" ? principal : null;
    },
  };
}

async function call(
  options: Parameters<typeof handleMcpHttpRequest>[1],
  id: number,
  tool: string,
  args: Record<string, unknown>,
) {
  return await handleMcpHttpRequest(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: mcpHeaders("test-token"),
      body: JSON.stringify(toolCall(id, tool, args)),
    }),
    options,
  );
}
