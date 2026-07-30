import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import { mcpRequest, readToolJson, toolCall } from "./support/mcp-http.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  store.createItem({
    project: "smolrunner",
    kind: "task",
    title: "Ready runner work",
    priority: 80,
    actor: leo,
  });
  store.createItem({
    project: "renderprove",
    kind: "task",
    title: "Ready browser work",
    priority: 70,
    actor: leo,
  });
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("remote workspace survey", () => {
  test("allows an all-project read token to survey the workspace", async () => {
    const token = createApiToken(store, {
      name: "Workspace surveyor",
      scopes: ["read"],
    });

    const response = await mcpRequest(
      app,
      token.token,
      toolCall(1, "survey_workspace", {}),
    );
    expect(response.status).toBe(200);
    const survey = await readToolJson<{
      counts: { total: number };
      projects: Array<{ project: string }>;
      fingerprint: string;
    }>(response);
    expect(survey.counts.total).toBe(2);
    expect(survey.projects.map((entry) => entry.project)).toEqual([
      "renderprove",
      "smolrunner",
    ]);
    expect(survey.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("requires project scope when a token has a project allowlist", async () => {
    const token = createApiToken(store, {
      name: "SmolRunner surveyor",
      scopes: ["read"],
      projects: ["smolrunner"],
    });

    const missingProject = await mcpRequest(
      app,
      token.token,
      toolCall(2, "survey_workspace", {}),
    );
    expect(missingProject.status).toBe(400);

    const allowed = await mcpRequest(
      app,
      token.token,
      toolCall(3, "survey_workspace", { project: "smolrunner" }),
    );
    expect(allowed.status).toBe(200);
    const survey = await readToolJson<{
      counts: { total: number };
      projects: Array<{ project: string }>;
    }>(allowed);
    expect(survey.counts.total).toBe(1);
    expect(survey.projects.map((entry) => entry.project)).toEqual(["smolrunner"]);

    const denied = await mcpRequest(
      app,
      token.token,
      toolCall(4, "survey_workspace", { project: "renderprove" }),
    );
    expect(denied.status).toBe(403);
  });
});
