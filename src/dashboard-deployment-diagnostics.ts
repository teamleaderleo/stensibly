import { dashboardAssets } from "./dashboard-assets.ts";

export const DASHBOARD_DIAGNOSTICS_FORMAT = "stensibly.dashboard-deployment-diagnostics";

export type DashboardDiagnosticsMode = "candidate" | "deploy";
export type DashboardDiagnosticsCompleteness = "full" | "fallback";
export type DashboardPhaseOutcome = "passed" | "failed" | "cancelled" | "not_run";
export type DashboardProductionState =
  | "unchanged"
  | "unchanged_staged_only"
  | "changed_unverified"
  | "changed_verified";

export interface DashboardDeploymentDiagnostics {
  format: typeof DASHBOARD_DIAGNOSTICS_FORMAT;
  schemaVersion: 1;
  generatedAt: string;
  mode: DashboardDiagnosticsMode;
  completeness: DashboardDiagnosticsCompleteness;
  run: {
    repository: string | null;
    runId: string | null;
    runAttempt: string | null;
    commit: string | null;
    url: string | null;
  };
  deployment: {
    productionDomain: string | null;
    stagedDeployment: string | null;
    productionState: DashboardProductionState;
  };
  phases: {
    candidateValidation: DashboardPhaseOutcome;
    productionSecrets: DashboardPhaseOutcome;
    vercelProjectValidation: DashboardPhaseOutcome;
    pullProjectSettings: DashboardPhaseOutcome;
    linkedProjectValidation: DashboardPhaseOutcome;
    productionBuild: DashboardPhaseOutcome;
    buildOutputValidation: DashboardPhaseOutcome;
    stagedDeployment: DashboardPhaseOutcome;
    stagedVerification: DashboardPhaseOutcome;
    promotion: DashboardPhaseOutcome;
    productionVerification: DashboardPhaseOutcome;
  };
  failurePhase: string | null;
  verifier: {
    assetContract: "src/dashboard-assets.ts";
    assetCount: number | null;
    productionVerifier: "src/verify-dashboard.ts";
  };
}

interface DiagnosticsWriteOptions {
  command: "write";
  mode: DashboardDiagnosticsMode;
  output: string;
}

interface SafeVercelOriginOptions {
  command: "safe-vercel-origin";
  value: string;
}

type DiagnosticsOptions = DiagnosticsWriteOptions | SafeVercelOriginOptions;
type Environment = Record<string, string | undefined>;

const phaseEnvironment = [
  ["productionSecrets", "SECRETS_OUTCOME"],
  ["vercelProjectValidation", "PROJECT_OUTCOME"],
  ["pullProjectSettings", "PULL_SETTINGS_OUTCOME"],
  ["linkedProjectValidation", "LINKED_PROJECT_OUTCOME"],
  ["productionBuild", "BUILD_OUTCOME"],
  ["buildOutputValidation", "BUILD_OUTPUT_OUTCOME"],
  ["stagedDeployment", "STAGE_OUTCOME"],
  ["stagedVerification", "STAGED_VERIFY_OUTCOME"],
  ["promotion", "PROMOTE_OUTCOME"],
  ["productionVerification", "PRODUCTION_VERIFY_OUTCOME"],
] as const;

export function buildDashboardDeploymentDiagnostics(
  mode: DashboardDiagnosticsMode,
  environment: Environment,
  generatedAt = new Date(),
): DashboardDeploymentDiagnostics {
  const deployOutcomes = Object.fromEntries(
    phaseEnvironment.map(([phase, name]) => [phase, readOutcome(environment[name])]),
  ) as Record<(typeof phaseEnvironment)[number][0], DashboardPhaseOutcome>;

  const phases: DashboardDeploymentDiagnostics["phases"] = {
    candidateValidation: mode === "candidate" ? "failed" : "passed",
    productionSecrets: mode === "deploy" ? deployOutcomes.productionSecrets : "not_run",
    vercelProjectValidation: mode === "deploy" ? deployOutcomes.vercelProjectValidation : "not_run",
    pullProjectSettings: mode === "deploy" ? deployOutcomes.pullProjectSettings : "not_run",
    linkedProjectValidation: mode === "deploy" ? deployOutcomes.linkedProjectValidation : "not_run",
    productionBuild: mode === "deploy" ? deployOutcomes.productionBuild : "not_run",
    buildOutputValidation: mode === "deploy" ? deployOutcomes.buildOutputValidation : "not_run",
    stagedDeployment: mode === "deploy" ? deployOutcomes.stagedDeployment : "not_run",
    stagedVerification: mode === "deploy" ? deployOutcomes.stagedVerification : "not_run",
    promotion: mode === "deploy" ? deployOutcomes.promotion : "not_run",
    productionVerification: mode === "deploy" ? deployOutcomes.productionVerification : "not_run",
  };

  const repository = safeRepository(environment.GITHUB_REPOSITORY);
  const runId = safeDigits(environment.GITHUB_RUN_ID);
  const runAttempt = safeDigits(environment.GITHUB_RUN_ATTEMPT);
  const productionState = classifyProductionState(mode, phases);

  return {
    format: DASHBOARD_DIAGNOSTICS_FORMAT,
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    mode,
    completeness: "full",
    run: {
      repository,
      runId,
      runAttempt,
      commit: safeCommit(environment.GITHUB_SHA),
      url: repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : null,
    },
    deployment: {
      productionDomain: safeHttpsOrigin(environment.DASHBOARD_URL),
      stagedDeployment: safeVercelOrigin(environment.DEPLOYMENT_URL),
      productionState,
    },
    phases,
    failurePhase: firstFailure(phases),
    verifier: {
      assetContract: "src/dashboard-assets.ts",
      assetCount: dashboardAssets.length,
      productionVerifier: "src/verify-dashboard.ts",
    },
  };
}

export function serializeDashboardDeploymentDiagnostics(
  diagnostics: DashboardDeploymentDiagnostics,
): string {
  return `${JSON.stringify(diagnostics, null, 2)}\n`;
}

function classifyProductionState(
  mode: DashboardDiagnosticsMode,
  phases: DashboardDeploymentDiagnostics["phases"],
): DashboardProductionState {
  if (mode === "candidate") return "unchanged";
  if (phases.promotion === "passed") {
    return phases.productionVerification === "passed" ? "changed_verified" : "changed_unverified";
  }
  if (phases.stagedDeployment === "passed") return "unchanged_staged_only";
  return "unchanged";
}

function firstFailure(phases: DashboardDeploymentDiagnostics["phases"]): string | null {
  for (const [phase, outcome] of Object.entries(phases)) {
    if (outcome === "failed") return phase;
  }
  return null;
}

function readOutcome(value: string | undefined): DashboardPhaseOutcome {
  switch (value?.trim()) {
    case "success":
      return "passed";
    case "failure":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "":
    case undefined:
      return "not_run";
    default:
      return "not_run";
  }
}

function safeRepository(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) ? normalized : null;
}

function safeDigits(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^\d{1,24}$/.test(normalized) ? normalized : null;
}

function safeCommit(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{40,64}$/.test(normalized) ? normalized : null;
}

function safeHttpsOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
      || parsed.pathname !== "/"
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function safeVercelOrigin(value: string | undefined): string | null {
  const origin = safeHttpsOrigin(value);
  if (!origin) return null;
  const parsed = new URL(origin);
  return parsed.hostname.endsWith(".vercel.app") ? origin : null;
}

function parseArgs(argv: string[]): DiagnosticsOptions {
  if (argv[0] === "--safe-vercel-origin") {
    if (argv.length !== 2 || !argv[1]?.trim()) {
      throw new Error("--safe-vercel-origin requires one URL");
    }
    return { command: "safe-vercel-origin", value: argv[1] };
  }

  let mode: DashboardDiagnosticsMode | undefined;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mode") {
      const candidate = argv[++index];
      if (candidate !== "candidate" && candidate !== "deploy") {
        throw new Error("--mode must be candidate or deploy");
      }
      mode = candidate;
    } else if (value === "--output") {
      output = argv[++index];
      if (!output?.trim()) throw new Error("--output requires a path");
    } else {
      throw new Error("unknown diagnostics option");
    }
  }
  if (!mode) throw new Error("--mode is required");
  if (!output) throw new Error("--output is required");
  return { command: "write", mode, output };
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.command === "safe-vercel-origin") {
    const origin = safeVercelOrigin(options.value);
    if (!origin) {
      throw new Error("staged deployment URL must be an origin-only .vercel.app URL");
    }
    console.log(origin);
    return;
  }

  const diagnostics = buildDashboardDeploymentDiagnostics(options.mode, process.env);
  await Bun.write(options.output, serializeDashboardDeploymentDiagnostics(diagnostics));
  console.log("sanitised dashboard deployment diagnostics written");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "dashboard diagnostics failed");
    process.exitCode = 1;
  });
}
