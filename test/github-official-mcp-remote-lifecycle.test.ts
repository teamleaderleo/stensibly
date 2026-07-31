import { describe, expect, test } from "bun:test";
import {
  mapGitHubDelegatedReadToOfficialMcp,
  type GitHubOfficialMcpMappedRead,
} from "../src/github-official-mcp-read-mapping.ts";
import {
  GitHubOfficialMcpRemoteError,
  GitHubOfficialMcpRemoteTransport,
  type GitHubOfficialMcpRemoteSession,
  type GitHubOfficialMcpRemoteSessionFactory,
  type GitHubOfficialMcpRemoteSessionFactoryInput,
} from "../src/github-official-mcp-remote-transport.ts";

const credentialRef = "secret://github/official-mcp";
const bearer = "test-bearer";
const repositoryFullName = "teamleaderleo/stensibly";

describe("official GitHub MCP mapping snapshot and lifecycle deadlines", () => {
  test("dispatches one frozen mapping generation across credential resolution", async () => {
    const mutableMapping = structuredClone(
      pullRequestMapping(),
    ) as unknown as GitHubOfficialMcpMappedRead;
    const resolverInputs: unknown[] = [];
    const factoryInputs: GitHubOfficialMcpRemoteSessionFactoryInput[] = [];
    const calls: Array<{
      name: string;
      arguments: Readonly<Record<string, unknown>>;
      timeoutMs: number;
    }> = [];
    const factory: GitHubOfficialMcpRemoteSessionFactory = {
      create(input) {
        factoryInputs.push(input);
        return successfulSession(calls);
      },
    };
    const transport = new GitHubOfficialMcpRemoteTransport({
      credentials: {
        async resolveGitHubOfficialMcpBearer(input) {
          resolverInputs.push(input);
          const mutable = mutableMapping as unknown as Record<string, unknown>;
          mutable.repositoryFullName = "attacker/changed";
          mutable.officialTool = "actions_get";
          const argumentsValue = mutable.officialArguments as Record<string, unknown>;
          argumentsValue.method = "get_workflow_job";
          argumentsValue.owner = "attacker";
          argumentsValue.repo = "changed";
          argumentsValue.resource_id = "999";
          delete argumentsValue.pullNumber;
          return bearer;
        },
      },
      sessionFactory: factory,
      timeoutMs: 1_000,
    });

    const result = await transport.callMappedRead({
      mapping: mutableMapping,
      credentialRef,
    });

    expect(resolverInputs).toEqual([{
      credentialRef,
      repositoryFullName,
      officialTool: "pull_request_read",
    }]);
    expect(factoryInputs).toHaveLength(1);
    expect(factoryInputs[0]!.headers["X-MCP-Tools"]).toBe("pull_request_read");
    expect(calls).toEqual([{
      name: "pull_request_read",
      arguments: {
        method: "get",
        owner: "teamleaderleo",
        pullNumber: 768,
        repo: "stensibly",
      },
      timeoutMs: 1_000,
    }]);
    expect(Object.isFrozen(calls[0]!.arguments)).toBe(true);
    expect((result.result as Record<string, unknown>).number).toBe(768);
  });

  test("bounds resolver, connect, call, and close with original-failure precedence", async () => {
    let credentialSessionCreations = 0;
    const credentialTransport = new GitHubOfficialMcpRemoteTransport({
      credentials: {
        resolveGitHubOfficialMcpBearer: () => pending<string>(),
      },
      sessionFactory: {
        create() {
          credentialSessionCreations += 1;
          return successfulSession([]);
        },
      },
      timeoutMs: 1_000,
    });

    let connectCloses = 0;
    const connectTransport = transportFor({
      connect: () => pending<void>(),
      async callTool() {
        throw new Error("unreachable");
      },
      async close() {
        connectCloses += 1;
      },
    });

    let callCloses = 0;
    const callTransport = transportFor({
      async connect() {},
      callTool: () => pending<unknown>(),
      async close() {
        callCloses += 1;
      },
    });

    const closeTransport = transportFor({
      async connect() {},
      async callTool() {
        return successEnvelope();
      },
      close: () => pending<void>(),
    });

    const precedenceTransport = transportFor({
      async connect() {},
      async callTool() {
        throw new Error("provider-private-call-cause");
      },
      close: () => pending<void>(),
    });

    const [credentialError, connectError, callError, closeError, precedenceError] =
      await Promise.all([
        capturedError(() => call(credentialTransport)),
        capturedError(() => call(connectTransport)),
        capturedError(() => call(callTransport)),
        capturedError(() => call(closeTransport)),
        capturedError(() => call(precedenceTransport)),
      ]);

    expect(credentialError.code).toBe(
      "github_official_mcp_credential_unavailable",
    );
    expect(credentialError.message).toBe(
      "Official GitHub MCP credential is unavailable",
    );
    expect(credentialSessionCreations).toBe(0);

    expect(connectError.code).toBe("github_official_mcp_transport_failed");
    expect(connectError.message).toBe(
      "Official GitHub MCP read failed before a verified result was available",
    );
    expect(connectCloses).toBe(1);

    expect(callError.code).toBe("github_official_mcp_transport_failed");
    expect(callCloses).toBe(1);

    expect(closeError.code).toBe("github_official_mcp_close_failed");
    expect(closeError.message).toBe(
      "Official GitHub MCP session could not be closed",
    );

    expect(precedenceError.code).toBe("github_official_mcp_transport_failed");
    expect(precedenceError.message).toBe(
      "Official GitHub MCP read failed before a verified result was available",
    );
    expect(precedenceError.message).not.toContain("provider-private-call-cause");
  });
});

function transportFor(
  session: GitHubOfficialMcpRemoteSession,
): GitHubOfficialMcpRemoteTransport {
  return new GitHubOfficialMcpRemoteTransport({
    credentials: {
      async resolveGitHubOfficialMcpBearer() {
        return bearer;
      },
    },
    sessionFactory: {
      create() {
        return session;
      },
    },
    timeoutMs: 1_000,
  });
}

function successfulSession(
  calls: Array<{
    name: string;
    arguments: Readonly<Record<string, unknown>>;
    timeoutMs: number;
  }>,
): GitHubOfficialMcpRemoteSession {
  return {
    async connect() {},
    async callTool(input) {
      calls.push(input);
      return successEnvelope();
    },
    async close() {},
  };
}

function successEnvelope() {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        number: 768,
        repository: repositoryFullName,
      }),
    }],
  };
}

function pullRequestMapping(): GitHubOfficialMcpMappedRead {
  const mapping = mapGitHubDelegatedReadToOfficialMcp({
    tool: "get_pr_info",
    arguments: { pr_number: 768 },
    repositoryFullName,
  });
  if (mapping.state !== "mapped") {
    throw new Error("Expected mapped pull request read");
  }
  return mapping;
}

function call(transport: GitHubOfficialMcpRemoteTransport) {
  return transport.callMappedRead({
    mapping: pullRequestMapping(),
    credentialRef,
  });
}

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

async function capturedError(
  run: () => Promise<unknown>,
): Promise<GitHubOfficialMcpRemoteError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubOfficialMcpRemoteError);
    return error as GitHubOfficialMcpRemoteError;
  }
  throw new Error("Expected official GitHub MCP transport to reject");
}
