import { describe, expect, test } from "bun:test";
import {
  buildWorkerSignoff,
  type WorkerSignoffInput,
} from "../src/worker-signoff.ts";

const baseInput: WorkerSignoffInput = {
  callsign: "Nightjar",
};

describe("worker sign-off contract", () => {
  test("renders deterministic expanded attribution", () => {
    const signoff = buildWorkerSignoff({
      ...baseInput,
      mantle: { name: "Lantern", version: 2 },
      pod: "Foundry",
      intention: "decide exact-head acceptance",
      runId: "run_01JABC-123",
      work: "Stensibly / W02 / OAuth lifecycle",
      reviewedRevision: "8FD0C86",
    });

    expect(signoff).toEqual({
      version: 2,
      callsign: "Nightjar",
      mantle: { name: "Lantern", version: 2 },
      pod: "Foundry",
      intention: "decide exact-head acceptance",
      runId: "run_01JABC-123",
      work: "Stensibly / W02 / OAuth lifecycle",
      reviewedRevision: "8fd0c86",
      markdown: [
        "— Nightjar · Lantern mantle v2 · Foundry",
        "  Intention: decide exact-head acceptance",
        "  Run: run_01JABC-123",
        "  Work: Stensibly / W02 / OAuth lifecycle",
        "  Reviewed revision: 8fd0c86",
      ].join("\n"),
    });
  });

  test("renders a minimal callsign without empty metadata lines", () => {
    const signoff = buildWorkerSignoff(baseInput);

    expect(signoff).toEqual({
      version: 2,
      callsign: "Nightjar",
      mantle: null,
      pod: null,
      intention: null,
      runId: null,
      work: null,
      reviewedRevision: null,
      markdown: "— Nightjar",
    });
  });

  test("renders the lightweight routine footer", () => {
    const signoff = buildWorkerSignoff({
      ...baseInput,
      pod: "Foundry",
      intention: "unblock MCP dogfood",
    });

    expect(signoff.markdown).toBe([
      "— Nightjar · Foundry",
      "  Intention: unblock MCP dogfood",
    ].join("\n"));
    expect(signoff.markdown).not.toContain("Stance:");
    expect(signoff.markdown).not.toContain("ChatGPT worker");
  });

  test("normalizes bounded spaces and escapes inline Markdown", () => {
    const signoff = buildWorkerSignoff({
      callsign: "  Night*  Jar  ",
      mantle: { name: "Core_[v]", version: 3 },
      pod: "Foundry`Lab",
      intention: "review <read-only>",
      work: "Stensibly / [OAuth]",
    });

    expect(signoff.callsign).toBe("Night* Jar");
    expect(signoff.markdown).toBe([
      "— Night\\* Jar · Core\\_\\[v\\] mantle v3 · Foundry\\`Lab",
      "  Intention: review \\<read-only\\>",
      "  Work: Stensibly / \\[OAuth\\]",
    ].join("\n"));
  });

  test("renders numeric and named character references literally", () => {
    const hexadecimal = buildWorkerSignoff({
      ...baseInput,
      callsign: "Night&#x202e;jar",
    });
    expect(hexadecimal.markdown).toBe("— Night&amp;#x202e;jar");

    const decimal = buildWorkerSignoff({
      ...baseInput,
      intention: "review &#8238; safely",
    });
    expect(decimal.markdown).toContain("Intention: review &amp;#8238; safely");

    const named = buildWorkerSignoff({
      ...baseInput,
      pod: "Foundry&rlm;Lab",
    });
    expect(named.markdown).toBe("— Nightjar · Foundry&amp;rlm;Lab");

    const visibleAmpersand = buildWorkerSignoff({
      ...baseInput,
      work: "Research & Review",
    });
    expect(visibleAmpersand.work).toBe("Research & Review");
    expect(visibleAmpersand.markdown).toContain("Work: Research &amp; Review");
  });

  test("rejects empty, unsafe, and oversized descriptive fields", () => {
    expect(() => buildWorkerSignoff({ callsign: "   " }))
      .toThrow("Worker callsign must not be empty");
    expect(() => buildWorkerSignoff({ ...baseInput, intention: "review\n" }))
      .toThrow("Worker intention contains unsupported control characters");
    expect(() => buildWorkerSignoff({ ...baseInput, pod: "Foundry\u202e" }))
      .toThrow("Pod name contains unsupported control characters");
    expect(() => buildWorkerSignoff({ ...baseInput, callsign: "x".repeat(81) }))
      .toThrow("Worker callsign must be at most 80 characters");
    expect(() => buildWorkerSignoff({ ...baseInput, intention: "x".repeat(241) }))
      .toThrow("Worker intention must be at most 240 characters");
  });

  test("rejects malformed optional run identities", () => {
    for (const runId of [
      "worker_01JABC",
      "run_",
      "run_has/slash",
      `run_${"x".repeat(157)}`,
    ]) {
      expect(() => buildWorkerSignoff({ ...baseInput, runId })).toThrow();
    }
    expect(() => buildWorkerSignoff({ ...baseInput, runId: "run_has/slash" }))
      .toThrow("Run ID must start with run_");
  });

  test("rejects invalid mantle versions and reviewed revisions", () => {
    for (const version of [0, -1, 1.5, 10_000, Number.NaN]) {
      expect(() => buildWorkerSignoff({
        ...baseInput,
        mantle: { name: "Lantern", version },
      })).toThrow("Mantle version must be an integer from 1 to 9999");
    }

    expect(() => buildWorkerSignoff({ ...baseInput, reviewedRevision: "8fd0c86\n" }))
      .toThrow("Reviewed revision contains unsupported control characters");
    for (const reviewedRevision of ["abc123", "not-a-revision", "f".repeat(65)]) {
      expect(() => buildWorkerSignoff({ ...baseInput, reviewedRevision }))
        .toThrow("Reviewed revision must be 7 to 64 hexadecimal characters");
    }
  });
});
