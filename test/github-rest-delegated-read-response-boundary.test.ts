import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestDelegatedReadAdapter } from "../src/github-rest-delegated-read-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_response_boundary";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;

class TokenProvider implements GitHubInstallationTokenProvider {
  readonly requests: GitHubInstallationTokenRequest[] = [];

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requests.push(input);
    return {
      token: "delegated-token",
      expiresAt: "2026-08-08T12:00:00.000Z",
    };
  }
}

function adapter(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestDelegatedReadAdapter {
  return new GitHubRestDelegatedReadAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider: new TokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
  });
}

function callInput() {
  return {
    tool: "get_repo" as const,
    arguments: Object.freeze({}),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

function repositoryJson(fullName = repositoryFullName): string {
  return JSON.stringify({
    id: 123456,
    node_id: "R_kgDOresponse",
    full_name: fullName,
    private: true,
    archived: false,
    disabled: false,
    visibility: "private",
    default_branch: "main",
    updated_at: "2026-08-08T00:00:00Z",
    pushed_at: "2026-08-08T00:00:00Z",
  });
}

describe("delegated-read provider response admission", () => {
  test("rejects ambiguous Content-Length syntax before body intake", async () => {
    const instance = adapter(async () => new Response(repositoryJson(), {
      headers: {
        "content-type": "application/json",
        "content-length": "00",
      },
    }));

    await expect(instance.callReadTool(callInput()))
      .rejects.toThrow("returned an invalid Content-Length");
  });

  test("detaches delivered bytes without consulting caller byteLength", async () => {
    let byteLengthReads = 0;
    const chunk = new Uint8Array([0x7b]);
    Object.defineProperty(chunk, "byteLength", {
      configurable: true,
      get() {
        byteLengthReads += 1;
        throw new Error("provider byteLength prose must remain unreachable");
      },
    });

    const instance = adapter(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    ));

    await expect(instance.callReadTool(callInput()))
      .rejects.toThrow("returned invalid JSON");
    expect(byteLengthReads).toBe(0);
  });

  test("preserves complete Uint8Array bytes while ignoring hostile byteLength", async () => {
    let byteLengthReads = 0;
    const chunk = new TextEncoder().encode(repositoryJson());
    Object.defineProperty(chunk, "byteLength", {
      configurable: true,
      get() {
        byteLengthReads += 1;
        throw new Error("provider byteLength prose must remain unreachable");
      },
    });
    const instance = adapter(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    ));

    await expect(instance.callReadTool(callInput())).resolves.toMatchObject({
      result: {
        repositoryFullName,
        id: 123456,
        nodeId: "R_kgDOresponse",
        defaultBranch: "main",
      },
    });
    expect(byteLengthReads).toBe(0);
  });

  test("accepts an in-budget body delivered in more than 4096 byte chunks", async () => {
    const ordinary = JSON.parse(repositoryJson()) as Record<string, unknown>;
    const bytes = new TextEncoder().encode(JSON.stringify({
      ...ordinary,
      padding: "x".repeat(5_000),
    }));
    let offset = 0;
    const instance = adapter(async () => new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + 1));
          offset += 1;
        },
      }),
      { headers: { "content-type": "application/json" } },
    ));

    await expect(instance.callReadTool(callInput())).resolves.toMatchObject({
      result: { repositoryFullName, id: 123456 },
    });
    expect(offset).toBe(bytes.length);
    expect(bytes.length).toBeGreaterThan(4_096);
  });

  test("rejects typed-array chunks that are not Uint8Array", async () => {
    const chunk = new Uint16Array([0x7b, 0x7d]);
    const instance = adapter(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk as unknown as Uint8Array);
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    ));

    await expect(instance.callReadTool(callInput()))
      .rejects.toThrow("response could not be read");
  });

  test("contains hostile reader metadata behind fixed response failure", async () => {
    let getReaderReads = 0;
    const body = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(body, "getReader", {
      enumerable: true,
      get() {
        getReaderReads += 1;
        throw new Error("provider getReader prose must remain unreachable");
      },
    });
    const response = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(response, {
      ok: { value: true, enumerable: true },
      status: { value: 200, enumerable: true },
      headers: {
        value: new Headers({ "content-type": "application/json" }),
        enumerable: true,
      },
      body: { value: body, enumerable: true },
    });
    const instance = adapter(async () => response as unknown as Response);

    const rejectedCall = instance.callReadTool(callInput());
    await expect(rejectedCall).rejects.toThrow("response could not be read");
    await expect(rejectedCall).rejects.not.toThrow("provider getReader prose");
    expect(getReaderReads).toBe(0);
  });

  test("rejects duplicate-key provider JSON instead of selecting one value", async () => {
    const ordinary = repositoryJson();
    const duplicate = ordinary.replace(
      `"full_name":"${repositoryFullName}"`,
      `"full_name":"${repositoryFullName}","full_name":"teamleaderleo/other"`,
    );
    expect(duplicate).not.toBe(ordinary);
    const instance = adapter(async () => new Response(duplicate, {
      headers: { "content-type": "application/json" },
    }));

    await expect(instance.callReadTool(callInput()))
      .rejects.toThrow("returned invalid JSON");
  });
});
