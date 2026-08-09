import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const protocolVersion = "2025-06-18";

class ReaderAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    return rawToken === "reader"
      ? {
        tokenId: "tok_reader_internal",
        name: "scrapbook-reader",
        scopes: ["read"],
        projects: ["scrapbook"],
      }
      : null;
  }
}

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => store.close());

describe("project attachment setup recovery through MCP", () => {
  test("returns a context request instead of a dead attachment:null response", async () => {
    const payload = await call({ project: "scrapbook" });
    expect(payload).toMatchObject({
      project: "scrapbook",
      attachment: null,
      recovery: {
        version: 1,
        state: "repository_context_required",
        nextAction: "provide_repository_context",
        authorizesProviderEffect: false,
      },
    });
  });

  test("carries observed GitHub repository facts into an advisory setup plan", async () => {
    const payload = await call({
      project: "scrapbook",
      repositorySetup: {
        repositoryFullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
        runnerProfiles: ["codex-default"],
        workProfile: "draft_pr",
        checks: ["bun run typecheck", "bun test"],
      },
    });
    expect(payload).toMatchObject({
      project: "scrapbook",
      attachment: null,
      recovery: {
        state: "attachment_required",
        repository: {
          fullName: "teamleaderleo/scrapbook",
          defaultBranch: "main",
        },
        requested: {
          workProfile: "draft_pr",
          checks: ["bun run typecheck", "bun test"],
        },
        nextAction: {
          kind: "review_and_accept_project_attachment",
          requiresAdmin: true,
          acceptAuthorityWidening: true,
        },
        verification: {
          repositoryMetadata: "get_repo",
          immutableFileRead: "fetch_file",
          immutableReadRef: "exact_commit_sha",
        },
        authorizesProviderEffect: false,
        containsSecrets: false,
      },
    });
  });
});

async function call(argumentsValue: Record<string, unknown>): Promise<any> {
  const app = createServerApp(store, {
    authenticator: new ReaderAuthenticator(),
  });
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer reader",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_project_attachment",
        arguments: argumentsValue,
      },
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error("MCP response omitted event data");
  const envelope = JSON.parse(dataLine.slice("data: ".length));
  const content = envelope.result?.content?.[0]?.text;
  if (typeof content !== "string") throw new Error("MCP response omitted text content");
  return JSON.parse(content);
}
