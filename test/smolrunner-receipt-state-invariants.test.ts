import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  parseSmolRunnerReceiptIntake,
  projectSmolRunnerReceiptLiveness,
  type SmolRunnerReceiptIntake,
} from "../src/smolrunner-receipt-intake.ts";

const progressFixture = JSON.parse(readFileSync(
  new URL("./fixtures/smolrunner-receipt-progress-v1.json", import.meta.url),
  "utf8",
)) as SmolRunnerReceiptIntake;

describe("SmolRunner receipt state invariants", () => {
  test("requires queue evidence for a queued receipt", () => {
    const queued = structuredClone(progressFixture);
    queued.receipt.state = "queued";
    queued.receipt.phaseId = "queue";
    queued.receipt.startedAt = null;
    queued.receipt.terminalAt = null;
    queued.receipt.queue = {
      admittedAt: "2026-07-28T18:01:00.000Z",
      position: 2,
      capacityState: "busy",
    };
    queued.receipt.reservation = null;
    queued.receipt.heartbeat = null;
    queued.receipt.progress = null;
    queued.receipt.outcome.disposition = "none";

    expect(parseSmolRunnerReceiptIntake(queued)).toMatchObject({
      state: "queued",
      transitionKind: "queue_recorded",
      queue: queued.receipt.queue,
    });

    queued.receipt.queue = null;
    expect(() => parseSmolRunnerReceiptIntake(queued))
      .toThrow("Queued state requires queue evidence");
  });

  test("rejects liveness evaluation before the receipt observation", () => {
    const transition = parseSmolRunnerReceiptIntake(progressFixture);

    expect(() => projectSmolRunnerReceiptLiveness(
      transition,
      "2026-07-28T18:01:59.999Z",
    )).toThrow("Liveness evaluation cannot precede receipt observation");

    expect(projectSmolRunnerReceiptLiveness(
      transition,
      transition.observedAt,
    )).toEqual({
      state: "active",
      stalledAt: "2026-07-28T18:05:00.000Z",
    });
  });
});
