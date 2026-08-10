export type ProjectSetupStep =
  | "deployment"
  | "backend"
  | "account"
  | "workspace"
  | "project"
  | "oauth_discovery"
  | "mcp_connection"
  | "first_read"
  | "repository"
  | "proofwake";

export type ProjectSetupStepState = "missing" | "ready" | "degraded" | "deferred";
export type ProjectSetupOverallState =
  | "not_configured"
  | "partially_configured"
  | "ready"
  | "degraded";

export interface DashboardSetupStep {
  step: ProjectSetupStep;
  state: ProjectSetupStepState;
  required: boolean;
}

export interface DashboardRepositorySetupObservation {
  version: 1;
  id: string;
  project: string;
  repositoryFullName: string;
  defaultBranch: string;
  sourceKind: "operator_supplied" | "github_conversation_context";
  semanticFingerprint: string;
  observedAt: string;
  authorizesProviderEffect: false;
  containsSecrets: false;
}

export interface DashboardRepositoryContextRecovery {
  version: 1;
  state: "repository_context_required";
  nextAction: "provide_repository_context";
  requiredFields: readonly [
    "repositoryFullName",
    "defaultBranch",
    "runnerProfiles",
    "workProfile",
    "checks",
  ];
  authorizesProviderEffect: false;
  containsSecrets: false;
}

export interface DashboardRepositoryAttachmentRecovery {
  version: 1;
  state: "attachment_required";
  project: string;
  repository: Readonly<{
    fullName: string;
    defaultBranch: string;
  }>;
  requested: Readonly<{
    runnerProfiles: readonly string[];
    workProfile: "read_only" | "draft_pr";
    checks: readonly string[];
  }>;
  sourcePath: "STENSIBLY.md";
  nextAction: Readonly<{
    kind: "review_and_accept_project_attachment";
    requiresAdmin: true;
    acceptAuthorityWidening: true;
  }>;
  verification: Readonly<{
    repositoryMetadata: "get_repo";
    immutableFileRead: "fetch_file";
    immutableReadRef: "exact_commit_sha";
  }>;
  authorizesProviderEffect: false;
  containsSecrets: false;
}

export type DashboardRepositoryRecovery =
  | DashboardRepositoryContextRecovery
  | DashboardRepositoryAttachmentRecovery
  | null;

export interface DashboardProjectSetupStatus {
  version: 1;
  mode: "local" | "hosted_preview" | "production";
  state: ProjectSetupOverallState;
  observedAt: string;
  serviceOrigin: string;
  mcpEndpoint: string;
  lastVerifiedStep: ProjectSetupStep | null;
  nextStep: ProjectSetupStep | null;
  requiredReady: number;
  requiredTotal: number;
  degradedSteps: readonly ProjectSetupStep[];
  optionalAttentionSteps: readonly ProjectSetupStep[];
  steps: readonly DashboardSetupStep[];
  repositoryRecovery: DashboardRepositoryRecovery;
  repositorySetupObservation: DashboardRepositorySetupObservation | null;
  containsSecrets: false;
}

export function readProjectSetupStatus(
  payload: unknown,
  expectedProject: string,
): DashboardProjectSetupStatus;

export function setupStepLabel(step: ProjectSetupStep): string;
