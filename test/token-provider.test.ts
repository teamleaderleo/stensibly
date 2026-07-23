import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexTokenProvider,
  hashSecret,
  parseToken,
} from "../src/token-provider.ts";

class RecordingCaller implements ConvexCaller {
  calls: Array<{
    type: "query" | "mutation";
    name: string;
    args: Record<string, unknown>;
  }> = [];

  async query(reference: FunctionReference<"query">, args: Record<string, unknown>) {
    this.calls.push({ type: "query", name: getFunctionName(reference), args });
    return {
      tokenId: args.id,
      name: "Token",
      scopes: ["read"],
      projects: ["scrapbook"],
    };
  }

  async mutation(reference: FunctionReference<"mutation">, args: Record<string, unknown>) {
    this.calls.push({ type: "mutation", name: getFunctionName(reference), args });
    return {
      id: args.id,
      name: args.name ?? "Token",
      scopes: args.scopes ?? ["read"],
      projects: args.projects ?? null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
  }
}

describe("Convex token provider", () => {
  test("hashes secrets locally before authentication", async () => {
    const client = new RecordingCaller();
    const provider = new ConvexTokenProvider({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });
    const secret = "a".repeat(43);
    const raw = `stn.tok_1234567890abcdef1234567890abcdef.${secret}`;
    const principal = await provider.authenticate(raw);
    expect(principal?.projects).toEqual(["scrapbook"]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      type: "query",
      name: "tokens:authenticate",
      args: {
        serviceSecret: "private-service-secret",
        workspace: "shared-work",
        id: "tok_1234567890abcdef1234567890abcdef",
        secretHash: hashSecret(secret),
      },
    });
    expect(JSON.stringify(client.calls[0])).not.toContain(secret);
    expect(JSON.stringify(client.calls[0])).not.toContain(raw);
  });

  test("creates a one-time raw token while registering only its hash", async () => {
    const client = new RecordingCaller();
    const provider = new ConvexTokenProvider({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });
    const created = await provider.create({
      name: "Agent",
      scopes: ["write", "read", "read"],
      projects: ["scrapbook"],
    });
    const parsed = parseToken(created.token);
    expect(parsed).not.toBeNull();
    const registration = client.calls[0];
    expect(registration).toMatchObject({
      type: "mutation",
      name: "tokens:register",
      args: {
        serviceSecret: "private-service-secret",
        workspace: "shared-work",
        id: created.id,
        name: "Agent",
        scopes: ["read", "write"],
        projects: ["scrapbook"],
        secretHash: parsed ? hashSecret(parsed.secret) : "",
      },
    });
    expect(JSON.stringify(registration)).not.toContain(created.token);
    expect(JSON.stringify(registration)).not.toContain(parsed?.secret ?? "impossible");
  });

  test("rejects malformed tokens without calling Convex", async () => {
    const client = new RecordingCaller();
    const provider = new ConvexTokenProvider({
      client,
      serviceSecret: "secret",
    });
    expect(await provider.authenticate("garbage")).toBeNull();
    expect(client.calls).toEqual([]);
  });
});
