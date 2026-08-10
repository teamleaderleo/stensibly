import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const protocolVersion = "2025-06-18";

class AdminAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    return rawToken === "admin"
      ? {
        tokenId: "tok_repository_setup_admin",
        name: "repository-setup-admin",
        scopes: ["admin"],
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

describe("remember_project_repository_setup", () => {
  test("records a non-authorizing proposal and get_project_attachment rereads it", async () => {
    const recorded = await call("remember_project_repository_setup", {
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "github_conversation_context",
    });
    expect(recorded).toMatchObject({
      project: "scrapbook",
      replayed: false,
      replacedObservationId: null,
      observation: {
        project: "scrapbook",
        repositoryFullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
        sourceKind: "github_conversation_context",
        authorizesProviderEffect: false,
        containsSecrets: false,
      },
    });
    expect(recorded.observation.id).toMatch(/^repo_setup_/);

    const reread = await call("get_project_attachment", { project: "scrapbook" });
    expect(reread).toMatchObject({
      project: "scrapbook",
      attachment: null,
      repositorySetupObservation: recorded.observation,
    });
  });

  test("exact replay reuses the same observation", async () => {
    const input = {
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "github_conversation_context",
    } as const;
    const first = await call("remember_project_repository_setup", input);
    const second = await call("remember_project_repository_setup", input);
    expect(second).toMatchObject({
      replayed: true,
      replacedObservationId: null,
      observation: { id: first.observation.id },
    });
  });

  test("changed proposal requires the current observation id before replacement", async () => {
    const first = await call("remember_project_repository_setup", {
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "github_conversation_context",
    });
    const denied = await callEnvelope("remember_project_repository_setup", {
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "trunk",
      sourceKind: "github_conversation_context",
    });
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content?.[0]?.text).toContain(first.observation.id);

    const reread = await call("get_project_attachment", { project: "scrapbook" });
    expect(reread.repositorySetupObservation.defaultBranch).toBe("main");

    const replaced = await call("remember_project_repository_setup", {
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "trunk",
      sourceKind: "github_conversation_context",
      replaceObservationId: first.observation.id,
    });
    expect(replaced).toMatchObject({
      replayed: false,
      replacedObservationId: first.observation.id,
      observation: { defaultBranch: "trunk" },
    });
  });
});

async function call(name: string, argumentsValue: Record<string, unknown>): Promise<any> {
  const envelope = await callEnvelope(name, argumentsValue);
  expect(envelope.result?.isError).not.toBe(true);
  const content = envelope.result?.content?.[0]?.text;
  if (typeof content !== "string") throw new Error("MCP response omitted text content");
  return JSON.parse(content);
}

async function callEnvelope(name: string, argumentsValue: Record<string, unknown>): Promise<any> {
  const app = createServerApp(store, {
    authenticator: new AdminAuthenticator(),
  });
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer admin",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: argumentsValue,
      },
    }),
  });
  expect(response.status).toBe(200);
  return decodeEnvelope(await response.text());
}

function decodeEnvelope(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error("MCP response omitted JSON or event data");
  return JSON.parse(dataLine.slice("data: ".length));
}
