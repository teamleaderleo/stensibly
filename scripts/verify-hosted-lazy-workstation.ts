import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConvexWorkLedger,
  createConvexWorkLedgerFromEnv,
} from "../src/convex-ledger.js";
import { canonicalJsonString } from "../src/idempotency-request-fingerprint.js";
import type {
  ReserveRunnerAdapterCommandInput,
  RunnerAdapterCommandOutcomeV1,
  RunnerAdapterCommandReservationRecord,
  RunnerAdapterCommandSettlementRecord,
} from "../src/runner-adapter-command-contracts.js";

const PROJECT = "stensibly";
const PROFILE = "codex-default";
const SUPERVISOR = {
  id: "service:lazy-hosted-verifier",
  name: "Lazy Hosted Verifier",
  kind: "service" as const,
};
const RUNNER = {
  id: "agent:lazy-hosted-verifier",
  name: "Lazy Hosted Verifier Runner",
  kind: "agent" as const,
};

type VerificationLedger = Pick<ConvexWorkLedger,
  | "createItem"
  | "claimWork"
  | "completeWork"
  | "proposeContinuation"
  | "queueContinuationForSupervisor"
  | "claimRunnerWork"
  | "reserveLazyWorkstationCommand"
  | "settleRunnerAdapterCommand"
  | "transitionRun"
>;

export interface HostedLazyVerificationReceiptV1 {
  schema: "stensibly-hosted-lazy-verification/v1";
  revision: string;
  operationRevision: string;
  runRef: string;
  project: typeof PROJECT;
  sourceItemId: string;
  targetItemId: string;
  runId: string;
  itemClaimGeneration: number;
  runGeneration: number;
  leaseGeneration: number;
  reservationAcquisition: "reserved" | "replayed";
  settlementAcquisition: "settled" | "replayed";
  terminalClaimInvalidationReplay: "replayed";
  freshStaleClaim: "refused";
  targetTerminal: "succeeded";
  sourceTerminal: "done";
  containsPrivateContent: false;
  containsCredentials: false;
  authorizesWork: false;
  authorizesEffects: false;
  authorizesRedispatch: false;
}

export async function verifyHostedLazyWorkstation(input: {
  ledger: VerificationLedger;
  runRef: string;
  revision: string;
  operationRevision?: string;
}): Promise<HostedLazyVerificationReceiptV1> {
  const runRef = boundedRef(input.runRef, "run reference");
  const revision = exactRevision(input.revision);
  const operationRevision = exactRevision(input.operationRevision ?? revision);
  const prefix = `hosted-lazy-${runRef}`;
  const source = await input.ledger.createItem({
    project: PROJECT,
    kind: "task",
    title: `Hosted Lazy verification source ${runRef}`,
    priority: 1,
    actor: SUPERVISOR,
    idempotencyKey: `${prefix}:source`,
  });
  const target = await input.ledger.createItem({
    project: PROJECT,
    kind: "task",
    title: `Hosted Lazy verification target ${runRef}`,
    priority: 1,
    actor: SUPERVISOR,
    idempotencyKey: `${prefix}:target`,
  });
  const continuation = await input.ledger.proposeContinuation({
    sourceItemId: source.id,
    title: `Verify hosted Lazy reservation ${runRef}`,
    rationale: "Exercise the deployed exact reservation, replay, and refusal fences.",
    instruction: "Run the bounded hosted Lazy verification and retain a content-free receipt.",
    action: { kind: "dispatch_item", itemId: target.id, runnerProfile: PROFILE },
    actor: SUPERVISOR,
    approvalMode: "human",
    deliveryMode: "supervisor",
    idempotencyKey: `${prefix}:continuation`,
  });
  const queued = await input.ledger.queueContinuationForSupervisor({
    id: continuation.id,
    actor: SUPERVISOR,
    supervisor: SUPERVISOR,
    expectedGeneration: 1,
    runnerType: "lazy-commander",
    runnerProfile: PROFILE,
    runnerProfileVersion: null,
    leaseSeconds: 1800,
    maxAttempts: 1,
    idempotencyKey: `${prefix}:queue`,
    policyMode: "human",
  });
  const claimed = await input.ledger.claimRunnerWork({
    actor: RUNNER,
    runnerType: "lazy-commander",
    runnerProfile: PROFILE,
    runnerProfileVersion: null,
    project: PROJECT,
    runId: queued.run.id,
    leaseSeconds: 1800,
    idempotencyKey: `${prefix}:claim-run`,
    concurrency: { globalLimit: 100, projectLimit: 100 },
  });
  if (!claimed || !claimed.leaseExpiresAt) {
    throw new Error("Hosted Lazy verification could not claim its exact queued run");
  }

  const commandId = `${prefix}:command`;
  const commandFingerprint = fingerprint({ commandId, revision: operationRevision });
  const reservation = {
    project: PROJECT,
    itemId: target.id,
    runId: claimed.id,
    runGeneration: claimed.generation,
    leaseGeneration: claimed.leaseGeneration,
    actor: RUNNER,
    adapterId: "lazy-commander",
    profileId: PROFILE,
    profileVersion: null,
    requestFingerprint: fingerprint({
      revision: operationRevision,
      itemId: target.id,
      itemClaimGeneration: queued.item.claimGeneration,
      runId: claimed.id,
      runGeneration: claimed.generation,
      leaseGeneration: claimed.leaseGeneration,
    }),
    commandId,
    commandFingerprint,
    idempotencyKey: `${prefix}:reserve`,
  };
  const authority = {
    holderId: RUNNER.id,
    expiresAt: claimed.leaseExpiresAt,
  };
  const fresh = await input.ledger.reserveLazyWorkstationCommand({
    itemClaimGeneration: queued.item.claimGeneration,
    authority,
    reservation,
  });
  if (
    (fresh.outcome !== "reserved" && fresh.outcome !== "replayed")
    || (fresh.outcome === "reserved") !== fresh.dispatchAuthorized
  ) {
    throw new Error("Hosted Lazy verification reservation acquisition is inconsistent");
  }
  assertStoredCommand(fresh.command, reservation);
  if (fresh.outcome === "reserved" && fresh.settlement !== null) {
    throw new Error("Hosted Lazy verification fresh reservation already has a settlement");
  }
  const expectedOutcome = {
    version: 1 as const,
    kind: "bounded_episode_completed" as const,
    observationCount: 1,
    observationsSha256: fingerprint({
      revision: operationRevision,
      runRef,
      observations: ["ledger_verification_completed"],
    }),
    terminalObservationId: `${prefix}:verification-observation`,
    terminalObservationType: "ledger_verification_completed",
    latestCheckpointExternalId: null,
    latestCheckpointSha256: null,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
  const settlement = await input.ledger.settleRunnerAdapterCommand({
    commandId,
    commandFingerprint,
    outcome: expectedOutcome,
  });
  assertStoredSettlement(settlement.settlement, commandId, commandFingerprint, expectedOutcome);
  const terminal = await input.ledger.transitionRun({
    id: claimed.id,
    actor: RUNNER,
    command: "succeed",
    expectedGeneration: claimed.generation,
    expectedLeaseGeneration: claimed.leaseGeneration,
    outcome: "Hosted Lazy reservation verification completed.",
    executionActual: { durationMinutes: 0, messagesConsumed: 0, toolCalls: 0, filesChanged: 0 },
    idempotencyKey: `${prefix}:succeed`,
  });
  const replay = await input.ledger.reserveLazyWorkstationCommand({
    itemClaimGeneration: queued.item.claimGeneration,
    authority,
    reservation: {
      ...reservation,
      commandId: `${prefix}:replay-command`,
      commandFingerprint: fingerprint({ revision: operationRevision, runRef, replay: true }),
    },
  });
  if (replay.outcome !== "replayed" || replay.dispatchAuthorized) {
    throw new Error("Hosted Lazy verification did not preserve exact replay after claim invalidation");
  }
  assertStoredCommand(replay.command, reservation);
  if (!replay.settlement) {
    throw new Error("Hosted Lazy verification replay lost its exact settlement");
  }
  assertStoredSettlement(replay.settlement, commandId, commandFingerprint, expectedOutcome);
  let staleRefused = false;
  try {
    await input.ledger.reserveLazyWorkstationCommand({
      itemClaimGeneration: queued.item.claimGeneration,
      authority,
      reservation: {
        ...reservation,
        commandId: `${prefix}:stale-command`,
        commandFingerprint: fingerprint({ revision: operationRevision, runRef, stale: true }),
        idempotencyKey: `${prefix}:stale-reserve`,
      },
    });
  } catch (error) {
    staleRefused = error instanceof Error
      && error.message.includes("claim generation or authority changed");
  }
  if (!staleRefused) {
    throw new Error("Hosted Lazy verification accepted or ambiguously refused a fresh stale claim");
  }

  const sourceClaim = await input.ledger.claimWork({
    id: source.id,
    actor: SUPERVISOR,
    leaseSeconds: 1800,
    idempotencyKey: `${prefix}:claim-source`,
  });
  const sourceDone = await input.ledger.completeWork({
    id: source.id,
    actor: SUPERVISOR,
    expectedClaimGeneration: sourceClaim.claimGeneration,
    summary: "Hosted Lazy verification completed.",
    idempotencyKey: `${prefix}:complete-source`,
  });
  if (terminal.status !== "succeeded" || sourceDone.status !== "done") {
    throw new Error("Hosted Lazy verification did not leave its work items terminal");
  }
  return Object.freeze({
    schema: "stensibly-hosted-lazy-verification/v1",
    revision,
    operationRevision,
    runRef,
    project: PROJECT,
    sourceItemId: source.id,
    targetItemId: target.id,
    runId: claimed.id,
    itemClaimGeneration: queued.item.claimGeneration,
    runGeneration: claimed.generation,
    leaseGeneration: claimed.leaseGeneration,
    reservationAcquisition: fresh.outcome,
    settlementAcquisition: settlement.outcome,
    terminalClaimInvalidationReplay: "replayed",
    freshStaleClaim: "refused",
    targetTerminal: "succeeded",
    sourceTerminal: "done",
    containsPrivateContent: false,
    containsCredentials: false,
    authorizesWork: false,
    authorizesEffects: false,
    authorizesRedispatch: false,
  });
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function assertStoredCommand(
  actual: RunnerAdapterCommandReservationRecord,
  expected: ReserveRunnerAdapterCommandInput,
): void {
  const { reservedAt: _reservedAt, ...stored } = actual;
  if (canonicalJsonString(stored) !== canonicalJsonString(expected)) {
    throw new Error("Hosted Lazy verification replay returned a different stored command");
  }
}

function assertStoredSettlement(
  actual: RunnerAdapterCommandSettlementRecord,
  commandId: string,
  commandFingerprint: string,
  outcome: RunnerAdapterCommandOutcomeV1,
): void {
  if (
    actual.commandId !== commandId
    || actual.commandFingerprint !== commandFingerprint
    || canonicalJsonString(actual.outcome) !== canonicalJsonString(outcome)
  ) {
    throw new Error("Hosted Lazy verification replay returned a different settlement");
  }
}

function boundedRef(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function exactRevision(value: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error("revision is invalid");
  return value;
}

function outputPath(argv: string[], environment: NodeJS.ProcessEnv): string {
  if (argv.length !== 2 || argv[0] !== "--output") throw new Error("usage: --output ABSOLUTE_PATH");
  const root = resolve(environment.RUNNER_TEMP ?? "");
  const output = resolve(argv[1]!);
  if (!environment.RUNNER_TEMP || (output !== root && !output.startsWith(`${root}${sep}`))) {
    throw new Error("output must be inside RUNNER_TEMP");
  }
  return output;
}

async function main(): Promise<void> {
  const output = outputPath(process.argv.slice(2), process.env);
  const ledger = createConvexWorkLedgerFromEnv(process.env);
  const receipt = await verifyHostedLazyWorkstation({
    ledger,
    runRef: boundedRef(
      process.env.HOSTED_LAZY_RUN_REF ?? process.env.GITHUB_RUN_ID ?? "",
      "hosted Lazy run reference",
    ),
    revision: process.env.GITHUB_SHA ?? "",
    operationRevision: process.env.HOSTED_LAZY_OPERATION_REVISION,
  });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    schema: receipt.schema,
    revision: receipt.revision,
    operationRevision: receipt.operationRevision,
    reservationAcquisition: receipt.reservationAcquisition,
    settlementAcquisition: receipt.settlementAcquisition,
    terminalClaimInvalidationReplay: receipt.terminalClaimInvalidationReplay,
    freshStaleClaim: receipt.freshStaleClaim,
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Hosted Lazy verification failed");
    process.exitCode = 1;
  });
}
