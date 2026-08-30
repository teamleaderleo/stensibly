import { describe, expect, test } from "bun:test";
import type { ConvexWorkLedger } from "../src/convex-ledger.ts";
import { verifyHostedLazyWorkstation } from "../scripts/verify-hosted-lazy-workstation.ts";

describe("hosted Lazy workstation verifier", () => {
  test("settles fresh, replay, and stale-refusal paths into a content-free receipt", async () => {
    const calls: string[] = [];
    let reservationCalls = 0;
    let storedCommand: any = null;
    let storedSettlement: any = null;
    const ledger = {
      async createItem(input: any) {
        calls.push(`create:${input.idempotencyKey}`);
        return { id: input.idempotencyKey.endsWith(":source") ? "item_source" : "item_target" };
      },
      async proposeContinuation() {
        calls.push("propose");
        return { id: "continuation_1", generation: 1 };
      },
      async queueContinuationForSupervisor() {
        calls.push("queue");
        return { item: { claimGeneration: 1 }, run: { id: "run_1" } };
      },
      async claimRunnerWork() {
        calls.push("claim-run");
        return {
          id: "run_1",
          generation: 2,
          leaseGeneration: 2,
          leaseExpiresAt: "2026-09-01T00:00:00.000Z",
        };
      },
      async reserveLazyWorkstationCommand(input: any) {
        reservationCalls += 1;
        calls.push(`reserve:${reservationCalls}`);
        if (input.reservation.idempotencyKey.endsWith(":stale-reserve")) {
          throw new Error("Lazy workstation item claim generation or authority changed before reservation");
        }
        if (!storedCommand) {
          storedCommand = { ...input.reservation, reservedAt: "2026-08-31T00:00:00.000Z" };
          return { outcome: "reserved", dispatchAuthorized: true, command: storedCommand, settlement: null };
        }
        return {
          outcome: "replayed",
          dispatchAuthorized: false,
          command: storedCommand,
          settlement: storedSettlement,
        };
      },
      async settleRunnerAdapterCommand(input: any) {
        calls.push("settle");
        const outcome = storedSettlement ? "replayed" : "settled";
        storedSettlement ??= {
          ...input,
          outcomeSha256: `sha256:${"e".repeat(64)}`,
          settledAt: "2026-08-31T00:00:01.000Z",
        };
        return { outcome, settlement: storedSettlement };
      },
      async transitionRun() {
        calls.push("succeed-run");
        return { status: "succeeded" };
      },
      async claimWork() {
        calls.push("claim-source");
        return { claimGeneration: 1 };
      },
      async completeWork() {
        calls.push("complete-source");
        return { status: "done" };
      },
    } as unknown as ConvexWorkLedger;

    const receipt = await verifyHostedLazyWorkstation({
      ledger,
      runRef: "33335147018",
      revision: "b".repeat(40),
    });

    expect(receipt).toMatchObject({
      reservationAcquisition: "reserved",
      settlementAcquisition: "settled",
      terminalClaimInvalidationReplay: "replayed",
      freshStaleClaim: "refused",
      targetTerminal: "succeeded",
      sourceTerminal: "done",
      containsPrivateContent: false,
      containsCredentials: false,
      authorizesEffects: false,
      authorizesRedispatch: false,
    });
    expect(calls).toEqual([
      "create:hosted-lazy-33335147018:source",
      "create:hosted-lazy-33335147018:target",
      "propose",
      "queue",
      "claim-run",
      "reserve:1",
      "settle",
      "succeed-run",
      "reserve:2",
      "reserve:3",
      "claim-source",
      "complete-source",
    ]);
    const resumed = await verifyHostedLazyWorkstation({
      ledger,
      runRef: "33335147018",
      revision: "b".repeat(40),
    });
    expect(resumed).toMatchObject({
      reservationAcquisition: "replayed",
      settlementAcquisition: "replayed",
      terminalClaimInvalidationReplay: "replayed",
      freshStaleClaim: "refused",
    });
    expect(calls.slice(12)).toEqual([
      "create:hosted-lazy-33335147018:source",
      "create:hosted-lazy-33335147018:target",
      "propose",
      "queue",
      "claim-run",
      "reserve:4",
      "settle",
      "succeed-run",
      "reserve:5",
      "reserve:6",
      "claim-source",
      "complete-source",
    ]);
  });
});
