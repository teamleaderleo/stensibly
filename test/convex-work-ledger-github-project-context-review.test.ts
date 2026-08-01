import { expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import {
  ConvexWorkLedger,
  type ConvexCaller,
} from "../src/convex-ledger.ts";
import { githubProjectContextLedger } from "../src/github-project-context.ts";

test("ConvexWorkLedger exposes the hosted GitHub project-context ledger", async () => {
  const queries: Array<Record<string, unknown>> = [];
  const client: ConvexCaller = {
    async query(
      _reference: FunctionReference<"query">,
      args: Record<string, unknown>,
    ) {
      queries.push(args);
      return [];
    },
    async mutation() {
      throw new Error("unexpected mutation");
    },
  };
  const ledger = new ConvexWorkLedger({
    client,
    serviceSecret: "hosted-context-composition-secret",
    workspace: "hosted-review",
  });
  const contextLedger = githubProjectContextLedger(ledger);

  expect(contextLedger).toBe(ledger);
  expect(typeof ledger.acceptGitHubIssueContext).toBe("function");

  const projection = await contextLedger!.getGitHubProjectContext({
    project: "scrapbook",
    limit: 5,
  });

  expect(projection).toMatchObject({
    version: 1,
    workspace: "hosted-review",
    project: "scrapbook",
    mode: "project",
    requestedExternalId: null,
    issues: [],
    history: [],
  });
  expect(queries).toEqual([{
    serviceSecret: "hosted-context-composition-secret",
    workspace: "hosted-review",
    project: "scrapbook",
    limit: 5,
  }]);
});
