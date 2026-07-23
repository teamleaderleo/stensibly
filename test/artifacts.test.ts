import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachArtifact, listArtifacts } from "../src/artifacts.ts";
import { ConflictError, NotFoundError, StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const browserAgent = {
  id: "browser-agent",
  name: "Browser Agent",
  kind: "agent" as const,
};

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("artifact references", () => {
  test("attaches pointers with provenance and records history", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Leave the useful output behind",
      priority: 50,
      actor: leo,
    });

    const artifact = attachArtifact(store, {
      itemId: item.id,
      actor: browserAgent,
      kind: "commit",
      label: "Parser fix",
      uri: "git:teamleaderleo/stensibly@abc123",
      metadata: { repository: "teamleaderleo/stensibly", sha: "abc123" },
      idempotencyKey: "artifact-1",
    });

    expect(artifact).toMatchObject({
      itemId: item.id,
      actorId: browserAgent.id,
      kind: "commit",
      label: "Parser fix",
      uri: "git:teamleaderleo/stensibly@abc123",
      mimeType: null,
      metadata: { repository: "teamleaderleo/stensibly", sha: "abc123" },
    });
    expect(listArtifacts(store, item.id)).toEqual([artifact]);
    expect(store.listEvents(item.id).at(-1)).toMatchObject({
      actorId: browserAgent.id,
      type: "artifact.attached",
      payload: {
        artifactId: artifact.id,
        kind: "commit",
        label: "Parser fix",
        uri: "git:teamleaderleo/stensibly@abc123",
      },
    });
  });

  test("retries return the original artifact", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Retry the attachment safely",
      priority: 50,
      actor: leo,
    });
    const input = {
      itemId: item.id,
      actor: browserAgent,
      kind: "log" as const,
      label: "Test output",
      uri: "file:///tmp/test-output.txt",
      mimeType: "text/plain",
      idempotencyKey: "artifact-retry-1",
    };

    const first = attachArtifact(store, input);
    const second = attachArtifact(store, input);
    expect(second.id).toBe(first.id);
    expect(listArtifacts(store, item.id)).toHaveLength(1);
    expect(store.listEvents(item.id).filter((event) => event.type === "artifact.attached")).toHaveLength(1);
  });

  test("rejects an idempotency key already used by another write", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Keep retry identities honest",
      priority: 50,
      actor: leo,
    }, "shared-key");

    expect(() => attachArtifact(store, {
      itemId: item.id,
      actor: browserAgent,
      kind: "file",
      label: "Some file",
      uri: "file:///tmp/some-file.txt",
      idempotencyKey: "shared-key",
    })).toThrow(ConflictError);
  });

  test("requires a real work item", () => {
    expect(() => attachArtifact(store, {
      itemId: "item_missing",
      actor: browserAgent,
      kind: "url",
      label: "Nowhere to attach",
      uri: "https://example.com",
    })).toThrow(NotFoundError);
  });
});
