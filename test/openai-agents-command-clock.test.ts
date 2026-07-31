import { describe, expect, test } from "bun:test";
import { createOpenAIAgentsCommandClockV1 } from "../src/runner-adapters/openai-agents-command-clock.ts";

const fixedError = "OpenAI Agents adapter clock is invalid";
const secret = "sk-proj-late-clock-secret";

describe("OpenAI Agents command clock", () => {
  test("calls the injected clock once and derives every later timestamp purely", () => {
    let calls = 0;
    const clock = createOpenAIAgentsCommandClockV1(
      () => {
        calls += 1;
        if (calls > 1) throw new Error(secret);
        return new Date("2026-07-31T00:00:02.000Z");
      },
      "2026-07-31T00:00:01.000Z",
    );

    expect(clock.baseObservedAt).toBe("2026-07-31T00:00:02.000Z");
    expect(clock.timestamp(0)).toBe("2026-07-31T00:00:02.000Z");
    expect(clock.timestamp(1)).toBe("2026-07-31T00:00:02.001Z");
    expect(clock.timestamp(17)).toBe("2026-07-31T00:00:02.017Z");
    expect(calls).toBe(1);
    expect(Object.isFrozen(clock)).toBe(true);
  });

  test("uses the issued command time as the monotonic floor", () => {
    let calls = 0;
    const clock = createOpenAIAgentsCommandClockV1(
      () => {
        calls += 1;
        return new Date("2026-07-31T00:00:00.000Z");
      },
      "2026-07-31T00:00:05.000Z",
    );

    expect(clock.baseObservedAt).toBe("2026-07-31T00:00:05.000Z");
    expect(clock.timestamp(3)).toBe("2026-07-31T00:00:05.003Z");
    expect(calls).toBe(1);
  });

  test("fails before returning a command clock when initial admission is invalid", () => {
    for (const now of [
      () => {
        throw new Error(secret);
      },
      () => new Date(Number.NaN),
    ]) {
      let message = "";
      try {
        createOpenAIAgentsCommandClockV1(
          now,
          "2026-07-31T00:00:00.000Z",
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe(fixedError);
      expect(message).not.toContain(secret);
    }

    expect(() => createOpenAIAgentsCommandClockV1(
      () => new Date("2026-07-31T00:00:00.000Z"),
      "2026-07-31",
    )).toThrow(fixedError);
  });

  test("rejects invalid or overflowing ordinals without another clock call", () => {
    let calls = 0;
    const clock = createOpenAIAgentsCommandClockV1(
      () => {
        calls += 1;
        return new Date("2026-07-31T00:00:00.000Z");
      },
      "2026-07-31T00:00:00.000Z",
    );

    for (const ordinal of [-1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => clock.timestamp(ordinal)).toThrow(fixedError);
    }
    expect(calls).toBe(1);
  });
});
