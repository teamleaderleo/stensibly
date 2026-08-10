import { expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexGitHubProjectContextService,
  GitHubProjectContextConflictError,
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

function service(thrown: unknown): ConvexGitHubProjectContextService {
  return new ConvexGitHubProjectContextService({
    client: new ThrowingClient(thrown),
    serviceSecret: "service-secret",
    workspace: "default",
  });
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

    let captured: unknown;
    try {
      await service(thrown).getGitHubProjectContext({ project: "stensibly" });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(GitHubProjectContextStorageError);
    expect(String(captured)).not.toContain("backend");
    expect(trapCalls).toBe(0);
  });
}

for (const marker of [
  "GITHUB_PROJECT_CONTEXT_OBSERVATION_CONFLICT",
  "GITHUB_PROJECT_CONTEXT_SOURCE_REVISION_CONFLICT",
] as const) {
  test(`project-context Convex service preserves ${marker} classification from an ordinary Error`, async () => {
    const backend = new Error(`${marker} private backend detail`);
    let captured: unknown;
    try {
      await service(backend).getGitHubProjectContext({ project: "stensibly" });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(GitHubProjectContextConflictError);
    expect(captured).not.toBe(backend);
    expect(String(captured)).not.toContain("private backend detail");
  });
}
