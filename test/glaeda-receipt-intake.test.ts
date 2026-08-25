import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  LEGACY_SMOLRUNNER_V1_RECEIPT_INTAKE_SCHEMA_VERSION,
  compareGlaedaReceiptTransitions,
  glaedaReceiptStates,
  legacySmolRunnerV1ReceiptIntakeSchema,
  parseGlaedaReceiptIntake,
  projectGlaedaReceiptLiveness,
  type GlaedaReceiptIntake,
} from "../src/glaeda-receipt-intake.ts";

const historicalSmolRunnerV1 = JSON.parse(readFileSync(
  new URL("./fixtures/smolrunner-receipt-progress-v1.json", import.meta.url),
  "utf8",
)) as GlaedaReceiptIntake;

describe("Glaeda receipt intake compatibility", () => {
  test("uses a Glaeda-facing parser while preserving exact SmolRunner v1 decoding", () => {
    expect(LEGACY_SMOLRUNNER_V1_RECEIPT_INTAKE_SCHEMA_VERSION).toBe(1);
    expect(glaedaReceiptStates).toContain("running");
    expect(historicalSmolRunnerV1.receipt.producer.name).toBe("smolrunner");
    expect(historicalSmolRunnerV1.attempt.executorAdapter).toBe("smolrunner");

    expect(legacySmolRunnerV1ReceiptIntakeSchema.parse(historicalSmolRunnerV1))
      .toEqual(historicalSmolRunnerV1);

    const transition = parseGlaedaReceiptIntake(historicalSmolRunnerV1);
    expect(transition).toMatchObject({
      state: "running",
      transitionKind: "progress_checkpoint",
      producerVersion: "0.1.0",
    });
    expect(compareGlaedaReceiptTransitions(null, transition)).toEqual({ status: "insert" });
    expect(projectGlaedaReceiptLiveness(transition, "2026-07-28T18:04:59.999Z"))
      .toEqual({ state: "active", stalledAt: "2026-07-28T18:05:00.000Z" });
  });

  test("requires an explicit successor before admitting a Glaeda producer identity", () => {
    const rewritten = structuredClone(historicalSmolRunnerV1) as unknown as {
      receipt: { producer: { name: string } };
    };
    rewritten.receipt.producer.name = "glaeda";

    expect(() => parseGlaedaReceiptIntake(rewritten)).toThrow();
  });
});
