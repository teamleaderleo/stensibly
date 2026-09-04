import { expect, test } from "bun:test";
import { verifyCommanderRead } from "../scripts/verify-commander-read.ts";
import { WORKER_VERSION_ID_HEADER } from "../src/worker-observability.ts";

test("readback binds deployed version, repeats fingerprint and expands the exact row without retaining prose", async () => {
  const calls: any[] = [];
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const fake = (async (_url: unknown, init: RequestInit) => {
    const input = JSON.parse(init.body as string).params; calls.push(input);
    const data = input.name === "get_runner_context" ? { item: { id: "item-1" } } : {
      contract: "commander-brief/v1", project: "stensibly", status: calls.length === 1 ? "current" : "unchanged", fingerprint,
      coverage: { execution: "requires_current_admission" }, attention: [{ id: "item-1", title: "Private project prose" }], ready: [], blocked: [], active: [],
    };
    return new Response(JSON.stringify({ result: { structuredContent: { data } } }), { headers: { [WORKER_VERSION_ID_HEADER]: "version-1" } });
  }) as typeof fetch;
  const result = await verifyCommanderRead("https://api.stensibly.com", "stensibly", "test-token", "version-1", fake);
  expect(result.expanded).toBe(true); expect(result.reads).toBe(3);
  expect(calls[1].arguments.previousFingerprint).toBe(fingerprint);
  expect(calls[2].arguments).toEqual({ id: "item-1" });
  expect(JSON.stringify(result)).not.toContain("Private project prose");
  expect(JSON.stringify(result)).not.toContain("test-token");
  await expect(verifyCommanderRead("https://api.stensibly.com", "stensibly", "test-token", "wrong-version", fake)).rejects.toThrow("version mismatch");
  for (const override of [{ project: "other" }, { fingerprint: `sha256:${"b".repeat(64)}` }, { coverage: {} }]) {
    calls.length = 0;
    const wrongRepeat = (async (url: unknown, init: RequestInit) => {
      const response = await fake(url as string, init);
      const body = await response.json();
      if (calls.length === 2) Object.assign(body.result.structuredContent.data, override);
      return new Response(JSON.stringify(body), { headers: { [WORKER_VERSION_ID_HEADER]: "version-1" } });
    }) as typeof fetch;
    await expect(verifyCommanderRead("https://api.stensibly.com", "stensibly", "test-token", "version-1", wrongRepeat)).rejects.toThrow("repeat contract mismatch");
  }
});
