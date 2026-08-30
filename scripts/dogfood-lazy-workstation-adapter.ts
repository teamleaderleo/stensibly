import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { LazyOwnerProfileSubprocessClientV1 } from "../src/lazy-owner-profile-subprocess.ts";
import {
  LazyWorkstationAdapterV1,
  type LazyOwnerProfileClientV1,
  type PrepareLazyWorkstationCommandInputV1,
} from "../src/lazy-workstation-adapter.ts";
import { SqliteLazyWorkstationCommandLedgerV1 } from "../src/lazy-workstation-adapter-sqlite.ts";
import { RunnerAdapterCommandConflictError } from "../src/runner-adapter-command-contracts.ts";
import { claimRunnerWork } from "../src/runner-queue.ts";
import { sha256Hex } from "../src/sha256.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:lazy-dogfood-supervisor",
  name: "Lazy dogfood supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:lazy-dogfood-jr",
  name: "Lazy dogfood Jr",
  kind: "agent" as const,
};
const profileId = "stensibly-workstation-snapshot";

class CountingClient implements LazyOwnerProfileClientV1 {
  checkCalls = 0;
  observationCalls = 0;
  readonly inner: LazyOwnerProfileClientV1;

  constructor(inner: LazyOwnerProfileClientV1) {
    this.inner = inner;
  }

  async check(input: Parameters<LazyOwnerProfileClientV1["check"]>[0]) {
    this.checkCalls += 1;
    return await this.inner.check(input);
  }

  async observe(input: Parameters<LazyOwnerProfileClientV1["observe"]>[0]) {
    this.observationCalls += 1;
    return await this.inner.observe(input);
  }
}

class CrashAfterObservationClient implements LazyOwnerProfileClientV1 {
  observationCalls = 0;
  readonly inner: LazyOwnerProfileClientV1;

  constructor(inner: LazyOwnerProfileClientV1) {
    this.inner = inner;
  }

  async check(input: Parameters<LazyOwnerProfileClientV1["check"]>[0]) {
    return await this.inner.check(input);
  }

  async observe(input: Parameters<LazyOwnerProfileClientV1["observe"]>[0]) {
    this.observationCalls += 1;
    await this.inner.observe(input);
    throw new Error("simulated host crash after owner observation receipt");
  }
}

async function main(): Promise<void> {
  const args = options(process.argv.slice(2));
  const repositoryRoot = resolve(args["repository-root"]);
  const database = resolve(args.database);
  const outputRoot = resolve(args["observation-output-root"]);
  const reportPath = resolve(args.report);
  const lazyScript = resolve(args["lazy-owner-profiles-script"]);
  const profilePath = resolve(repositoryRoot, ".lazy/observation-profiles.json");
  requireBeneath(database, repositoryRoot, "database");
  requireBeneath(outputRoot, repositoryRoot, "observation output root");
  for (const path of [database, outputRoot, reportPath]) {
    if (existsSync(path)) throw new Error(`Dogfood output already exists: ${path}`);
  }
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });

  const profileSha256 = sha256Hex(readFileSync(profilePath, "utf8"));
  const profileVersion = `sha256:${profileSha256}`;
  const startedAt = new Date();
  const clock = { now: new Date(startedAt) };
  const store = new StensiblyStore(database);
  try {
    const item = store.createItem({
      project: "lazy_workstation_dogfood",
      kind: "task",
      title: "Dogfood exact Stensibly-to-Lazy owner observation",
      nextAction: "Bind and run one checked content-free owner observation.",
      priority: 95,
      actor: supervisor,
    }, "lazy-workstation-dogfood-item-v1");
    const dispatched = dispatchNextWork(store, {
      actor: supervisor,
      runnerType: "lazy-commander",
      runnerProfile: profileId,
      runnerProfileVersion: profileVersion,
      itemId: item.id,
      leaseSeconds: 3_600,
      idempotencyKey: "lazy-workstation-dogfood-dispatch-v1",
    }, startedAt);
    if (!dispatched) throw new Error("Dogfood item did not dispatch");
    const run = claimRunnerWork(store, {
      actor: runner,
      runnerType: "lazy-commander",
      runnerProfile: profileId,
      runnerProfileVersion: profileVersion,
      project: item.project,
      runId: dispatched.run.id,
      leaseSeconds: 3_600,
      idempotencyKey: "lazy-workstation-dogfood-claim-v1",
    }, startedAt);
    if (!run || !run.leaseExpiresAt) throw new Error("Dogfood run did not acquire authority");
    const claimedItem = store.getItem(item.id);
    const subprocess = new LazyOwnerProfileSubprocessClientV1({
      script: lazyScript,
      profiles: profilePath,
      outputRoot,
    });
    const counted = new CountingClient(subprocess);
    const ledger = new SqliteLazyWorkstationCommandLedgerV1(store, () => clock.now);
    const adapter = new LazyWorkstationAdapterV1({ ledger, client: counted, actor: runner });
    const primaryInput = commandInput({
      database,
      commandId: "lazy-dogfood-primary-v1",
      idempotencyKey: "lazy-dogfood-primary-reservation-v1",
      profileVersion,
      item: claimedItem,
      run,
    });
    const primaryPrepared = await adapter.prepare(primaryInput);
    const executed = await adapter.dispatch(primaryPrepared);

    clock.now = new Date(Date.parse(run.leaseExpiresAt) + 1);
    const replay = await adapter.dispatch(primaryPrepared);
    if (replay.disposition !== "settled_replay" || counted.observationCalls !== 1) {
      throw new Error("Settled replay performed another owner observation");
    }

    let changedRefusal = false;
    try {
      await adapter.dispatch({
        ...primaryPrepared,
        profile: {
          ...primaryPrepared.profile,
          parameters: { ...primaryPrepared.profile.parameters, scenario: "changed" },
        },
      });
    } catch (error) {
      changedRefusal = error instanceof RunnerAdapterCommandConflictError;
    }
    if (!changedRefusal || counted.observationCalls !== 1) {
      throw new Error("Changed stable input was not refused without redispatch");
    }

    clock.now = new Date(startedAt);
    const staleInput = commandInput({
      database,
      commandId: "lazy-dogfood-stale-v1",
      idempotencyKey: "lazy-dogfood-stale-reservation-v1",
      profileVersion,
      item: { ...claimedItem, claimGeneration: claimedItem.claimGeneration + 1 },
      run,
    });
    const stalePrepared = await adapter.prepare(staleInput);
    let staleRefusal = false;
    try {
      await adapter.dispatch(stalePrepared);
    } catch (error) {
      staleRefusal = error instanceof RunnerAdapterCommandConflictError;
    }
    if (!staleRefusal || counted.observationCalls !== 1) {
      throw new Error("Stale claim generation was not refused without observation");
    }

    const expiredInput = commandInput({
      database,
      commandId: "lazy-dogfood-expired-v1",
      idempotencyKey: "lazy-dogfood-expired-reservation-v1",
      profileVersion,
      item: claimedItem,
      run,
    });
    const expiredPrepared = await adapter.prepare(expiredInput);
    clock.now = new Date(Date.parse(run.leaseExpiresAt) + 1);
    let expiredRefusal = false;
    try {
      await adapter.dispatch(expiredPrepared);
    } catch (error) {
      expiredRefusal = error instanceof RunnerAdapterCommandConflictError;
    }
    if (!expiredRefusal || counted.observationCalls !== 1) {
      throw new Error("Expired authority was not refused without observation");
    }

    clock.now = new Date(startedAt);
    const crashClient = new CrashAfterObservationClient(subprocess);
    const crashAdapter = new LazyWorkstationAdapterV1({ ledger, client: crashClient, actor: runner });
    const ambiguousInput = commandInput({
      database,
      commandId: "lazy-dogfood-ambiguous-v1",
      idempotencyKey: "lazy-dogfood-ambiguous-reservation-v1",
      profileVersion,
      item: claimedItem,
      run,
    });
    const ambiguousPrepared = await crashAdapter.prepare(ambiguousInput);
    let crashedAfterObservation = false;
    try {
      await crashAdapter.dispatch(ambiguousPrepared);
    } catch (error) {
      crashedAfterObservation = error instanceof Error
        && error.message === "simulated host crash after owner observation receipt";
    }
    if (!crashedAfterObservation || crashClient.observationCalls !== 1) {
      throw new Error("Ambiguous dogfood did not reach the intended crash fence");
    }
    const ambiguousReplay = await crashAdapter.dispatch(ambiguousPrepared);
    if (
      ambiguousReplay.disposition !== "ambiguous_reserved"
      || ambiguousReplay.authorizesRedispatch !== false
      || crashClient.observationCalls !== 1
    ) {
      throw new Error("Ambiguous retry redispatched or granted authority");
    }

    const report = {
      schema: "stensibly-lazy-workstation-dogfood/v1",
      recordedAt: new Date().toISOString(),
      repositoryHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], {
        cwd: repositoryRoot,
      }).stdout.toString().trim(),
      profileSha256,
      sourceSha256: executed.sourceSha256,
      project: item.project,
      itemId: item.id,
      itemClaimGeneration: claimedItem.claimGeneration,
      runId: run.id,
      runGeneration: run.generation,
      leaseGeneration: run.leaseGeneration,
      primary: executed,
      exactReplay: replay,
      refusals: {
        changed: changedRefusal,
        staleClaimGeneration: staleRefusal,
        expiredAuthority: expiredRefusal,
        ambiguousReserved: ambiguousReplay,
      },
      counts: {
        primaryProfileChecks: counted.checkCalls,
        primaryOwnerObservations: counted.observationCalls,
        ambiguousOwnerObservations: crashClient.observationCalls,
        durableCommandReservations: store.db.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM runner_adapter_commands
        `).get()?.count ?? 0,
        durableSettlements: store.db.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count
          FROM runner_adapter_commands WHERE settlement_json IS NOT NULL
        `).get()?.count ?? 0,
      },
      rawContentEmitted: false,
      containsPrivateContent: false,
      containsCredentials: false,
      authorizesWork: false,
      authorizesEffects: false,
      authorizesRedispatch: false,
    };
    writePrivateJson(reportPath, report);
    console.log(JSON.stringify({
      ok: true,
      report: reportPath,
      itemId: item.id,
      runId: run.id,
      primaryDisposition: executed.disposition,
      replayDisposition: replay.disposition,
      ambiguousDisposition: ambiguousReplay.disposition,
      primaryOwnerObservations: counted.observationCalls,
      ambiguousOwnerObservations: crashClient.observationCalls,
      rawContentEmitted: false,
    }, null, 2));
  } finally {
    store.close();
  }
}

function commandInput(input: {
  database: string;
  commandId: string;
  idempotencyKey: string;
  profileVersion: string;
  item: { id: string; project: string; claimGeneration: number };
  run: {
    id: string;
    generation: number;
    leaseGeneration: number;
    leaseOwnerId: string | null;
    leaseExpiresAt: string | null;
  };
}): PrepareLazyWorkstationCommandInputV1 {
  if (!input.run.leaseOwnerId || !input.run.leaseExpiresAt) {
    throw new Error("Dogfood run lacks exact authority");
  }
  const profile = {
    profileId,
    profileVersion: input.profileVersion,
    parameters: {
      database: input.database,
      project: input.item.project,
      "item-id": input.item.id,
      "claim-generation": String(input.item.claimGeneration),
      "run-id": input.run.id,
      "run-generation": String(input.run.generation),
      "lease-generation": String(input.run.leaseGeneration),
      "authority-holder": input.run.leaseOwnerId,
      "authority-expires-at": input.run.leaseExpiresAt,
      "command-id": input.commandId,
      "profile-id": profileId,
      "profile-version": input.profileVersion,
    },
  };
  return {
    version: 1,
    project: input.item.project,
    itemId: input.item.id,
    itemClaimGeneration: input.item.claimGeneration,
    runId: input.run.id,
    runGeneration: input.run.generation,
    leaseGeneration: input.run.leaseGeneration,
    authority: {
      holderId: input.run.leaseOwnerId,
      expiresAt: input.run.leaseExpiresAt,
    },
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    profile,
  };
}

function options(values: string[]): Record<string, string> {
  const required = new Set([
    "repository-root",
    "database",
    "observation-output-root",
    "report",
    "lazy-owner-profiles-script",
  ]);
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error("Dogfood options must be --name value pairs");
    const name = flag.slice(2);
    if (!required.has(name) || result[name]) throw new Error(`Unknown or duplicate option ${flag}`);
    result[name] = value;
  }
  for (const name of required) {
    if (!result[name]) throw new Error(`Missing --${name}`);
  }
  return result;
}

function requireBeneath(path: string, root: string, label: string): void {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) throw new Error(`Dogfood ${label} must stay inside the worktree`);
}

function writePrivateJson(path: string, value: unknown): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

await main();
