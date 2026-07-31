import { describe, expect, test } from "bun:test";
import {
  mapGitHubDelegatedReadToOfficialMcp,
  type GitHubOfficialMcpMappedRead,
} from "../src/github-official-mcp-read-mapping.ts";
import {
  GitHubOfficialMcpRemoteError,
  GitHubOfficialMcpRemoteTransport,
  githubOfficialMcpRemoteEndpoint,
  githubOfficialMcpRemoteMaximumResponseBytes,
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

  test("admits only server-side credential references before resolver activity", async () => {
    for (const acceptedRef of [
      credentialRef,
      "env://GITHUB_OFFICIAL_MCP_TOKEN",
    ]) {
      const credentialCalls: unknown[] = [];
      const harness = createHarness(successEnvelope({ ok: true }));
      const transport = new GitHubOfficialMcpRemoteTransport({
        credentials: {
          async resolveGitHubOfficialMcpBearer(input) {
            credentialCalls.push(input);
            return bearer;
          },
        },
        sessionFactory: harness.factory,
      });

      await transport.callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef: acceptedRef,
      });

      expect(credentialCalls).toEqual([{
        credentialRef: acceptedRef,
        repositoryFullName: "teamleaderleo/stensibly",
        officialTool: "pull_request_read",
      }]);
      expect(harness.factoryInputs).toHaveLength(1);
    }

    for (const rejectedRef of [
      "github_pat_raw_secret_1234567890",
      `ghp_${"A".repeat(36)}`,
      `sk-${"A".repeat(24)}`,
      `xoxb-${"1".repeat(24)}`,
      "Bearer github_pat_raw_secret_1234567890",
      " plain-reference ",
      "vault://github/official-mcp",
      "secret://github/official-mcp\n",
      "secret://",
      "secret:///github/official-mcp",
    ]) {
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
        transport.callMappedRead({
          mapping: pullRequestMapping(),
          credentialRef: rejectedRef,
        })
      );

      expect(error.code).toBe("github_official_mcp_credential_unavailable");
      expect(error.message).toBe(
        "Official GitHub MCP credential reference is invalid",
      );
      expect(credentialCalls).toBe(0);
      expect(harness.factoryInputs).toHaveLength(0);
    }
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
    const callError = await capturedError(() =>
      transportWith(callHarness.factory).callMappedRead({
        mapping,
        credentialRef,
      })
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
      statusText: "Found",
      redirected: false,
      url: githubOfficialMcpRemoteEndpoint,
      headers: new Headers(),
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

  test("bounds declared and streamed response bytes before SDK parsing", async () => {
    let declaredReaderCalls = 0;
    let declaredCancellations = 0;
    const declaredResponse = {
      status: 200,
      statusText: "OK",
      redirected: false,
      url: githubOfficialMcpRemoteEndpoint,
      headers: new Headers({
        "content-length": String(
          githubOfficialMcpRemoteMaximumResponseBytes + 1,
        ),
      }),
      body: {
        async cancel() {
          declaredCancellations += 1;
        },
        getReader() {
          declaredReaderCalls += 1;
          throw new Error("declared overflow body was read");
        },
      },
    } as unknown as Response;
    const declared = fetchHarness(
      (async () => declaredResponse) as typeof fetch,
    );
    const declaredError = await capturedError(() =>
      transportWith(declared.factory, declared.fetch).callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef,
      })
    );
    expect(declaredError.code).toBe("github_official_mcp_transport_failed");
    expect(declaredReaderCalls).toBe(0);
    expect(declaredCancellations).toBe(1);
    expect(declared.closed).toBe(1);

    let streamedPulls = 0;
    let streamedCancellations = 0;
    const streamedSource = new ReadableStream<Uint8Array>({
      pull(controller) {
        streamedPulls += 1;
        controller.enqueue(
          streamedPulls === 1
            ? new Uint8Array(githubOfficialMcpRemoteMaximumResponseBytes)
            : new Uint8Array([1]),
        );
      },
      cancel() {
        streamedCancellations += 1;
      },
    });
    const streamed = fetchHarness(
      (async () => new Response(streamedSource, { status: 200 })) as typeof fetch,
    );
    const streamedError = await capturedError(() =>
      transportWith(streamed.factory, streamed.fetch).callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef,
      })
    );
    expect(streamedError.code).toBe("github_official_mcp_transport_failed");
    expect(streamedPulls).toBe(2);
    expect(streamedCancellations).toBe(1);
    expect(streamed.closed).toBe(1);

    const secret = "github_pat_unreadable_response_echo_1234567890";
    const unreadable = fetchHarness((async () =>
      new Response(new ReadableStream<Uint8Array>({
        pull() {
          throw new Error(`provider leaked ${secret}`);
        },
      }), { status: 200 })) as typeof fetch);
    const unreadableError = await capturedError(() =>
      transportWith(unreadable.factory, unreadable.fetch).callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef,
      })
    );
    expect(unreadableError.code).toBe("github_official_mcp_transport_failed");
    expect(unreadableError.message).not.toContain(secret);
    expect(unreadable.closed).toBe(1);
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

  test("requires the one canonical official HTTPS MCP endpoint", () => {
    for (const endpoint of [
      "https://attacker.example/mcp/",
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

function transportWith(
  factory: GitHubOfficialMcpRemoteSessionFactory,
  injectedFetch?: typeof fetch,
) {
  return new GitHubOfficialMcpRemoteTransport({
    credentials: resolver(),
    sessionFactory: factory,
    ...(injectedFetch ? { fetch: injectedFetch } : {}),
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

function fetchHarness(injectedFetch: typeof fetch) {
  const state = { closed: 0, fetch: injectedFetch };
  const factory: GitHubOfficialMcpRemoteSessionFactory = {
    create(input) {
      return {
        async connect() {
          const response = await input.fetch(input.endpoint);
          await response.arrayBuffer();
        },
        async callTool() {
          throw new Error("unreachable");
        },
        async close() {
          state.closed += 1;
        },
      };
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
