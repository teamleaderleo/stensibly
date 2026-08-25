import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerConnection,
} from "./codex-app-server-client.js";
import {
  parseRunnerExternalReferencePortableV1,
  type RunnerExternalReferencePortableV1,
} from "./runner-external-reference-portable.js";

const execFileAsync = promisify(execFile);

export const CODEX_ROOT_RESIDENCY_V1 = 1 as const;

export type CodexRootResidencyStateV1 = "hot" | "parked_resumable" | "retired";
export type CodexMemoryPressureLevelV1 = "normal" | "warning" | "critical" | "unknown";

export interface CodexProcessTreeMemoryV1 {
  readonly rootPid: number;
  readonly processCount: number;
  readonly rssBytes: number;
  readonly roles: readonly CodexProcessRoleMemoryV1[];
}

export interface CodexProcessRoleMemoryV1 {
  readonly role: "app_server_host" | "codex_child" | "node_worker" | "other_child";
  readonly processCount: number;
  readonly rssBytes: number;
}

export interface CodexMemorySnapshotV1 {
  readonly version: typeof CODEX_ROOT_RESIDENCY_V1;
  readonly observedAt: string;
  readonly physicalMemoryBytes: number;
  readonly systemFreePercent: number | null;
  readonly pressure: CodexMemoryPressureLevelV1;
  readonly swapUsedBytes: number;
  readonly processTrees: readonly CodexProcessTreeMemoryV1[];
  readonly totalResidentRssBytes: number;
}

export interface CodexMemoryProbeV1 {
  snapshot(rootPids: readonly number[]): Promise<CodexMemorySnapshotV1>;
}

export interface CodexRootResidencyObservationV1 {
  readonly version: typeof CODEX_ROOT_RESIDENCY_V1;
  readonly logicalRootKey: string;
  readonly state: CodexRootResidencyStateV1;
  readonly rootRef: RunnerExternalReferencePortableV1;
  readonly hostId: string | null;
  readonly observedAt: string;
}

export interface CodexResidentRootLeaseV1 {
  readonly version: typeof CODEX_ROOT_RESIDENCY_V1;
  readonly logicalRootKey: string;
  readonly hostId: string;
  readonly connection: CodexAppServerConnection;
  readonly reusedHost: boolean;
  readonly acquiredAt: string;
}

export interface CodexResidentHostConnection extends CodexAppServerConnection {
  readonly pid: number;
}

export interface CodexRootReleaseObservationV1 {
  readonly version: typeof CODEX_ROOT_RESIDENCY_V1;
  readonly residency: CodexRootResidencyObservationV1;
  readonly unsubscribeStatus: string;
  readonly hostProcessReleased: boolean;
  readonly memoryBefore: CodexMemorySnapshotV1;
  readonly memoryAfter: CodexMemorySnapshotV1;
}

export type CodexMemoryAdmissionReasonV1 =
  | "system_memory_pressure"
  | "resident_rss_budget"
  | "resident_host_limit";

export interface CodexMemoryAdmissionDenialV1 {
  readonly version: typeof CODEX_ROOT_RESIDENCY_V1;
  readonly admitted: false;
  readonly reason: CodexMemoryAdmissionReasonV1;
  readonly configuredResidentRssBytes: number;
  readonly configuredResidentHosts: number;
  readonly snapshot: CodexMemorySnapshotV1;
}

export class CodexMemoryAdmissionError extends Error {
  readonly denial: CodexMemoryAdmissionDenialV1;

  constructor(denial: CodexMemoryAdmissionDenialV1) {
    super(`Codex runtime admission denied: ${denial.reason}`);
    this.name = "CodexMemoryAdmissionError";
    this.denial = denial;
  }
}

export interface MemoryAwareCodexHostPoolOptions {
  readonly maxResidentHosts: number;
  readonly maxLogicalRootsPerHost: number;
  readonly maxResidentRssBytes: number;
  readonly estimatedNewHostRssBytes: number;
  readonly minimumSystemFreePercent?: number;
  readonly closeHostWhenIdle?: boolean;
  readonly probe?: CodexMemoryProbeV1;
  readonly clientOptions?: CodexAppServerClientOptions;
  readonly hostFactory?: () => Promise<CodexResidentHostConnection>;
  readonly clock?: () => Date;
}

interface ResidentHost {
  readonly id: string;
  readonly client: CodexResidentHostConnection;
  readonly logicalRoots: Map<string, RunnerExternalReferencePortableV1 | null>;
}

/**
 * Ephemeral runtime capacity only. Durable root identity remains in the caller's
 * Stensibly binding; this pool retains no mission, goal, handoff, or transcript.
 */
export class MemoryAwareCodexHostPool {
  readonly #maxResidentHosts: number;
  readonly #maxLogicalRootsPerHost: number;
  readonly #maxResidentRssBytes: number;
  readonly #estimatedNewHostRssBytes: number;
  readonly #minimumSystemFreePercent: number;
  readonly #closeHostWhenIdle: boolean;
  readonly #probe: CodexMemoryProbeV1;
  readonly #hostFactory: () => Promise<CodexResidentHostConnection>;
  readonly #clock: () => Date;
  readonly #hosts = new Map<string, ResidentHost>();
  #nextHost = 1;

  constructor(options: MemoryAwareCodexHostPoolOptions) {
    this.#maxResidentHosts = positiveInteger(options.maxResidentHosts, "Maximum resident hosts");
    this.#maxLogicalRootsPerHost = positiveInteger(
      options.maxLogicalRootsPerHost,
      "Maximum logical roots per host",
    );
    this.#maxResidentRssBytes = positiveInteger(
      options.maxResidentRssBytes,
      "Maximum resident RSS",
    );
    this.#estimatedNewHostRssBytes = positiveInteger(
      options.estimatedNewHostRssBytes,
      "Estimated new host RSS",
    );
    this.#minimumSystemFreePercent = nonNegativeFinite(
      options.minimumSystemFreePercent ?? 10,
      "Minimum system free percent",
    );
    if (this.#minimumSystemFreePercent > 100) {
      throw new RangeError("Minimum system free percent cannot exceed 100");
    }
    this.#closeHostWhenIdle = options.closeHostWhenIdle ?? true;
    this.#probe = options.probe ?? new MacOsCodexMemoryProbe();
    this.#clock = options.clock ?? (() => new Date());
    this.#hostFactory = options.hostFactory
      ?? (() => CodexAppServerClient.connect(options.clientOptions));
  }

  get residentHostCount(): number {
    return this.#hosts.size;
  }

  get residentLogicalRootCount(): number {
    let count = 0;
    for (const host of this.#hosts.values()) count += host.logicalRoots.size;
    return count;
  }

  async acquire(logicalRootKeyInput: string): Promise<CodexResidentRootLeaseV1> {
    const logicalRootKey = safeIdentifier(logicalRootKeyInput, "Logical root key", 240);
    for (const host of this.#hosts.values()) {
      if (host.logicalRoots.has(logicalRootKey)) {
        return lease(host, logicalRootKey, true, this.#clock().toISOString());
      }
    }
    const snapshot = await this.snapshot();
    this.#admitMemory(snapshot);
    const reusable = [...this.#hosts.values()].find(
      (host) => host.logicalRoots.size < this.#maxLogicalRootsPerHost,
    );
    if (reusable) {
      reusable.logicalRoots.set(logicalRootKey, null);
      return lease(reusable, logicalRootKey, true, this.#clock().toISOString());
    }
    if (this.#hosts.size >= this.#maxResidentHosts) {
      throw this.#denial("resident_host_limit", snapshot);
    }
    if (snapshot.totalResidentRssBytes + this.#estimatedNewHostRssBytes > this.#maxResidentRssBytes) {
      throw this.#denial("resident_rss_budget", snapshot);
    }

    const client = await this.#hostFactory();
    const host: ResidentHost = {
      id: `codex-host-${this.#nextHost++}`,
      client,
      logicalRoots: new Map([[logicalRootKey, null]]),
    };
    this.#hosts.set(host.id, host);
    const after = await this.snapshot();
    if (after.totalResidentRssBytes > this.#maxResidentRssBytes) {
      this.#hosts.delete(host.id);
      await client.close();
      throw this.#denial("resident_rss_budget", after);
    }
    return lease(host, logicalRootKey, false, this.#clock().toISOString());
  }

  bindRoot(
    leaseInput: CodexResidentRootLeaseV1,
    rootRefInput: RunnerExternalReferencePortableV1,
  ): void {
    const lease = this.#hostLease(leaseInput);
    const host = this.#hosts.get(lease.hostId)!;
    const rootRef = parseRunnerExternalReferencePortableV1(rootRefInput);
    if (rootRef.adapterId !== "openai-codex-app-server") {
      throw new RangeError("Codex resident root reference uses a different adapter");
    }
    const current = host.logicalRoots.get(lease.logicalRootKey);
    if (current !== null && current !== undefined && !sameRootReference(current, rootRef)) {
      throw new Error("Codex resident lease is already bound to a different root reference");
    }
    host.logicalRoots.set(lease.logicalRootKey, rootRef);
  }

  async park(
    leaseInput: CodexResidentRootLeaseV1,
    rootRef: RunnerExternalReferencePortableV1,
  ): Promise<CodexRootReleaseObservationV1> {
    return this.#release(leaseInput, rootRef, "parked_resumable");
  }

  async retire(
    leaseInput: CodexResidentRootLeaseV1,
    rootRef: RunnerExternalReferencePortableV1,
  ): Promise<CodexRootReleaseObservationV1> {
    const bound = this.#boundRoot(leaseInput, rootRef);
    await bound.lease.connection.request("thread/archive", { threadId: bound.rootRef.externalId });
    return this.#release(bound.lease, bound.rootRef, "retired");
  }

  async snapshot(): Promise<CodexMemorySnapshotV1> {
    return this.#probe.snapshot([...this.#hosts.values()].map((host) => host.client.pid));
  }

  async close(): Promise<void> {
    const hosts = [...this.#hosts.values()];
    this.#hosts.clear();
    await Promise.all(hosts.map((host) => host.client.close()));
  }

  async #release(
    leaseInput: CodexResidentRootLeaseV1,
    rootRef: RunnerExternalReferencePortableV1,
    state: "parked_resumable" | "retired",
  ): Promise<CodexRootReleaseObservationV1> {
    const bound = this.#boundRoot(leaseInput, rootRef);
    const lease = bound.lease;
    const host = this.#hosts.get(lease.hostId)!;
    const threadId = bound.rootRef.externalId;
    const memoryBefore = await this.snapshot();
    const response = asRecord(
      await lease.connection.request("thread/unsubscribe", { threadId }),
      "thread/unsubscribe response",
    );
    const unsubscribeStatus = safeIdentifier(
      response.status,
      "Codex unsubscribe status",
      40,
    );
    host.logicalRoots.delete(lease.logicalRootKey);
    let hostProcessReleased = false;
    if (host.logicalRoots.size === 0 && this.#closeHostWhenIdle) {
      this.#hosts.delete(host.id);
      await host.client.close();
      hostProcessReleased = true;
    }
    const memoryAfter = await this.snapshot();
    return deepFreeze({
      version: CODEX_ROOT_RESIDENCY_V1,
      residency: {
        version: CODEX_ROOT_RESIDENCY_V1,
        logicalRootKey: lease.logicalRootKey,
        state,
        rootRef: bound.rootRef,
        hostId: null,
        observedAt: this.#clock().toISOString(),
      },
      unsubscribeStatus,
      hostProcessReleased,
      memoryBefore,
      memoryAfter,
    });
  }

  #hostLease(input: CodexResidentRootLeaseV1): CodexResidentRootLeaseV1 {
    if (input.version !== CODEX_ROOT_RESIDENCY_V1) throw new RangeError("Codex root lease version is invalid");
    const host = this.#hosts.get(input.hostId);
    if (!host || input.connection !== host.client || !host.logicalRoots.has(input.logicalRootKey)) {
      throw new Error("Codex root lease is no longer resident on its claimed host");
    }
    return input;
  }

  #boundRoot(
    leaseInput: CodexResidentRootLeaseV1,
    rootRefInput: RunnerExternalReferencePortableV1,
  ): { readonly lease: CodexResidentRootLeaseV1; readonly rootRef: RunnerExternalReferencePortableV1 } {
    const lease = this.#hostLease(leaseInput);
    const host = this.#hosts.get(lease.hostId)!;
    const expected = host.logicalRoots.get(lease.logicalRootKey);
    if (!expected) throw new Error("Codex resident lease must be bound to its exact root before release");
    const supplied = parseRunnerExternalReferencePortableV1(rootRefInput);
    if (!sameRootReference(expected, supplied)) {
      throw new Error("Codex resident lease cannot release a different root reference");
    }
    return { lease, rootRef: expected };
  }

  #admitMemory(snapshot: CodexMemorySnapshotV1): void {
    if (
      snapshot.pressure === "critical"
      || snapshot.pressure === "warning"
      || (snapshot.systemFreePercent !== null
        && snapshot.systemFreePercent < this.#minimumSystemFreePercent)
    ) {
      throw this.#denial("system_memory_pressure", snapshot);
    }
    if (snapshot.totalResidentRssBytes >= this.#maxResidentRssBytes) {
      throw this.#denial("resident_rss_budget", snapshot);
    }
  }

  #denial(
    reason: CodexMemoryAdmissionReasonV1,
    snapshot: CodexMemorySnapshotV1,
  ): CodexMemoryAdmissionError {
    return new CodexMemoryAdmissionError(deepFreeze({
      version: CODEX_ROOT_RESIDENCY_V1,
      admitted: false,
      reason,
      configuredResidentRssBytes: this.#maxResidentRssBytes,
      configuredResidentHosts: this.#maxResidentHosts,
      snapshot,
    }));
  }
}

export class MacOsCodexMemoryProbe implements CodexMemoryProbeV1 {
  readonly #clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock;
  }

  async snapshot(rootPids: readonly number[]): Promise<CodexMemorySnapshotV1> {
    if (process.platform !== "darwin") {
      throw new Error("MacOsCodexMemoryProbe requires macOS");
    }
    const pids = rootPids.map((pid) => positiveInteger(pid, "Root PID"));
    const [physical, swap, pressure, processes] = await Promise.all([
      run("/usr/sbin/sysctl", ["-n", "hw.memsize"]),
      run("/usr/sbin/sysctl", ["vm.swapusage"]),
      run("/usr/bin/memory_pressure", ["-Q"]),
      run("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="]),
    ]);
    const physicalMemoryBytes = positiveInteger(
      Number.parseInt(physical.trim(), 10),
      "Physical memory bytes",
    );
    const systemFreePercent = parseFreePercent(pressure);
    const processRows = parseProcessRows(processes);
    const processTrees = pids.map((pid) => processTree(pid, processRows));
    return deepFreeze({
      version: CODEX_ROOT_RESIDENCY_V1,
      observedAt: this.#clock().toISOString(),
      physicalMemoryBytes,
      systemFreePercent,
      pressure: pressureLevel(systemFreePercent),
      swapUsedBytes: parseSwapUsedBytes(swap),
      processTrees,
      totalResidentRssBytes: processTrees.reduce((total, tree) => total + tree.rssBytes, 0),
    });
  }
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKiB: number;
  readonly command: string;
}

function processTree(rootPid: number, rows: readonly ProcessRow[]): CodexProcessTreeMemoryV1 {
  const byParent = new Map<number, ProcessRow[]>();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const visited = new Set<number>();
  const pending = [rootPid];
  let rssKiB = 0;
  const roleTotals = new Map<CodexProcessRoleMemoryV1["role"], { count: number; rssKiB: number }>();
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const row = byPid.get(pid);
    if (row) {
      rssKiB += row.rssKiB;
      const role = processRole(row, rootPid);
      const total = roleTotals.get(role) ?? { count: 0, rssKiB: 0 };
      total.count += 1;
      total.rssKiB += row.rssKiB;
      roleTotals.set(role, total);
    }
    for (const child of byParent.get(pid) ?? []) pending.push(child.pid);
  }
  return deepFreeze({
    rootPid,
    processCount: [...visited].filter((pid) => byPid.has(pid)).length,
    rssBytes: rssKiB * 1_024,
    roles: [...roleTotals.entries()].map(([role, total]) => ({
      role,
      processCount: total.count,
      rssBytes: total.rssKiB * 1_024,
    })),
  });
}

function parseProcessRows(output: string): ProcessRow[] {
  return output.trim().split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) return [];
    return [{
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      rssKiB: Number.parseInt(match[3]!, 10),
      command: match[4]!,
    }];
  });
}

function processRole(
  row: ProcessRow,
  rootPid: number,
): CodexProcessRoleMemoryV1["role"] {
  if (row.pid === rootPid) return "app_server_host";
  const executable = row.command.split("/").at(-1)?.toLowerCase() ?? "";
  if (executable === "node" || executable === "bun") return "node_worker";
  if (executable.includes("codex")) return "codex_child";
  return "other_child";
}

function parseFreePercent(output: string): number | null {
  const match = /System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/iu.exec(output);
  return match ? Number.parseFloat(match[1]!) : null;
}

function pressureLevel(freePercent: number | null): CodexMemoryPressureLevelV1 {
  if (freePercent === null) return "unknown";
  if (freePercent <= 5) return "critical";
  if (freePercent <= 15) return "warning";
  return "normal";
}

function parseSwapUsedBytes(output: string): number {
  const match = /used\s*=\s*(\d+(?:\.\d+)?)([KMGTP])?/iu.exec(output);
  if (!match) throw new Error("Could not parse macOS swap usage");
  const multiplier = ({ K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40, P: 2 ** 50 } as const)[
    (match[2]?.toUpperCase() ?? "K") as "K" | "M" | "G" | "T" | "P"
  ];
  return Math.round(Number.parseFloat(match[1]!) * multiplier);
}

async function run(executable: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(executable, [...args], {
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout;
}

function lease(
  host: ResidentHost,
  logicalRootKey: string,
  reusedHost: boolean,
  acquiredAt: string,
): CodexResidentRootLeaseV1 {
  return Object.freeze({
    version: CODEX_ROOT_RESIDENCY_V1,
    logicalRootKey,
    hostId: host.id,
    connection: host.client,
    reusedHost,
    acquiredAt,
  });
}

function sameRootReference(
  left: RunnerExternalReferencePortableV1,
  right: RunnerExternalReferencePortableV1,
): boolean {
  return left.adapterId === right.adapterId
    && left.externalId === right.externalId
    && left.digest === right.digest
    && left.generation === right.generation;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RangeError(`${label} must be positive`);
  return value as number;
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be non-negative`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be text`);
  const output = value.trim();
  if (!output || output.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:/#@+\-=]*$/u.test(output)) {
    throw new RangeError(`${label} is invalid`);
  }
  return output;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
