import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CodexAppServerClient } from "../src/codex-app-server-client.js";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeAppServer(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-app-server-client-test-"));
  temporaryRoots.push(root);
  const executable = join(root, "fake-codex");
  await writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
${body}
`);
  await chmod(executable, 0o755);
  return executable;
}

describe("Codex app-server client", () => {
  test("handshakes, correlates requests, and retains bounded notifications", async () => {
    const executable = await fakeAppServer(`
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "test/ping") {
    send({ method: "thread/status/changed", params: { threadId: "root-1", status: { type: "idle" } } });
    send({ id: message.id, result: { pong: true } });
  }
});`);
    const client = await CodexAppServerClient.connect({
      codexBin: executable,
      requestTimeoutMs: 10_000,
      notificationLimit: 4,
    });
    try {
      const cursor = client.notificationCursor();
      const result = await client.request<{ readonly pong: boolean }>("test/ping", {});
      const notification = await client.waitForNotification(
        "thread/status/changed",
        (params) => (params as { readonly threadId?: string }).threadId === "root-1",
        cursor,
      );
      expect(result).toEqual({ pong: true });
      expect(notification.sequence).toBeGreaterThan(cursor);
      expect(client.notificationsSince(cursor)).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  test("denies server-initiated requests instead of granting hidden authority", async () => {
    const executable = await fakeAppServer(`
let pending = null;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "test/server-request") {
    pending = message.id;
    send({ id: 900, method: "item/requestApproval", params: { reason: "test" } });
  } else if (message.id === 900 && message.error && pending !== null) {
    send({ id: pending, result: { rejectedCode: message.error.code } });
  }
});`);
    const client = await CodexAppServerClient.connect({
      codexBin: executable,
      requestTimeoutMs: 10_000,
    });
    try {
      const result = await client.request<{ readonly rejectedCode: number }>("test/server-request", {});
      expect(result.rejectedCode).toBe(-32601);
    } finally {
      await client.close();
    }
  });

  test("fails closed when stdout violates the JSON-lines protocol", async () => {
    const executable = await fakeAppServer(`
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "test/malformed") process.stdout.write("not-json\\n");
});`);
    const client = await CodexAppServerClient.connect({
      codexBin: executable,
      requestTimeoutMs: 10_000,
    });
    try {
      await expect(client.request("test/malformed", {})).rejects.toThrow("malformed JSON");
    } finally {
      await client.close();
    }
  });

  test("terminates every live app-server process-group member on close", async () => {
    if (process.platform === "win32") return;
    const executable = await fakeAppServer(`
const { spawn } = require("node:child_process");
let descendant = null;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "test/descendant") {
    descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    send({ id: message.id, result: { pid: descendant.pid } });
  }
});`);
    const client = await CodexAppServerClient.connect({
      codexBin: executable,
      requestTimeoutMs: 10_000,
    });
    const result = await client.request<{ readonly pid: number }>("test/descendant", {});
    expect(await processIsLive(result.pid)).toBeTrue();
    await client.close();
    expect(await processIsLive(result.pid)).toBeFalse();
  });

  test("still escalates process-tree termination after a transport failure", async () => {
    if (process.platform === "win32") return;
    const executable = await fakeAppServer(`
const { spawn } = require("node:child_process");
let descendant = null;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "test/descendant") {
    descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    send({ id: message.id, result: { pid: descendant.pid } });
  }
  if (message.method === "test/malformed") process.stdout.write("not-json\\n");
});`);
    const client = await CodexAppServerClient.connect({
      codexBin: executable,
      requestTimeoutMs: 10_000,
    });
    const descendant = await client.request<{ readonly pid: number }>("test/descendant", {});
    await expect(client.request("test/malformed", {})).rejects.toThrow("malformed JSON");
    await client.close();
    expect(await processIsLive(descendant.pid)).toBeFalse();
  });
});

async function processIsLive(pid: number): Promise<boolean> {
  try {
    const result = await execFileAsync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      timeout: 5_000,
      encoding: "utf8",
    });
    const state = result.stdout.trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}
