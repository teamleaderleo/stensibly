import { expect, test } from "bun:test";
import {
  mapGitHubDelegatedReadToOfficialMcp,
  type GitHubOfficialMcpMappedRead,
} from "../src/github-official-mcp-read-mapping.ts";
import {
  GitHubOfficialMcpRemoteError,
  GitHubOfficialMcpRemoteTransport,
  type GitHubOfficialMcpRemoteSession,
} from "../src/github-official-mcp-remote-transport.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const credentialRef = "secret://github/official-mcp";

for (const phase of ["connect", "call"] as const) {
  test(`official MCP ${phase} failure keeps arbitrary thrown value opaque`, async () => {
    let prototypeReads = 0;
    const hostileThrownValue = new Proxy(Object.create(null), {
      getPrototypeOf() {
        prototypeReads += 1;
        throw new Error("official MCP provider error prototype must remain opaque");
      },
    });
    const session: GitHubOfficialMcpRemoteSession = {
      async connect() {
        if (phase === "connect") throw hostileThrownValue;
      },
      async callTool() {
        if (phase === "call") throw hostileThrownValue;
        return successEnvelope();
      },
      async close() {},
    };
    const transport = new GitHubOfficialMcpRemoteTransport({
      credentials: {
        async resolveGitHubOfficialMcpBearer() {
          return "test-bearer";
        },
      },
      sessionFactory: {
        create() {
          return session;
        },
      },
      timeoutMs: 1_000,
    });

    let captured: unknown;
    try {
      await transport.callMappedRead({
        mapping: pullRequestMapping(),
        credentialRef,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(GitHubOfficialMcpRemoteError);
    expect(captured).toMatchObject({
      code: "github_official_mcp_transport_failed",
      message: "Official GitHub MCP read failed before a verified result was available",
    });
    expect(prototypeReads).toBe(0);
    expect(String(captured)).not.toContain("provider error prototype");
  });
}

test("official MCP result admission keeps its caught value opaque", async () => {
  let caughtPrototypeReads = 0;
  const hostileThrownValue = new Proxy(Object.create(null), {
    getPrototypeOf() {
      caughtPrototypeReads += 1;
      throw new Error("official MCP result error prototype must remain opaque");
    },
  });
  const hostileEnvelope = new Proxy(Object.create(null), {
    getPrototypeOf() {
      throw hostileThrownValue;
    },
  });
  const transport = new GitHubOfficialMcpRemoteTransport({
    credentials: {
      async resolveGitHubOfficialMcpBearer() {
        return "test-bearer";
      },
    },
    sessionFactory: {
      create() {
        return {
          async connect() {},
          async callTool() {
            return hostileEnvelope;
          },
          async close() {},
        };
      },
    },
    timeoutMs: 1_000,
  });

  let captured: unknown;
  try {
    await transport.callMappedRead({
      mapping: pullRequestMapping(),
      credentialRef,
    });
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(GitHubOfficialMcpRemoteError);
  expect(captured).toMatchObject({
    code: "github_official_mcp_invalid_result",
    message: "Official GitHub MCP returned an invalid or oversized result",
  });
  expect(caughtPrototypeReads).toBe(0);
  expect(String(captured)).not.toContain("result error prototype");
});

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
