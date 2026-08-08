import { expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexGitHubProjectContextService,
  GitHubProjectContextStorageError,
} from "../src/github-project-context-convex-ledger.ts";

class ThrowingClient implements ConvexCaller {
  constructor(readonly thrown: unknown) {}

  async mutation(
    _reference: FunctionReference<"mutation">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    throw this.thrown;
  }

  async query(
    _reference: FunctionReference<"query">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    throw this.thrown;
  }
}

for (const variant of ["prototype", "message"] as const) {
  test(`project-context Convex service contains hostile backend ${variant} inspection`, async () => {
    let trapCalls = 0;
    const thrown = variant === "prototype"
      ? new Proxy(Object.create(null), {
          getPrototypeOf() {
            trapCalls += 1;
            throw new Error("backend prototype prose must remain opaque");
          },
        })
      : new Proxy(Object.create(null), {
          getPrototypeOf() {
            return Object.prototype;
          },
          getOwnPropertyDescriptor(_target, key) {
            if (key === "message") {
              trapCalls += 1;
              throw new Error("backend message prose must remain opaque");
            }
            return undefined;
          },
        });

    const service = new ConvexGitHubProjectContextService({
      client: new ThrowingClient(thrown),
      serviceSecret: "service-secret",
      workspace: "default",
    });

    let captured: unknown;
    try {
      await service.getGitHubProjectContext({ project: "stensibly" });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(GitHubProjectContextStorageError);
    expect(String(captured)).not.toContain("backend");
    expect(trapCalls).toBe(0);
  });
}
