import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import { bearerJsonHeaders, jsonHeaders } from "./support/http.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const agent = { id: "agent", name: "Agent", kind: "agent" as const };

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("continuation REST API", () => {
  test("proposes, reads, lists, approves, and consumes a continuation", async () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Finish one unit and suggest another",
      priority: 70,
      actor: agent,
    });

    const proposalInput = {
      title: "Review the completed change",
      rationale: "A human review should decide whether the follow-up is worth doing.",
      instruction: "Inspect the diff and approve a follow-up task when needed.",
      action: { kind: "request_decision", decisionType: "review_change" },
      evidence: [{ kind: "commit", label: "Implementation", uri: "git:repo@abc123" }],
      actor: agent,
      approvalMode: "human",
      deliveryMode: "current_conversation",
    };
    const proposed = await json<{
      continuation: { id: string; status: string; generation: number };
    }>(
      app.request(`/api/v1/items/${item.id}/continuations`, {
        method: "POST",
        headers: jsonHeaders({
          "idempotency-key": "continuation-propose-1",
        }),
        body: JSON.stringify(proposalInput),
      }),
      201,
    );
    expect(proposed.continuation).toMatchObject({
      status: "proposed",
      generation: 1,
    });

    const replayed = await json<{ continuation: { id: string } }>(
      app.request(`/api/v1/items/${item.id}/continuations`, {
        method: "POST",
        headers: jsonHeaders({
          "idempotency-key": "continuation-propose-1",
        }),
        body: JSON.stringify(proposalInput),
      }),
      201,
    );
    expect(replayed.continuation.id).toBe(proposed.continuation.id);

    const listed = await json<{ continuations: Array<{ id: string }> }>(
      app.request(`/api/v1/items/${item.id}/continuations?status=proposed`),
    );
    expect(listed.continuations.map((entry) => entry.id)).toEqual([
      proposed.continuation.id,
    ]);

    const read = await json<{
      continuation: { sourceItemId: string; status: string };
    }>(app.request(`/api/v1/continuations/${proposed.continuation.id}`));
    expect(read.continuation).toMatchObject({
      sourceItemId: item.id,
      status: "proposed",
    });

    const approved = await json<{
      continuation: { status: string; generation: number };
    }>(
      app.request(
        `/api/v1/continuations/${proposed.continuation.id}/resolve`,
        {
          method: "POST",
          headers: jsonHeaders({
            "idempotency-key": "continuation-approve-1",
          }),
          body: JSON.stringify({
            actor: leo,
            command: "approve",
            expectedGeneration: 1,
            note: "Continue in the current conversation.",
          }),
        },
      ),
    );
    expect(approved.continuation).toMatchObject({
      status: "approved",
      generation: 2,
    });

    const replayedApproval = await json<{
      continuation: { status: string; generation: number };
    }>(
      app.request(
        `/api/v1/continuations/${proposed.continuation.id}/resolve`,
        {
          method: "POST",
          headers: jsonHeaders({
            "idempotency-key": "continuation-approve-1",
          }),
          body: JSON.stringify({
            actor: leo,
            command: "approve",
            expectedGeneration: 1,
            note: "Continue in the current conversation.",
          }),
        },
      ),
    );
    expect(replayedApproval.continuation).toEqual(approved.continuation);

    const stale = await app.request(
      `/api/v1/continuations/${proposed.continuation.id}/resolve`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          actor: leo,
          command: "reject",
          expectedGeneration: 1,
        }),
      },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "conflict" });

    const consumed = await json<{
      continuation: {
        status: string;
        generation: number;
        result: { decisionId: string; conversationRef: string };
        consumedAt: string;
      };
    }>(
      app.request(
        `/api/v1/continuations/${proposed.continuation.id}/resolve`,
        {
          method: "POST",
          headers: jsonHeaders({
            "idempotency-key": "continuation-consume-1",
          }),
          body: JSON.stringify({
            actor: agent,
            command: "consume",
            expectedGeneration: 2,
            result: {
              decisionId: "decision_review_change",
              conversationRef: "chatgpt:conversation:review",
            },
          }),
        },
      ),
    );
    expect(consumed.continuation).toMatchObject({
      status: "consumed",
      generation: 3,
      result: {
        decisionId: "decision_review_change",
        conversationRef: "chatgpt:conversation:review",
      },
    });
    expect(consumed.continuation.consumedAt).toBeString();

    const finalRead = await json<{
      continuation: { status: string; result: { decisionId: string } };
    }>(app.request(`/api/v1/continuations/${proposed.continuation.id}`));
    expect(finalRead.continuation).toMatchObject({
      status: "consumed",
      result: { decisionId: "decision_review_change" },
    });
  });

  test("enforces source-item project scopes", async () => {
    const visible = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Visible continuation",
      priority: 50,
      actor: agent,
    });
    const hidden = store.createItem({
      project: "secret",
      kind: "task",
      title: "Hidden continuation",
      priority: 50,
      actor: agent,
    });
    const token = createApiToken(store, {
      name: "Scoped writer",
      scopes: ["read", "write"],
      projects: ["scrapbook"],
    });
    app = createServerApp(store, { httpAuth: { required: true } });

    const body = JSON.stringify({
      title: "Continue",
      rationale: "There is another useful action.",
      instruction: "Create the next tracked item.",
      action: { kind: "create_item", project: "scrapbook" },
      actor: agent,
    });
    const allowed = await app.request(
      `/api/v1/items/${visible.id}/continuations`,
      {
        method: "POST",
        headers: bearerJsonHeaders(token.token),
        body,
      },
    );
    expect(allowed.status).toBe(201);

    const denied = await app.request(
      `/api/v1/items/${hidden.id}/continuations`,
      {
        method: "POST",
        headers: bearerJsonHeaders(token.token),
        body,
      },
    );
    expect(denied.status).toBe(403);
  });
});

async function json<T>(
  responseValue: Response | Promise<Response>,
  expectedStatus = 200,
): Promise<T> {
  const response = await responseValue;
  const body = await response.json() as T;
  expect(response.status).toBe(expectedStatus);
  return body;
}
