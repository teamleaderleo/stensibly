import { describe, expect, test } from "bun:test";
import {
  actorKinds,
  readPrincipal,
  readStoredActor,
  serializeActor,
  validateActor,
} from "../site/session-context.js";

describe("dashboard principal capability context", () => {
  test("normalizes safe fields and discards credential metadata", () => {
    const context = readPrincipal({
      principal: {
        kind: "api_token",
        name: "dashboard-writer",
        workspace: "default",
        scopes: ["read", "write", "read"],
        projects: ["scrapbook", "release", "scrapbook"],
        tokenId: "tok_secret_id",
        rawToken: "stn.tok_secret.value",
        hash: "secret-hash",
      },
      capabilities: { read: true, write: true, admin: false },
      serviceSecret: "never-return-this",
    });

    expect(context).toEqual({
      principal: {
        kind: "api_token",
        name: "dashboard-writer",
        workspace: "default",
        scopes: ["read", "write"],
        projects: ["scrapbook", "release"],
      },
      capabilities: { read: true, write: true, admin: false },
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("tok_secret_id");
    expect(serialized).not.toContain("stn.tok_");
    expect(serialized).not.toContain("hash");
    expect(serialized).not.toContain("serviceSecret");
  });

  test("supports write-only, admin, all-project, and local contexts", () => {
    expect(readPrincipal({
      principal: { kind: "api_token", name: "writer", workspace: null, scopes: ["write"], projects: null },
      capabilities: { read: false, write: true, admin: false },
    })).toEqual({
      principal: { kind: "api_token", name: "writer", workspace: null, scopes: ["write"], projects: null },
      capabilities: { read: false, write: true, admin: false },
    });

    expect(readPrincipal({
      principal: { kind: "api_token", name: "operator", workspace: "prod", scopes: ["admin"], projects: null },
      capabilities: { read: true, write: true, admin: true },
    }).capabilities).toEqual({ read: true, write: true, admin: true });
  });

  test("rejects malformed, unsupported, and credential-shaped responses", () => {
    expect(() => readPrincipal(null)).toThrow("incompatible principal");
    expect(() => readPrincipal({ principal: { kind: "human" }, capabilities: {} })).toThrow("unsupported");
    expect(() => readPrincipal({
      principal: { kind: "api_token", name: "writer", workspace: null, scopes: ["write"], projects: null },
      capabilities: { read: false, write: "yes", admin: false },
    })).toThrow("write capability");
    expect(() => readPrincipal({
      principal: { kind: "api_token", name: "stn.tok_secret.value", workspace: null, scopes: ["write"], projects: null },
      capabilities: { read: false, write: true, admin: false },
    })).toThrow("Credential-shaped");
  });
});

describe("dashboard actor session contract", () => {
  test("uses exactly the server actor kinds", () => {
    expect(actorKinds()).toEqual(["human", "agent", "service"]);
  });

  test("trims and validates actor identity", () => {
    expect(validateActor({ id: " leo ", name: " Leo ", kind: "human" })).toEqual({
      id: "leo",
      name: "Leo",
      kind: "human",
    });
    expect(validateActor({ id: "i".repeat(120), name: "n".repeat(160), kind: "service" }))
      .toEqual({ id: "i".repeat(120), name: "n".repeat(160), kind: "service" });
    expect(() => validateActor({ id: "i".repeat(121), name: "Leo", kind: "human" })).toThrow("maximum 120");
    expect(() => validateActor({ id: "leo", name: "n".repeat(161), kind: "human" })).toThrow("maximum 160");
    expect(() => validateActor({ id: "leo", name: "Leo", kind: "script" })).toThrow("human, agent, or service");
    expect(() => validateActor({ id: "stn.tok_secret.value", name: "Leo", kind: "human" })).toThrow("Credential-shaped");
  });

  test("serializes valid actors and treats invalid stored values as absent", () => {
    const serialized = serializeActor({ id: "agent-1", name: "Release agent", kind: "agent" });
    expect(readStoredActor(serialized)).toEqual({ id: "agent-1", name: "Release agent", kind: "agent" });
    expect(readStoredActor("not json")).toBeNull();
    expect(readStoredActor(JSON.stringify({ id: "bad", name: "Bad", kind: "script" }))).toBeNull();
    expect(readStoredActor("")).toBeNull();
  });
});
