import { describe, expect, test } from "bun:test";
import type {
  CodexAppServerNotification,
  CodexAppServerConnection,
} from "../src/codex-app-server-client.js";
import {
  CODEX_ROOT_RESIDENCY_V1,
  CodexMemoryAdmissionError,
  MemoryAwareCodexHostPool,
  type CodexMemoryProbeV1,
  type CodexMemorySnapshotV1,
  type CodexResidentHostConnection,
} from "../src/codex-root-residency.js";
import { parseRunnerExternalReferencePortableV1 } from "../src/runner-external-reference-portable.js";

class FakeMemoryProbe implements CodexMemoryProbeV1 {
  freePercent = 80;
  pressure: CodexMemorySnapshotV1["pressure"] = "normal";
  rssPerPid = 64 * 1024 * 1024;
  swapUsedBytes = 2 * 1024 * 1024 * 1024;

  async snapshot(rootPids: readonly number[]): Promise<CodexMemorySnapshotV1> {
    const processTrees = rootPids.map((rootPid) => ({
      rootPid,
      processCount: 3,
      rssBytes: this.rssPerPid,
      roles: [{
        role: "app_server_host" as const,
        processCount: 1,
        rssBytes: this.rssPerPid,
      }],
    }));
    return Object.freeze({
      version: CODEX_ROOT_RESIDENCY_V1,
      observedAt: "2026-08-25T13:00:00.000Z",
      physicalMemoryBytes: 24 * 1024 * 1024 * 1024,
      systemFreePercent: this.freePercent,
      pressure: this.pressure,
      swapUsedBytes: this.swapUsedBytes,
      processTrees: Object.freeze(processTrees),
      totalResidentRssBytes: processTrees.reduce((total, tree) => total + tree.rssBytes, 0),
    });
  }
}

class FakeResidentHost implements CodexResidentHostConnection {
  readonly pid: number;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  closed = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  async request<Result>(method: string, params: unknown): Promise<Result> {
    this.calls.push({ method, params });
    if (method === "thread/unsubscribe") return { status: "unsubscribed" } as Result;
    if (method === "thread/archive") return {} as Result;
    throw new Error(`Unexpected resident host request: ${method}`);
  }

  notificationCursor(): number { return 0; }
  notificationsSince(): readonly CodexAppServerNotification[] { return []; }
  async waitForNotification(): Promise<CodexAppServerNotification> {
    throw new Error("Fake resident host does not emit notifications");
  }
  async close(): Promise<void> { this.closed = true; }
}

function rootRef(thread: number) {
  return parseRunnerExternalReferencePortableV1({
    version: 1,
    kind: "session",
    adapterId: "openai-codex-app-server",
    externalId: `0198f00d-0000-7000-8000-${String(thread).padStart(12, "0")}`,
    digest: `sha256:${String(thread).padStart(64, "0")}`,
    uri: null,
    generation: 1,
    createdAt: "2026-08-25T13:00:00.000Z",
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

describe("memory-aware Codex runtime residency", () => {
  test("multiplexes logical roots on one host and parks them without retaining a second ledger", async () => {
    const probe = new FakeMemoryProbe();
    const hosts: FakeResidentHost[] = [];
    const pool = new MemoryAwareCodexHostPool({
      maxResidentHosts: 1,
      maxLogicalRootsPerHost: 3,
      maxResidentRssBytes: 512 * 1024 * 1024,
      estimatedNewHostRssBytes: 64 * 1024 * 1024,
      probe,
      hostFactory: async () => {
        const host = new FakeResidentHost(10_000 + hosts.length);
        hosts.push(host);
        return host;
      },
    });

    const first = await pool.acquire("mission/root-1");
    const second = await pool.acquire("mission/root-2");
    const third = await pool.acquire("mission/root-3");
    expect(new Set([first.hostId, second.hostId, third.hostId]).size).toBe(1);
    expect(pool.residentHostCount).toBe(1);
    expect(pool.residentLogicalRootCount).toBe(3);

    pool.bindRoot(first, rootRef(1));
    pool.bindRoot(second, rootRef(2));
    pool.bindRoot(third, rootRef(3));
    const parkedFirst = await pool.park(first, rootRef(1));
    expect(parkedFirst.residency.state).toBe("parked_resumable");
    expect(parkedFirst.hostProcessReleased).toBeFalse();
    expect(pool.residentLogicalRootCount).toBe(2);
    await pool.park(second, rootRef(2));
    const parkedLast = await pool.park(third, rootRef(3));

    expect(parkedLast.hostProcessReleased).toBeTrue();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.closed).toBeTrue();
    expect(pool.residentHostCount).toBe(0);
    expect(pool.residentLogicalRootCount).toBe(0);
    expect(hosts[0]?.calls.filter((call) => call.method === "thread/unsubscribe")).toHaveLength(3);
  });

  test("retires by archiving before unsubscribe and process release", async () => {
    const probe = new FakeMemoryProbe();
    const host = new FakeResidentHost(20_000);
    const pool = new MemoryAwareCodexHostPool({
      maxResidentHosts: 1,
      maxLogicalRootsPerHost: 1,
      maxResidentRssBytes: 512 * 1024 * 1024,
      estimatedNewHostRssBytes: 64 * 1024 * 1024,
      probe,
      hostFactory: async () => host,
    });
    const lease = await pool.acquire("mission/retire");
    pool.bindRoot(lease, rootRef(4));
    const retired = await pool.retire(lease, rootRef(4));

    expect(retired.residency.state).toBe("retired");
    expect(host.calls.map((call) => call.method)).toEqual(["thread/archive", "thread/unsubscribe"]);
    expect(host.closed).toBeTrue();
  });

  test("binds lease identity before a shared host can archive or unsubscribe a root", async () => {
    const host = new FakeResidentHost(25_000);
    const pool = new MemoryAwareCodexHostPool({
      maxResidentHosts: 1,
      maxLogicalRootsPerHost: 2,
      maxResidentRssBytes: 512 * 1024 * 1024,
      estimatedNewHostRssBytes: 64 * 1024 * 1024,
      probe: new FakeMemoryProbe(),
      hostFactory: async () => host,
    });
    const leaseA = await pool.acquire("mission/root-a");
    const leaseB = await pool.acquire("mission/root-b");
    const refA = rootRef(10);
    const refB = rootRef(11);
    pool.bindRoot(leaseA, refA);
    pool.bindRoot(leaseB, refB);

    await expect(pool.park(leaseA, refB)).rejects.toThrow(
      "cannot release a different root reference",
    );
    await expect(pool.retire(leaseA, refB)).rejects.toThrow(
      "cannot release a different root reference",
    );
    expect(host.calls).toEqual([]);
    expect(pool.residentLogicalRootCount).toBe(2);

    await pool.park(leaseA, refA);
    await pool.park(leaseB, refB);
    expect(host.calls.filter((call) => call.method === "thread/unsubscribe")).toHaveLength(2);
  });

  test("denies admission on pressure and configured RSS instead of only lowering worker count", async () => {
    const pressureProbe = new FakeMemoryProbe();
    pressureProbe.freePercent = 4;
    pressureProbe.pressure = "critical";
    const pressurePool = new MemoryAwareCodexHostPool({
      maxResidentHosts: 2,
      maxLogicalRootsPerHost: 2,
      maxResidentRssBytes: 512 * 1024 * 1024,
      estimatedNewHostRssBytes: 64 * 1024 * 1024,
      probe: pressureProbe,
      hostFactory: async () => new FakeResidentHost(30_000),
    });
    const pressureError = await captureAdmission(pressurePool.acquire("mission/pressure"));
    expect(pressureError.denial.reason).toBe("system_memory_pressure");
    expect(pressurePool.residentHostCount).toBe(0);

    const rssProbe = new FakeMemoryProbe();
    rssProbe.rssPerPid = 192 * 1024 * 1024;
    const host = new FakeResidentHost(40_000);
    const rssPool = new MemoryAwareCodexHostPool({
      maxResidentHosts: 1,
      maxLogicalRootsPerHost: 1,
      maxResidentRssBytes: 128 * 1024 * 1024,
      estimatedNewHostRssBytes: 64 * 1024 * 1024,
      probe: rssProbe,
      hostFactory: async () => host,
    });
    const rssError = await captureAdmission(rssPool.acquire("mission/rss"));
    expect(rssError.denial.reason).toBe("resident_rss_budget");
    expect(host.closed).toBeTrue();
    expect(rssPool.residentHostCount).toBe(0);
  });

  test("enforces host capacity separately from logical root count", async () => {
    const pool = new MemoryAwareCodexHostPool({
      maxResidentHosts: 1,
      maxLogicalRootsPerHost: 1,
      maxResidentRssBytes: 512 * 1024 * 1024,
      estimatedNewHostRssBytes: 64 * 1024 * 1024,
      probe: new FakeMemoryProbe(),
      hostFactory: async () => new FakeResidentHost(50_000),
      closeHostWhenIdle: false,
    });
    await pool.acquire("mission/one");
    const error = await captureAdmission(pool.acquire("mission/two"));
    expect(error.denial.reason).toBe("resident_host_limit");
    expect(pool.residentHostCount).toBe(1);
    await pool.close();
  });
});

async function captureAdmission(promise: Promise<unknown>): Promise<CodexMemoryAdmissionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CodexMemoryAdmissionError);
    return error as CodexMemoryAdmissionError;
  }
  throw new Error("Expected memory admission to fail");
}
