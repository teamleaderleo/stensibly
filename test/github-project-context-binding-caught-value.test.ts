import { expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexGitHubProjectContextBindingReader,
} from "../src/github-project-context-binding-convex-reader.ts";
import {
  GitHubProjectContextStorageError,
} from "../src/github-project-context-convex-ledger.ts";

class ThrowingClient implements ConvexCaller {
  constructor(readonly thrown: unknown) {}

  async query(
    _reference: FunctionReference<"query">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    throw this.thrown;
  }

  async mutation(
    _reference: FunctionReference<"mutation">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    throw new Error("mutation is outside this reader control");
  }
}

test("project-context binding reader keeps arbitrary backend failures opaque", async () => {
  let prototypeReads = 0;
  const backendFailure = new Proxy(Object.create(null), {
    getPrototypeOf() {
      prototypeReads += 1;
      throw new Error("backend failure prototype must remain opaque");
    },
  });
  const reader = new ConvexGitHubProjectContextBindingReader({
    client: new ThrowingClient(backendFailure),
    serviceSecret: "service-secret",
    workspace: "default",
  });

  let captured: unknown;
  try {
    await reader.getCurrentGitHubIssueContextBinding({
      project: "stensibly",
      externalId: "github:issue:teamleaderleo/stensibly#492",
    });
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(GitHubProjectContextStorageError);
  expect(prototypeReads).toBe(0);
  expect(String(captured)).not.toContain("backend failure prototype");
});
