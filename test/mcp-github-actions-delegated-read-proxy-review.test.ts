import { expect, test } from "bun:test";
import {
  hostedGitHubDelegatedReadTools,
  type HostedGitHubDelegatedReadProvider,
} from "../src/hosted-github-delegated-read-provider.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const hidden = Symbol("escaped-mounted-tool");

test("rejects a mounted tool declaration that changes between descriptor reads", () => {
  const target = [...hostedGitHubDelegatedReadTools] as unknown[];
  Object.defineProperty(target, hidden, {
    configurable: true,
    enumerable: true,
    value: "fetch_workflow_job_logs",
  });
  let ownKeyReads = 0;
  const hostile = new Proxy(target, {
    ownKeys(current) {
      ownKeyReads += 1;
      const keys = Reflect.ownKeys(current);
      return ownKeyReads === 1
        ? keys.filter((key) => key !== hidden)
        : keys;
    },
  });
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const provider: HostedGitHubDelegatedReadProvider = {
    delegatedGitHubReadTools:
      hostile as unknown as typeof hostedGitHubDelegatedReadTools,
    async callGitHubDelegatedRead() {
      throw new Error("must not dispatch");
    },
  };

  try {
    expect(() => createMcpServer(
      Object.assign(ledger, provider),
      {
        principal: {
          tokenId: "delegated-actions-proxy-review",
          name: "delegated actions proxy review",
          scopes: ["read"],
          projects: ["scrapbook"],
        },
      },
    )).toThrow("tool declaration is invalid");
  } finally {
    store.close();
  }
});
