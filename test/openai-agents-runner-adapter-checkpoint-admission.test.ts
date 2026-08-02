import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/runner-adapters/openai-agents.ts", import.meta.url),
  "utf8",
);

test("checks active authority and holder before delegating to the core cache", () => {
  const methodStart = source.indexOf("  requestCheckpoint(");
  const methodEnd = source.indexOf("  requestCancellation(", methodStart);
  expect(methodStart).toBeGreaterThanOrEqual(0);
  expect(methodEnd).toBeGreaterThan(methodStart);

  const method = source.slice(methodStart, methodEnd);
  const activeAdmission = method.indexOf("assertControlAuthorityActive(input");
  const holderAdmission = method.indexOf("this.#assertControlBinding(input);");
  const coreRequest = method.indexOf("this.#core.requestCheckpoint(input)");
  expect(activeAdmission).toBeGreaterThanOrEqual(0);
  expect(holderAdmission).toBeGreaterThan(activeAdmission);
  expect(coreRequest).toBeGreaterThan(holderAdmission);
});

test("uses split fresh and replayed checkpoint chronology", () => {
  expect(source).toContain(
    "input.replayed\n      ? createdAt > append.proposedCreatedAt\n      : createdAt !== append.proposedCreatedAt",
  );
});
