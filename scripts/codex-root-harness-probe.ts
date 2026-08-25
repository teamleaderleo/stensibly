import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../src/codex-app-server-client.js";
import {
  CodexRootHarness,
  codexRootMissionRevision,
  codexRootProfileVersion,
  type CodexRootBindingV1,
  type CodexRootMissionV1,
  type CodexRootProfileV1,
  type CodexRootRunObservationV1,
} from "../src/codex-root-harness.js";
import { runnerProfileProvenanceV1 } from "../src/runner-profile-provenance.js";

interface ProbeEvidence {
  readonly schemaVersion: "codex-root-harness-probe/1";
  readonly auth: "chatgpt_subscription";
  readonly roots: {
    readonly started: number;
    readonly resumed: number;
    readonly replaced: number;
    readonly independentSessionTrees: boolean;
  };
  readonly lifecycle: readonly CodexRootRunObservationV1[];
  readonly controllerRestartRecovered: boolean;
  readonly unaffectedPeer: boolean;
  readonly freshSuccessorUsedCurrentBriefOnly: boolean;
}

const model = process.argv[2] ?? "gpt-5.6-luna";
const effort = model === "gpt-5.6-sol" ? "high" as const : "low" as const;
const root = await mkdtemp(join(tmpdir(), "stensibly-codex-root-probe-"));
const cwdA = join(root, "root-a");
const cwdB = join(root, "root-b");
await mkdir(cwdA);
await mkdir(cwdB);
await Bun.write(join(cwdA, ".keep"), "synthetic root A\n");
await Bun.write(join(cwdB, ".keep"), "synthetic root B\n");

let first: CodexAppServerClient | null = null;
let second: CodexAppServerClient | null = null;
const threadIds: string[] = [];

try {
  first = await CodexAppServerClient.connect();
  const account = asRecord(await first.request("account/read", { refreshToken: false }));
  if (asRecord(account.account).type !== "chatgpt") {
    throw new Error("Codex root probe requires subscription-backed ChatGPT authentication");
  }
  const harness = new CodexRootHarness(first);
  const missionA = mission("synthetic-a", "Reply with exactly ROOT-A-STARTED and do not use tools.");
  const missionB = mission("synthetic-b", "Reply with exactly ROOT-B-STARTED and do not use tools.");
  const profileA = profile(cwdA);
  const profileB = profile(cwdB);
  const [rootA, rootB] = await Promise.all([
    harness.start(missionA, profileA),
    harness.start(missionB, profileB),
  ]);
  threadIds.push(rootA.binding.runtime.threadId, rootB.binding.runtime.threadId);
  const hotA = await harness.continue(
    rootA.binding,
    { ...missionA, launchBrief: "Reply with exactly ROOT-A-HOT and do not use tools." },
    profile(cwdA, 20_000),
  );
  const peerBefore = JSON.stringify(await first.request("thread/goal/get", {
    threadId: rootB.binding.runtime.threadId,
  }));

  const durableBinding = JSON.parse(JSON.stringify(hotA.binding)) as CodexRootBindingV1;
  await first.close();
  first = null;
  second = await CodexAppServerClient.connect();
  const reconstructed = new CodexRootHarness(second);
  const resumedA = await reconstructed.continue(
    durableBinding,
    { ...missionA, launchBrief: "Reply with exactly ROOT-A-RESUMED and do not use tools." },
    profile(cwdA, 30_000),
  );
  const peerAfterResume = JSON.stringify(await second.request("thread/goal/get", {
    threadId: rootB.binding.runtime.threadId,
  }));
  const successorMission: CodexRootMissionV1 = {
    ...mission("synthetic-a-successor", "Reply with exactly ROOT-A-SUCCESSOR and do not use tools."),
    missionRef: missionA.missionRef,
    responsibilityGeneration: 2,
  };
  const successorA = await reconstructed.continue(resumedA.binding, successorMission, profileA);
  threadIds.push(successorA.binding.runtime.threadId);
  const peerAfterSuccessor = JSON.stringify(await second.request("thread/goal/get", {
    threadId: rootB.binding.runtime.threadId,
  }));

  const lifecycle = [rootA.observation, rootB.observation, hotA.observation, resumedA.observation, successorA.observation];
  const evidence: ProbeEvidence = {
    schemaVersion: "codex-root-harness-probe/1",
    auth: "chatgpt_subscription",
    roots: {
      started: 3,
      resumed: 1,
      replaced: 1,
      independentSessionTrees: lifecycle.every((entry) => entry.threadId === entry.sessionId),
    },
    lifecycle,
    controllerRestartRecovered: resumedA.observation.disposition === "resumed_after_controller_restart"
      && resumedA.binding.runtime.threadId === durableBinding.runtime.threadId,
    unaffectedPeer: peerBefore === peerAfterResume && peerBefore === peerAfterSuccessor,
    freshSuccessorUsedCurrentBriefOnly: successorA.observation.disposition === "fresh_successor_root"
      && successorA.binding.runtime.threadId !== resumedA.binding.runtime.threadId,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  for (const threadId of threadIds) {
    try {
      const connection = second ?? first;
      if (connection) await connection.request("thread/archive", { threadId });
    } catch {
      // Probe cleanup is best effort; lifecycle evidence has already failed or printed.
    }
  }
  await second?.close();
  await first?.close();
  await rm(root, { recursive: true, force: true });
}

function mission(name: string, launchBrief: string): CodexRootMissionV1 {
  const objective = `Complete bounded Codex root probe ${name}`;
  return {
    version: 1,
    missionRef: `stensibly:probe/${name}`,
    responsibilityGeneration: 1,
    revisionDigest: codexRootMissionRevision({ name, objective }),
    objective,
    launchBrief,
  };
}

function profile(cwd: string, goalTokenBudget = 1_000): CodexRootProfileV1 {
  const sandbox = "read-only" as const;
  const approvalPolicy = "never" as const;
  const profileVersion = codexRootProfileVersion({
    model,
    effort,
    sandbox,
    networkAccess: false,
    approvalPolicy,
    cwd,
    appServerVersion: "0.146.0",
  });
  return {
    version: 1,
    provenance: runnerProfileProvenanceV1(`codex-root:${model}`, profileVersion),
    model,
    effort,
    cwd,
    sandbox,
    networkAccess: false,
    approvalPolicy,
    appServerVersion: "0.146.0",
    goalTokenBudget,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex app-server returned an unexpected probe response");
  }
  return value as Record<string, unknown>;
}
