import { describe, expect, test } from "bun:test";
import {
  browseCallsignCatalog,
  buildCallsignReservationRequest,
} from "../src/callsign-catalog.ts";
import {
  callsignCatalogUsage,
  formatCallsignCatalogOutput,
  parseCallsignCatalogCliArgs,
} from "../src/callsign-catalog-cli.ts";

describe("callsign catalog", () => {
  test("projects the complete curated pool with stable pagination", () => {
    const first = browseCallsignCatalog({ limit: 3 });
    expect(first).toMatchObject({
      version: 1,
      totalCatalogEntries: 96,
      matchedEntries: 96,
      nextCursor: "catalog:3",
      reservesCallsign: false,
      grantsIdentityContinuity: false,
      grantsAuthority: false,
    });
    expect(first.entries.map((entry) => entry.callsign)).toEqual(["Albatross", "Alice", "Anvil"]);

    const second = browseCallsignCatalog({ limit: 3, cursor: first.nextCursor ?? undefined });
    expect(second.entries.map((entry) => entry.callsign)).toEqual(["Apron", "Axolotl", "Badger"]);
    expect(second.nextCursor).toBe("catalog:6");
  });

  test("searches collision keys and filters categories", () => {
    const search = browseCallsignCatalog({ query: "hot fix", limit: 10 });
    expect(search.entries.map((entry) => entry.callsign)).toEqual(["Hotfix"]);

    const objects = browseCallsignCatalog({ categories: ["object"], limit: 10 });
    expect(objects.entries.map((entry) => entry.callsign)).toEqual([
      "Anvil",
      "Apron",
      "Bellows",
      "Button",
      "Camera",
      "Compass",
      "Crayon",
      "Doorknob",
      "Easel",
      "Funnel",
    ]);
  });

  test("overlays active, cooling-off, reusable, and retired availability", () => {
    const result = browseCallsignCatalog({
      availability: [
        {
          callsign: "rook",
          state: "active",
          holderRunId: "run_rook_1",
          holderWorkerSessionId: "chatgpt.rook.1",
          generation: 2,
        },
        {
          callsign: "Lantern",
          state: "cooling_off",
          availableAt: "2026-08-01T00:00:00Z",
        },
        { callsign: "Alice", state: "reusable" },
        { callsign: "Glitch", state: "retired" },
      ],
      states: ["active", "cooling_off", "reusable", "retired"],
      limit: 10,
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ callsign: "Alice", state: "reusable", previouslyUsed: true }),
      expect.objectContaining({ callsign: "Glitch", state: "retired", previouslyUsed: true }),
      expect.objectContaining({
        callsign: "Lantern",
        state: "cooling_off",
        availableAt: "2026-08-01T00:00:00.000Z",
      }),
      expect.objectContaining({
        callsign: "Rook",
        state: "active",
        holderRunId: "run_rook_1",
        holderWorkerSessionId: "chatgpt.rook.1",
        generation: 2,
      }),
    ]);
  });

  test("rejects malformed overlays, filters, and cursors", () => {
    expect(() => browseCallsignCatalog({
      availability: [
        { callsign: "Rook", state: "retired" },
        { callsign: "rook", state: "retired" },
      ],
    })).toThrow("Duplicate callsign availability");
    expect(() => browseCallsignCatalog({
      availability: [{ callsign: "Rook", state: "active" }],
    })).toThrow("requires holder run");
    expect(() => browseCallsignCatalog({ cursor: "bad" })).toThrow("cursor is malformed");
    expect(() => browseCallsignCatalog({ categories: ["animal", "animal"] })).toThrow(
      "contains duplicates",
    );
  });
});

describe("callsign reservation request", () => {
  test("builds a deterministic non-accepting request", () => {
    const first = buildCallsignReservationRequest({
      workspace: "Default",
      requestedCallsign: " Rook ",
      workerSessionId: "chatgpt.rook.1",
      runId: "run_rook_1",
      requestId: "callsign:run_rook_1:rook",
      requestedAt: "2026-07-29T00:00:00Z",
      expiresAt: "2026-07-29T12:00:00Z",
    });
    const second = buildCallsignReservationRequest({
      workspace: "default",
      requestedCallsign: "Rook",
      workerSessionId: "chatgpt.rook.1",
      runId: "run_rook_1",
      requestId: "callsign:run_rook_1:rook",
      requestedAt: "2026-07-29T00:00:00.000Z",
      expiresAt: "2026-07-29T12:00:00.000Z",
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      workspace: "default",
      requestedCallsign: "Rook",
      collisionKey: "rook",
      requestsReservation: true,
      reservationAccepted: false,
      grantsIdentityContinuity: false,
      grantsAuthority: false,
    });
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("preserves explicit inheritance without implying continuity", () => {
    const request = buildCallsignReservationRequest({
      workspace: "default",
      requestedCallsign: "Lantern",
      workerSessionId: "chatgpt.lantern.2",
      runId: "run_lantern_2",
      requestId: "callsign:run_lantern_2:lantern",
      requestedAt: "2026-07-29T00:00:00Z",
      expiresAt: "2026-07-29T01:00:00Z",
      expectedGeneration: 4,
      inheritance: {
        fromRunId: "run_lantern_1",
        transferReference: "handoff:#450",
      },
    });

    expect(request.inheritance).toEqual({
      fromRunId: "run_lantern_1",
      transferReference: "handoff:#450",
    });
    expect(request.expectedGeneration).toBe(4);
    expect(request.grantsIdentityContinuity).toBe(false);
  });

  test("rejects invalid lifetime and self-inheritance", () => {
    expect(() => buildCallsignReservationRequest({
      workspace: "default",
      requestedCallsign: "Rook",
      workerSessionId: "session",
      runId: "run_one",
      requestId: "request-one",
      requestedAt: "2026-07-29T12:00:00Z",
      expiresAt: "2026-07-29T11:00:00Z",
    })).toThrow("later than request time");

    expect(() => buildCallsignReservationRequest({
      workspace: "default",
      requestedCallsign: "Rook",
      workerSessionId: "session",
      runId: "run_one",
      requestId: "request-one",
      requestedAt: "2026-07-29T00:00:00Z",
      expiresAt: "2026-07-29T01:00:00Z",
      inheritance: { fromRunId: "run_one", transferReference: "handoff:#450" },
    })).toThrow("must differ");
  });
});

describe("callsign catalog CLI", () => {
  test("parses browse filters", () => {
    expect(parseCallsignCatalogCliArgs([
      "browse",
      "--query",
      "rook",
      "--category",
      "animal",
      "--state",
      "available,reusable",
      "--limit",
      "10",
      "--json",
    ])).toEqual({
      help: false,
      json: true,
      command: "browse",
      input: {
        query: "rook",
        limit: 10,
        categories: ["animal"],
        states: ["available", "reusable"],
      },
    });
  });

  test("builds a convenient request draft from flags and environment", () => {
    const parsed = parseCallsignCatalogCliArgs(
      ["request", "Rook", "--ttl-seconds", "3600"],
      {
        STENSIBLY_WORKSPACE: "default",
        STENSIBLY_WORKER_SESSION: "chatgpt.rook.1",
        STENSIBLY_RUN_ID: "run_rook_1",
      },
      new Date("2026-07-29T00:00:00Z"),
    );
    expect(parsed).toEqual({
      help: false,
      json: false,
      command: "request",
      input: {
        workspace: "default",
        requestedCallsign: "Rook",
        workerSessionId: "chatgpt.rook.1",
        runId: "run_rook_1",
        requestId: "callsign:run_rook_1:rook",
        requestedAt: "2026-07-29T00:00:00.000Z",
        expiresAt: "2026-07-29T01:00:00.000Z",
      },
    });
  });

  test("formats browse and request output and documents the non-acceptance boundary", () => {
    const browse = browseCallsignCatalog({ limit: 2 });
    expect(formatCallsignCatalogOutput(browse, false)).toContain("\t");

    const request = buildCallsignReservationRequest({
      workspace: "default",
      requestedCallsign: "Rook",
      workerSessionId: "chatgpt.rook.1",
      runId: "run_rook_1",
      requestId: "callsign:run_rook_1:rook",
      requestedAt: "2026-07-29T00:00:00Z",
      expiresAt: "2026-07-29T01:00:00Z",
    });
    expect(formatCallsignCatalogOutput(request, false)).toContain("Reservation accepted: false");
    expect(callsignCatalogUsage()).toContain("remains unaccepted");
  });
});
