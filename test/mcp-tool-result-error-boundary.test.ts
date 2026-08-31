import { expect, test } from "bun:test";
import { asToolResult } from "../src/mcp-tool-result.ts";

test("returns one canonical structured JSON envelope with the readable result", async () => {
  const source = { id: "item-1", nested: { status: "ready" } };
  const result = await asToolResult(async () => source);

  expect(result).toEqual({
    content: [{
      type: "text",
      text: JSON.stringify(source, null, 2),
    }],
    structuredContent: { data: source },
  });
  expect(result.structuredContent?.data).not.toBe(source);
});

test("preserves an ordinary Error own-data message", async () => {
  await expect(asToolResult(async () => {
    throw new Error("bounded domain failure");
  })).resolves.toEqual({
    content: [{ type: "text", text: "bounded domain failure" }],
    isError: true,
  });
});

test("contains hostile thrown-object metadata behind a fixed MCP failure", async () => {
  let descriptorCalls = 0;
  const thrown = new Proxy(Object.create(null), {
    getOwnPropertyDescriptor(_target, key) {
      if (key === "message") {
        descriptorCalls += 1;
        throw new Error("foreign error metadata prose must not escape");
      }
      return undefined;
    },
    getPrototypeOf() {
      throw new Error("foreign error prototype prose must not escape");
    },
  });

  const result = await asToolResult(async () => {
    throw thrown;
  });
  expect(result).toEqual({
    content: [{ type: "text", text: "Tool operation failed" }],
    isError: true,
  });
  expect(descriptorCalls).toBe(1);
  expect(JSON.stringify(result)).not.toContain("foreign error");
});

test("does not invoke a thrown object's message accessor", async () => {
  let getterCalls = 0;
  const thrown = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(thrown, "message", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("foreign message getter must remain unreachable");
    },
  });

  const result = await asToolResult(async () => {
    throw thrown;
  });
  expect(result).toEqual({
    content: [{ type: "text", text: "Tool operation failed" }],
    isError: true,
  });
  expect(getterCalls).toBe(0);
});

test("does not stringify arbitrary non-Error thrown values", async () => {
  await expect(asToolResult(async () => {
    throw "provider-private-string";
  })).resolves.toEqual({
    content: [{ type: "text", text: "Tool operation failed" }],
    isError: true,
  });
});

test("bounds admitted Error messages by UTF-8 bytes", async () => {
  const accepted = "x".repeat(4 * 1024);
  await expect(asToolResult(async () => {
    throw new Error(accepted);
  })).resolves.toEqual({
    content: [{ type: "text", text: accepted }],
    isError: true,
  });

  await expect(asToolResult(async () => {
    throw new Error(`${accepted}x`);
  })).resolves.toEqual({
    content: [{ type: "text", text: "Tool operation failed" }],
    isError: true,
  });

  await expect(asToolResult(async () => {
    throw new Error("é".repeat(2_049));
  })).resolves.toEqual({
    content: [{ type: "text", text: "Tool operation failed" }],
    isError: true,
  });
});
