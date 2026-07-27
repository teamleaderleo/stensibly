import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  ConvexWorkLedger,
  HistoryWindowOverflowError,
  HostedBackendUpgradeRequiredError,
} from "../src/convex-ledger.ts";

const item = {
  id: "item_history",
  project: "scrapbook",
  kind: "task" as const,
  title: "Read bounded hosted history",
  status: "active" as const,
  priority: 70,
  claimedBy: null,
  claimExpiresAt: null,
  claimGeneration: 4,
  version: 5,
  createdAt: "2099-01-01T00:00:00.000Z",
  updatedAt: "2099-01-01T00:00:00.000Z",
};

const capability = {
  version: 1,
  itemDetailVisibleEventLimit: 100,
  directVisibleEventLimit: 1_000,
  physicalEventRowLimit: 5_000,
  physicalEventByteLimit: 8 * 1024 * 1024,
  artifactLimit: 100,
  artifactOverflowCode: "history_window_overflow:artifacts",
  boundedItemControl: true,
  boundedDirectEvents: true,
  boundedArtifacts: true,
};

const detail = {
  historyContractVersion: 1,
  item,
  control: {
    schemaVersion: 1,
    itemId: item.id,
    itemStatus: item.status,
    authority: {
      state: "unclaimed",
      holderActorId: null,
      generation: 4,
      source: "none",
      leaseExpiresAt: null,
      allowedOperations: [],
    },
    responsibility: {
      actorId: null,
      summary: null,
      nextAction: null,
      heartbeatExpectedAt: null,
    },
    execution: {
      state: "idle",
      runId: null,
      runnerActorId: null,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
    },
    observedAt: "2099-01-01T00:00:00.000Z",
  },
  events: [],
  eventsTruncated: false,
  artifacts: [],
  runs: [],
  dependencies: [],
};

function ledgerWith(query: (name: string) => Promise<unknown>) {
  return new ConvexWorkLedger({
    client: {
      query: async (reference: FunctionReference<"query">) => {
        return await query(getFunctionName(reference));
      },
      mutation: async () => {
        throw new Error("not used");
      },
    },
    serviceSecret: "service-secret",
    workspace: "default",
  });
}

describe("bounded hosted history compatibility", () => {
  test("fails closed before any history or reservation call when capability is missing", async () => {
    const calls: string[] = [];
    const ledger = ledgerWith(async (name) => {
      calls.push(name);
      if (name === "historyCapabilities:get") {
        throw new Error(
          "[CONVEX Q(historyCapabilities:get)] Server Error Could not find public function for 'historyCapabilities:get'.",
        );
      }
      throw new Error(`Unexpected query ${name}`);
    });

    await expect(ledger.getItem(item.id)).rejects.toBeInstanceOf(
      HostedBackendUpgradeRequiredError,
    );
    expect(calls).toEqual(["historyCapabilities:get"]);
  });

  test("rejects an incomplete or changed capability contract", async () => {
    for (const changed of [
      { ...capability, version: 2 },
      { ...capability, physicalEventRowLimit: 500 },
      { ...capability, artifactOverflowCode: "different" },
      { ...capability, boundedDirectEvents: false },
    ]) {
      const calls: string[] = [];
      const ledger = ledgerWith(async (name) => {
        calls.push(name);
        if (name === "historyCapabilities:get") return changed;
        throw new Error(`Unexpected query ${name}`);
      });

      await expect(ledger.getItem(item.id)).rejects.toBeInstanceOf(
        HostedBackendUpgradeRequiredError,
      );
      expect(calls).toEqual(["historyCapabilities:get"]);
    }
  });

  test("caches one accepted capability across bounded item and artifact reads", async () => {
    const calls: string[] = [];
    const ledger = ledgerWith(async (name) => {
      calls.push(name);
      if (name === "historyCapabilities:get") return capability;
      if (name === "itemControl:get") return detail;
      if (name === "itemReservations:list") return [];
      if (name === "artifacts:list") return [];
      throw new Error(`Unexpected query ${name}`);
    });

    await expect(ledger.getItem(item.id)).resolves.toMatchObject({
      item,
      historyContractVersion: 1,
      eventsTruncated: false,
      reservations: [],
    });
    await expect(ledger.listArtifacts(item.id)).resolves.toEqual([]);
    expect(calls.filter((name) => name === "historyCapabilities:get")).toHaveLength(1);
    expect(calls).not.toContain("items:get");
  });

  test("maps missing item control and artifact overflow after capability acceptance", async () => {
    const itemCalls: string[] = [];
    const itemLedger = ledgerWith(async (name) => {
      itemCalls.push(name);
      if (name === "historyCapabilities:get") return capability;
      if (name === "itemReservations:list") return [];
      if (name === "itemControl:get") {
        throw new Error(
          "[CONVEX Q(itemControl:get)] Server Error Could not find public function for 'itemControl:get'.",
        );
      }
      throw new Error(`Unexpected query ${name}`);
    });
    await expect(itemLedger.getItem(item.id)).rejects.toBeInstanceOf(
      HostedBackendUpgradeRequiredError,
    );
    expect(itemCalls).not.toContain("items:get");

    const artifactLedger = ledgerWith(async (name) => {
      if (name === "historyCapabilities:get") return capability;
      if (name === "artifacts:list") {
        throw new Error("history_window_overflow:artifacts");
      }
      throw new Error(`Unexpected query ${name}`);
    });
    await expect(artifactLedger.listArtifacts(item.id)).rejects.toBeInstanceOf(
      HistoryWindowOverflowError,
    );
  });

  test("preserves supported-backend transport and reservation failures", async () => {
    const itemLedger = ledgerWith(async (name) => {
      if (name === "historyCapabilities:get") return capability;
      if (name === "itemControl:get") throw new Error("Hosted backend request failed");
      if (name === "itemReservations:list") return [];
      throw new Error(`Unexpected query ${name}`);
    });
    await expect(itemLedger.getItem(item.id)).rejects.toThrow(
      "Hosted backend request failed",
    );

    const reservationLedger = ledgerWith(async (name) => {
      if (name === "historyCapabilities:get") return capability;
      if (name === "itemControl:get") return detail;
      if (name === "itemReservations:list") throw new Error("Reservation query failed");
      throw new Error(`Unexpected query ${name}`);
    });
    await expect(reservationLedger.getItem(item.id)).rejects.toThrow(
      "Reservation query failed",
    );
  });
});
