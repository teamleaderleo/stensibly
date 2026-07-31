import { describe, expect, test } from "bun:test";
import {
  mapGitHubDelegatedReadToOfficialMcp,
  type GitHubOfficialMcpMappedRead,
} from "../src/github-official-mcp-read-mapping.ts";
import {
  GitHubOfficialMcpRemoteError,
  GitHubOfficialMcpRemoteTransport,
  githubOfficialMcpRemoteEndpoint,
  githubOfficialMcpRemoteMaximumTextBytes,
  type GitHubOfficialMcpRemoteSession,
  type GitHubOfficialMcpRemoteSessionFactory,
  type GitHubOfficialMcpRemoteSessionFactoryInput,
} from "../src/github-official-mcp-remote-transport.ts";

const credentialRef = "secret://github/official-mcp";
const bearer = "github_pat_remote_boundary_secret_1234567890";

describe("official GitHub MCP remote transport", () => {
  test("calls one exact mapped tool with server-owned read-only headers and closes", async () => {
    const mapping = pullRequestMapping();
    const harness = createHarness(successEnvelope({
      number: 768,
      repository: "teamleaderleo/stensibly",
    }));
    const credentialCalls: unknown[] = [];
    const transport = new GitHubOfficialMcpRemoteTransport({
      credentials: {
        async resolveGitHubOfficialMcpBearer(input) {
          credentialCalls.push(input);
          return bearer;
        },
      },
      sessionFactory: harness.factory,
      timeoutMs: 12_345,
    });

    const called = await transport.callMappedRead({ mapping, credentialRef });

    expect(credentialCalls).toEqual([{
      credentialRef,
      repositoryFullName: "teamleaderleo/stensibly",
      officialTool: "pull_request_read",
    }]);
    expect(harness.factoryInputs).toHaveLength(1);
    const created = harness.factoryInputs[0]!;
    expect(created.endpoint.href).toBe(githubOfficialMcpRemoteEndpoint);
    expect(created.headers).toEqual({
      Authorization: `Bearer ${bearer}`,
      "User-Agent": "stensibly-github-official-mcp/1",
      "X-MCP-Readonly": "true",
      "X-MCP-Tools": "pull_request_read",
    });
    expect("X-MCP-Toolsets" in created.headers).toBe(false);
    expect(harness.connected).toBe(1);
    expect(harness.closed).toBe(1);
    expect(harness.calls).toEqual([{
      name: "pull_request_read",
      arguments: {
        method: "get",
        owner: "teamleaderleo",
        pullNumber: 768,
        repo: "stensibly",
      },
      timeoutMs: 12_345,
    }]);
    expect((called.result as Record<string, unknown>).number).toBe(768);
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
    expect(JSON.stringify(called)).not.toContain(bearer);
    expect(JSON.stringify(called)).not.toContain(credentialRef);
  });

  test("rejects stale mapping before credential or session activity", async () => {
    const mapping = {
      ...pullRequestMapping(),
      officialTool: "actions_get",
    } as unknown as GitHubOfficialMcpMappedRead;
    let credentialCalls = 0;
    const harness = createHarness(successEnvelope({ ok: true }));
    const transport = new GitHubOfficialMcpRemoteTransport({
      credentials: {
        async resolveGitHubOfficialMcpBearer() {
          credentialCalls += 1;
          return bearer;
        },
      },
      sessionFactory: harness.factory,
    });

    const error = await capturedError(() =>
      transport.callMappedRead({ mapping, credentialRef })
    );

    expect(error.code).toBe("github_official_mcp_mapping_rejected");
    expect(error.message).toBe(
      "Official GitHub MCP read mapping is stale or unsupported",
    );
    expect(credentialCalls).toBe(0);
    expect(harness.factoryInputs).toHaveLength(0);
  });

  test("redacts credential resolver and transport failures and always closes", async () => {
    const mapping = pullRequestMapping();
    const resolverSecret = "github_pat_resolver_echo_1234567890";
    const transportSecret = "Bearer github_pat_transport_echo_1234567890";
    const resolverHarness = createHarness(successEnvelope({ ok: true }));
    const resolverTransport = new GitHubOfficialMcpRemoteTransport({
      credentials: {
        async resolveGitHubOfficialMcpBearer() {
          throw new Error(`resolver leaked ${resolverSecret}`);
        },
      },
      sessionFactory: resolverHarness.factory,
    });

    const resolverError = await capturedError(() =>
      resolverTransport.callMappedRead({ mapping, credentialRef })
    );
    expect(resolverError.code).toBe(
      "github_official_mcp_credential_unavailable",
    );
    expect(resolverError.message).toBe(
      "Official GitHub MCP credential is unavailable",
    );
    expect(resolverError.message).not.toContain(resolverSecret);
    expect(resolverHarness.factoryInputs).toHaveLength(0);

    const callHarness = createHarness(successEnvelope({ ok: true }), {
      callError: new Error(`upstream leaked ${transportSecret}`),
      closeError: new Error(`close leaked ${transportSecret}`),
    });
    const callTransport = transportWith(callHarness.factory);
    const callError = await capturedError(() =>
      callTransport.callMappedRead({ mapping, credentialRef })
    );
    expect(callError.code).toBe("github_official_mcp_transport_failed");
    expect(callError.message).toBe(
      "Official GitHub MCP read failed before a verified result was available",
    );
    expect(callError.message).not.toContain(transportSecret);
    expect(callHarness.closed).toBe(1);
  });

  test("rejects redirects and endpoint escapes through the injected fetch", async () => {
    let cancellations = 0;
    const redirectResponse = {
      status: 302,
      redirected: false,
      url: githubOfficialMcpRemoteEndpoint,
      body: {
        async cancel() {
          cancellations += 1;
        },
      },
    } as unknown as Response;
    const calls: string[] = [];
    const factory: GitHubOfficialMcpRemoteSessionFactory = {
      create(input) {
        return {
          async connect() {
            calls.push("connect");
            await input.fetch(input.endpoint);
          },
          async callTool() {
            throw new Error("unreachable");
          },
          async close() {
            calls.push("close");
          },
        };
      },
    };
    const transport = new GitHubOfficialMcpRemoteTransport({
      credentials: resolver(),
      sessionFactory: factory,
      fetch: (async () => redirectResponse) as typeof fetch,
    });

    const error = await capturedError(() =>
      transport.callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef,
      })
    );
    expect(error.code).toBe("github_official_mcp_transport_failed");
    expect(calls).toEqual(["connect", "close"]);
    expect(cancellations).toBe(1);

    const escapingFactory: GitHubOfficialMcpRemoteSessionFactory = {
      create(input) {
        return {
          async connect() {
            await input.fetch("https://elsewhere.example/mcp/");
          },
          async callTool() {
            throw new Error("unreachable");
          },
          async close() {},
        };
      },
    };
    const escaping = new GitHubOfficialMcpRemoteTransport({
      credentials: resolver(),
      sessionFactory: escapingFactory,
      fetch: (async () => new Response("unreachable")) as typeof fetch,
    });
    const escapeError = await capturedError(() =>
      escaping.callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef,
      })
    );
    expect(escapeError.code).toBe("github_official_mcp_transport_failed");
  });

  test("admits only one bounded JSON text result", async () => {
    const invalidEnvelopes: unknown[] = [
      { content: [] },
      { content: [{ type: "resource", resource: {} }] },
      {
        content: [
          { type: "text", text: "{}" },
          { type: "text", text: "{}" },
        ],
      },
      { content: [{ type: "text", text: "{" }] },
      {
        content: [{
          type: "text",
          text: "x".repeat(githubOfficialMcpRemoteMaximumTextBytes + 1),
        }],
      },
      {
        content: [{ type: "text", text: "{}" }],
        structuredContent: {},
      },
      {
        content: [{ type: "text", text: JSON.stringify(deepValue(33)) }],
      },
    ];

    for (const envelope of invalidEnvelopes) {
      const harness = createHarness(envelope);
      const error = await capturedError(() =>
        transportWith(harness.factory).callMappedRead({
          mapping: pullRequestMapping(),
          credentialRef,
        })
      );
      expect(error.code).toBe("github_official_mcp_invalid_result");
      expect(error.message).toBe(
        "Official GitHub MCP returned an invalid or oversized result",
      );
      expect(harness.closed).toBe(1);
    }
  });

  test("rejects accessor-bearing envelopes without invoking getters", async () => {
    let getterCalls = 0;
    const envelope = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(envelope, "content", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [{ type: "text", text: "{}" }];
      },
    });
    const harness = createHarness(envelope);

    const error = await capturedError(() =>
      transportWith(harness.factory).callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef,
      })
    );

    expect(error.code).toBe("github_official_mcp_invalid_result");
    expect(getterCalls).toBe(0);
    expect(harness.closed).toBe(1);
  });

  test("maps upstream tool errors without retaining provider prose", async () => {
    const secret = "github_pat_upstream_error_echo_1234567890";
    const harness = createHarness({
      isError: true,
      content: [{ type: "text", text: `provider leaked ${secret}` }],
    });

    const error = await capturedError(() =>
      transportWith(harness.factory).callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef,
      })
    );

    expect(error.code).toBe("github_official_mcp_transport_failed");
    expect(error.message).toBe(
      "Official GitHub MCP reported a tool execution error",
    );
    expect(error.message).not.toContain(secret);
    expect(harness.closed).toBe(1);
  });

  test("treats a close failure after success as an explicit fixed failure", async () => {
    const secret = "github_pat_close_echo_1234567890";
    const harness = createHarness(successEnvelope({ ok: true }), {
      closeError: new Error(`close leaked ${secret}`),
    });

    const error = await capturedError(() =>
      transportWith(harness.factory).callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef,
      })
    );

    expect(error.code).toBe("github_official_mcp_close_failed");
    expect(error.message).toBe(
      "Official GitHub MCP session could not be closed",
    );
    expect(error.message).not.toContain(secret);
    expect(harness.closed).toBe(1);
  });

  test("requires one canonical HTTPS MCP endpoint", () => {
    for (const endpoint of [
      "http://api.githubcopilot.com/mcp/",
      "https://user@api.githubcopilot.com/mcp/",
      "https://api.githubcopilot.com/mcp/?tool=repos",
      "https://api.githubcopilot.com/mcp/#fragment",
      "https://api.githubcopilot.com/mcp",
      " https://api.githubcopilot.com/mcp/",
    ]) {
      expect(() =>
        new GitHubOfficialMcpRemoteTransport({
          credentials: resolver(),
          endpoint,
        })
      ).toThrow("Official GitHub MCP endpoint is invalid");
    }
  });
});

function pullRequestMapping(): GitHubOfficialMcpMappedRead {
  const mapping = mapGitHubDelegatedReadToOfficialMcp({
    tool: "get_pr_info",
    arguments: { pr_number: 768 },
    repositoryFullName: "teamleaderleo/stensibly",
  });
  if (mapping.state !== "mapped") {
    throw new Error("Expected mapped pull request read");
  }
  return mapping;
}

function resolver() {
  return {
    async resolveGitHubOfficialMcpBearer() {
      return bearer;
    },
  };
}

function transportWith(factory: GitHubOfficialMcpRemoteSessionFactory) {
  return new GitHubOfficialMcpRemoteTransport({
    credentials: resolver(),
    sessionFactory: factory,
  });
}

function successEnvelope(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function createHarness(
  envelope: unknown,
  options: {
    connectError?: Error;
    callError?: Error;
    closeError?: Error;
  } = {},
) {
  const state = {
    factoryInputs: [] as GitHubOfficialMcpRemoteSessionFactoryInput[],
    calls: [] as {
      name: string;
      arguments: Readonly<Record<string, unknown>>;
      timeoutMs: number;
    }[],
    connected: 0,
    closed: 0,
  };
  const factory: GitHubOfficialMcpRemoteSessionFactory = {
    create(input) {
      state.factoryInputs.push(input);
      const session: GitHubOfficialMcpRemoteSession = {
        async connect() {
          state.connected += 1;
          if (options.connectError) throw options.connectError;
        },
        async callTool(call) {
          state.calls.push(call);
          if (options.callError) throw options.callError;
          return envelope;
        },
        async close() {
          state.closed += 1;
          if (options.closeError) throw options.closeError;
        },
      };
      return session;
    },
  };
  return Object.assign(state, { factory });
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

function deepValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}
