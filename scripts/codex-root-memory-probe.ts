import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexRootHarness,
  codexRootMissionRevision,
  codexRootProfileVersion,
  type CodexRootBindingV1,
  type CodexRootMissionV1,
  type CodexRootProfileV1,
} from "../src/codex-root-harness.js";
import {
  MacOsCodexMemoryProbe,
  MemoryAwareCodexHostPool,
  type CodexResidentHostConnection,
} from "../src/codex-root-residency.js";
import { runnerProfileProvenanceV1 } from "../src/runner-profile-provenance.js";

if (process.platform !== "darwin") throw new Error("The Codex memory dogfood probe currently requires macOS");

const model = process.argv[2] ?? "gpt-5.6-luna";
const effort = "low" as const;
const root = await mkdtemp(join(tmpdir(), "stensibly-codex-memory-probe-"));
const workspaces = ["a", "b", "c"].map((name) => join(root, `root-${name}`));
await Promise.all(workspaces.map((cwd) => mkdir(cwd)));
const memoryProbe = new MacOsCodexMemoryProbe();
const baseline = await memoryProbe.snapshot([]);
const pool = new MemoryAwareCodexHostPool({
  maxResidentHosts: 1,
  maxLogicalRootsPerHost: 2,
  maxResidentRssBytes: 1_500 * 1024 * 1024,
  estimatedNewHostRssBytes: 128 * 1024 * 1024,
  minimumSystemFreePercent: 10,
  closeHostWhenIdle: true,
  probe: memoryProbe,
});

const missions = ["a", "b", "c"].map((name) => mission(name));
const initialProfiles = workspaces.map((cwd) => profile(cwd, 1_000));
const bindings: CodexRootBindingV1[] = [];
let cleanupConnection: CodexResidentHostConnection | null = null;

try {
  const leaseA = await pool.acquire("memory-probe/root-a");
  const leaseB = await pool.acquire("memory-probe/root-b");
  if (leaseA.connection !== leaseB.connection) throw new Error("Logical roots did not share one runtime host");
  const firstHostPid = (leaseA.connection as CodexResidentHostConnection).pid;
  const idleSharedHostMemory = await pool.snapshot();
  const sharedHarness = new CodexRootHarness(leaseA.connection);
  const firstPairStartedAt = Date.now();
  const [rootA, rootB] = await Promise.all([
    sharedHarness.start(missions[0]!, initialProfiles[0]!),
    sharedHarness.start(missions[1]!, initialProfiles[1]!),
  ]);
  pool.bindRoot(leaseA, rootA.binding.rootRef);
  pool.bindRoot(leaseB, rootB.binding.rootRef);
  const firstPairElapsedMs = Date.now() - firstPairStartedAt;
  bindings.push(rootA.binding, rootB.binding);
  const hotPairMemory = await pool.snapshot();

  const parkedA = await pool.park(leaseA, rootA.binding.rootRef);
  const oneResidentRootMemory = await pool.snapshot();
  const leaseC = await pool.acquire("memory-probe/root-c");
  if (leaseC.connection !== leaseB.connection) throw new Error("Third logical root did not reuse the resident host");
  const rootC = await new CodexRootHarness(leaseC.connection).start(missions[2]!, initialProfiles[2]!);
  pool.bindRoot(leaseC, rootC.binding.rootRef);
  bindings.push(rootC.binding);
  const secondPairMemory = await pool.snapshot();
  const parkedB = await pool.park(leaseB, rootB.binding.rootRef);
  const parkedC = await pool.park(leaseC, rootC.binding.rootRef);
  const fullyParkedMemory = await pool.snapshot();
  const firstHostReaped = !processExists(firstHostPid);

  const durableA = JSON.parse(JSON.stringify(rootA.binding)) as CodexRootBindingV1;
  const resumeLease = await pool.acquire("memory-probe/root-a");
  cleanupConnection = resumeLease.connection as CodexResidentHostConnection;
  const secondHostPid = cleanupConnection.pid;
  const resumeStartedAt = Date.now();
  const resumedA = await new CodexRootHarness(resumeLease.connection).continue(
    durableA,
    {
      ...missions[0]!,
      launchBrief: "Reply with exactly MEMORY-A-RESUMED and do not use tools.",
    },
    profile(workspaces[0]!, 30_000),
  );
  pool.bindRoot(resumeLease, resumedA.binding.rootRef);
  const resumeLatencyMs = Date.now() - resumeStartedAt;
  const peerB = await resumeLease.connection.request<{ readonly goal: unknown }>("thread/goal/get", {
    threadId: rootB.binding.runtime.threadId,
  });
  const peerBUnaffected = JSON.stringify(peerB.goal) === JSON.stringify({
    threadId: rootB.binding.runtime.threadId,
    objective: missions[1]!.objective,
    status: rootB.observation.goal.status,
    tokenBudget: rootB.observation.goal.tokenBudget,
    tokensUsed: rootB.observation.goal.tokensUsed,
    timeUsedSeconds: rootB.observation.goal.timeUsedSeconds,
    createdAt: (peerB.goal as { createdAt?: unknown } | null)?.createdAt,
    updatedAt: (peerB.goal as { updatedAt?: unknown } | null)?.updatedAt,
  });
  await resumeLease.connection.request("thread/archive", { threadId: rootB.binding.runtime.threadId });
  await resumeLease.connection.request("thread/archive", { threadId: rootC.binding.runtime.threadId });
  const retiredA = await pool.retire(resumeLease, resumedA.binding.rootRef);
  cleanupConnection = null;
  const finalMemory = await pool.snapshot();
  const secondHostReaped = !processExists(secondHostPid);

  const serializedBindings = bindings.map((binding) => JSON.parse(JSON.stringify(binding)) as CodexRootBindingV1);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "codex-root-memory-probe/1",
    machine: {
      physicalMemoryBytes: baseline.physicalMemoryBytes,
      configuredResidentRssBytes: 1_500 * 1024 * 1024,
      configuredResidentHosts: 1,
      configuredLogicalRootsPerHost: 2,
    },
    logicalRoots: {
      total: 3,
      maximumResidentConcurrently: 2,
      maximumUsefulConcurrentTurns: 2,
      firstPairElapsedMs,
      sharedOneHost: true,
    },
    lifecycle: {
      hot: [rootA.observation, rootB.observation, rootC.observation],
      parked: [parkedA.residency, parkedB.residency, parkedC.residency],
      resumed: resumedA.observation,
      retired: retiredA.residency,
      exactThreadResumed: resumedA.binding.runtime.threadId === durableA.runtime.threadId,
      exactSessionTreeResumed: resumedA.binding.runtime.sessionId === durableA.runtime.sessionId,
      exactGoalResumed: resumedA.binding.objectiveDigest === durableA.objectiveDigest,
      bindingsSurvivedJsonRoundTrip: serializedBindings.every((binding, index) =>
        binding.runtime.threadId === bindings[index]?.runtime.threadId),
      peerUnaffected: peerBUnaffected,
    },
    memory: {
      baseline,
      idleSharedHost: idleSharedHostMemory,
      hotPair: hotPairMemory,
      oneResidentRoot: oneResidentRootMemory,
      secondPair: secondPairMemory,
      fullyParked: fullyParkedMemory,
      final: finalMemory,
      firstHostReaped,
      secondHostReaped,
      swapDeltaAtHotPairBytes: hotPairMemory.swapUsedBytes - baseline.swapUsedBytes,
      swapDeltaAfterParkBytes: fullyParkedMemory.swapUsedBytes - baseline.swapUsedBytes,
      rssAttribution: {
        method: "shared_host_marginal_estimate",
        averageFirstPairOverIdleBytes:
          (hotPairMemory.totalResidentRssBytes - idleSharedHostMemory.totalResidentRssBytes) / 2,
        rootAReleaseDeltaBytes:
          oneResidentRootMemory.totalResidentRssBytes - hotPairMemory.totalResidentRssBytes,
        rootCAdmissionDeltaBytes:
          secondPairMemory.totalResidentRssBytes - oneResidentRootMemory.totalResidentRssBytes,
      },
    },
    resume: {
      latencyMs: resumeLatencyMs,
      handoffMs: resumedA.observation.handoffMs,
      executionMs: resumedA.observation.executionMs,
      briefCharacters: resumedA.observation.briefCharacters,
      inputTokens: resumedA.observation.tokenUsage?.inputTokens ?? null,
      cachedInputTokens: resumedA.observation.tokenUsage?.cachedInputTokens ?? null,
    },
  }, null, 2)}\n`);
} finally {
  if (cleanupConnection) {
    for (const binding of bindings) {
      try { await cleanupConnection.request("thread/archive", { threadId: binding.runtime.threadId }); } catch {}
    }
  }
  await pool.close();
  await rm(root, { recursive: true, force: true });
}

function mission(name: string): CodexRootMissionV1 {
  const objective = `Complete bounded memory multiplexing probe root ${name}`;
  return {
    version: 1,
    missionRef: `stensibly:memory-probe/root-${name}`,
    responsibilityGeneration: 1,
    revisionDigest: codexRootMissionRevision({ name, objective }),
    objective,
    launchBrief: `Reply with exactly MEMORY-${name.toUpperCase()}-STARTED and do not use tools.`,
  };
}

function profile(cwd: string, goalTokenBudget: number): CodexRootProfileV1 {
  const sandbox = "read-only" as const;
  const networkAccess = false;
  const approvalPolicy = "never" as const;
  return {
    version: 1,
    provenance: runnerProfileProvenanceV1(
      `codex-root:${model}-memory-probe`,
      codexRootProfileVersion({
        model,
        effort,
        sandbox,
        networkAccess,
        approvalPolicy,
        cwd,
        appServerVersion: "0.146.0",
      }),
    ),
    model,
    effort,
    cwd,
    sandbox,
    networkAccess,
    approvalPolicy,
    appServerVersion: "0.146.0",
    goalTokenBudget,
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
