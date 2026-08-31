import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ANTIGRAVITY_RECEIPT_SCHEMA_VERSION,
  type AntigravityAcceptedOutcome,
  type AntigravityVerificationOutcome,
} from "./antigravity-gemini-worker-contract";
import type { AntigravityWorkerReceipt } from "./antigravity-gemini-worker";

export interface AntigravitySettlementOptions {
  readonly receipt: string;
  readonly output: string;
  readonly usageSampleId: string;
  readonly acceptedOutcome: Exclude<AntigravityAcceptedOutcome, "unknown">;
  readonly verificationOutcome: Exclude<AntigravityVerificationOutcome, "unknown">;
  readonly operatorInterventionMinutes: number;
  readonly cleanupRework: "none" | "required";
  readonly subscriptionMonthlyDollars?: number;
  readonly collectedAt?: string;
}

export interface AgentEconomicsEnvelope {
  readonly schema: "agent-task-settlement-report/v1";
  readonly source: "big-red" | "macbook-air";
  readonly collected_at: string;
  readonly samples: readonly [{
    readonly receipt_sha256: string;
    readonly usage_sample_id: string;
    readonly observed_at: string;
    readonly provider: string;
    readonly harness: string;
    readonly five_hour_quota_delta_percent: number | null;
    readonly weekly_quota_delta_percent: number | null;
    readonly five_hour_resets_at: string | null;
    readonly weekly_resets_at: string | null;
    readonly accepted_outcome: Exclude<AntigravityAcceptedOutcome, "unknown">;
    readonly verification_outcome: Exclude<AntigravityVerificationOutcome, "unknown">;
    readonly wall_time_ms: number;
    readonly retries: number;
    readonly operator_intervention_minutes: number;
    readonly cleanup_rework: "none" | "required";
    readonly subscription_monthly_dollars: number | null;
  }];
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function nonnegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be nonnegative`);
  return value;
}

function quotaReset(
  receipt: AntigravityWorkerReceipt,
  windowClass: "five_hour" | "weekly",
): string | null {
  return receipt.quota.after.observations.find(item => item.windowClass === windowClass)?.resetsAt ?? null;
}

function nodeSource(value: string): "big-red" | "macbook-air" {
  if (value === "big-red" || value === "macbook-air") return value;
  throw new Error("receipt node is not admitted by the Scrapbook telemetry contract");
}

export async function projectAntigravityEconomics(
  options: AntigravitySettlementOptions,
): Promise<AgentEconomicsEnvelope> {
  nonnegativeFinite(options.operatorInterventionMinutes, "operatorInterventionMinutes");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@#+=\-]{0,127}$/.test(options.usageSampleId))
    throw new Error("usageSampleId must match the Scrapbook telemetry identity contract");
  if (options.subscriptionMonthlyDollars !== undefined && options.subscriptionMonthlyDollars <= 0)
    throw new Error("subscriptionMonthlyDollars must be positive when supplied");
  if (options.acceptedOutcome === "accepted" && options.verificationOutcome !== "passed")
    throw new Error("accepted outcomes require passed external verification");

  const bytes = await readFile(resolve(options.receipt));
  const receipt = JSON.parse(bytes.toString("utf8")) as AntigravityWorkerReceipt;
  if (receipt.schemaVersion !== ANTIGRAVITY_RECEIPT_SCHEMA_VERSION)
    throw new Error("unsupported Antigravity receipt schema");
  if (!receipt.success) throw new Error("failed worker receipts cannot be settled as task outcomes");
  const source = nodeSource(receipt.node.id);
  const collectedAt = options.collectedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(collectedAt))) throw new Error("collectedAt must be an ISO timestamp");

  return {
    schema: "agent-task-settlement-report/v1",
    source,
    collected_at: collectedAt,
    samples: [{
      receipt_sha256: sha256(bytes),
      usage_sample_id: options.usageSampleId,
      observed_at: receipt.quota.after.observedAt,
      provider: receipt.harness.provider,
      harness: receipt.harness.name,
      five_hour_quota_delta_percent: receipt.economics.fiveHourQuotaDeltaPercent,
      weekly_quota_delta_percent: receipt.economics.weeklyQuotaDeltaPercent,
      five_hour_resets_at: quotaReset(receipt, "five_hour"),
      weekly_resets_at: quotaReset(receipt, "weekly"),
      accepted_outcome: options.acceptedOutcome,
      verification_outcome: options.verificationOutcome,
      wall_time_ms: receipt.child.wallTimeMs,
      retries: receipt.economics.retries,
      operator_intervention_minutes: options.operatorInterventionMinutes,
      cleanup_rework: options.cleanupRework,
      subscription_monthly_dollars: options.subscriptionMonthlyDollars ?? null,
    }],
  };
}

async function publish(path: string, envelope: AgentEconomicsEnvelope): Promise<void> {
  const handle = await open(resolve(path), "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

function usage(): string {
  return [
    "Usage: bun scripts/antigravity-gemini-accounting.ts",
    "  --receipt PATH --output PATH --usage-sample-id ID",
    "  --accepted-outcome accepted|rejected|partial",
    "  --verification-outcome passed|failed|not_run",
    "  --operator-intervention-minutes NUMBER",
    "  --cleanup-rework none|required",
    "  [--subscription-monthly-dollars NUMBER]",
  ].join("\n");
}

function parseCli(argv: readonly string[]): AntigravitySettlementOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (key === "--help") throw new Error(usage());
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(usage());
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, value);
  }
  const required = [
    "--receipt", "--output", "--usage-sample-id", "--accepted-outcome", "--verification-outcome",
    "--operator-intervention-minutes", "--cleanup-rework",
  ];
  for (const key of required) if (!values.has(key)) throw new Error(`missing ${key}\n${usage()}`);
  const acceptedOutcome = values.get("--accepted-outcome");
  if (!acceptedOutcome || !["accepted", "rejected", "partial"].includes(acceptedOutcome))
    throw new Error("invalid --accepted-outcome");
  const verificationOutcome = values.get("--verification-outcome");
  if (!verificationOutcome || !["passed", "failed", "not_run"].includes(verificationOutcome))
    throw new Error("invalid --verification-outcome");
  const cleanupRework = values.get("--cleanup-rework");
  if (cleanupRework !== "none" && cleanupRework !== "required")
    throw new Error("invalid --cleanup-rework");
  const number = (key: string): number => {
    const result = Number(values.get(key));
    if (!Number.isFinite(result)) throw new Error(`${key} must be a number`);
    return result;
  };
  return {
    receipt: values.get("--receipt")!,
    output: values.get("--output")!,
    usageSampleId: values.get("--usage-sample-id")!,
    acceptedOutcome: acceptedOutcome as AntigravitySettlementOptions["acceptedOutcome"],
    verificationOutcome: verificationOutcome as AntigravitySettlementOptions["verificationOutcome"],
    operatorInterventionMinutes: number("--operator-intervention-minutes"),
    cleanupRework,
    ...(values.has("--subscription-monthly-dollars")
      ? { subscriptionMonthlyDollars: number("--subscription-monthly-dollars") }
      : {}),
  };
}

export async function runAntigravityAccountingCli(argv: readonly string[]): Promise<number> {
  try {
    const options = parseCli(argv);
    const envelope = await projectAntigravityEconomics(options);
    await publish(options.output, envelope);
    console.log(JSON.stringify({ output: resolve(options.output), receipt_sha256: envelope.samples[0].receipt_sha256 }));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === usage()) {
      console.log(message);
      return 0;
    }
    console.error(message);
    return 2;
  }
}

if (import.meta.main) process.exit(await runAntigravityAccountingCli(process.argv.slice(2)));
