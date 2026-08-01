import { parseGitHubIssueExternalId } from "./github-issue-context.js";
import {
  ensureGitHubIssueContextSchema,
  getCurrentSqliteGitHubIssueContext,
  listSqliteGitHubIssueContextHistory,
  type GitHubIssueContextRecord,
} from "./github-issue-context-sqlite.js";
import type { StensiblyStore } from "./store.js";

export interface GetGitHubProjectContextInput {
  project: string;
  externalId?: string;
  limit?: number;
  historyLimit?: number;
}

export interface GitHubIssueContextProjection {
  externalId: string;
  canonicalUrl: string;
  repositoryFullName: string;
  issueNumber: number;
  title: string;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | "reopened" | null;
  labels: string[];
  assignees: string[];
  milestone: { number: number; title: string } | null;
  relationships: Array<{
    kind: "parent" | "sub_issue" | "blocked_by" | "blocks" | "related";
    externalId: string;
    canonicalUrl: string;
  }>;
  provider: {
    sourceRevision: string;
    createdAt: string;
    updatedAt: string;
  };
  synchronization: {
    status: "synchronized" | "degraded";
    degradedReasonCode: string | null;
    observedAt: string;
    acceptedAt: string;
    acceptedBy: string;
    outcome: "initial" | "updated" | "stale" | "instruction_rebound" | "synchronization_updated";
  };
  instructions: {
    id: string;
    sourcePaths: string[];
  };
}

export interface GitHubIssueContextHistoryProjection {
  externalId: string;
  sourceRevision: string;
  providerUpdatedAt: string;
  synchronizationStatus: "synchronized" | "degraded";
  degradedReasonCode: string | null;
  observedAt: string;
  acceptedAt: string;
  outcome: "initial" | "updated" | "stale" | "instruction_rebound" | "synchronization_updated";
  isCurrent: boolean;
  instructionSetId: string;
}

export interface GitHubProjectContextProjection {
  version: 1;
  workspace: string;
  project: string;
  mode: "project" | "issue";
  requestedExternalId: string | null;
  issues: GitHubIssueContextProjection[];
  history: GitHubIssueContextHistoryProjection[];
  recovery: {
    canonicalSource: "github";
    stensiblyProjection: "last_known_accepted_context";
    incidentUrl: "https://github.com/teamleaderleo/stensibly/issues/490";
    directGitHubUrls: string[];
    guidance: Array<{
      code:
        | "use_normal_chat"
        | "select_github_and_stensibly"
        | "start_new_conversation_on_host_binding_failure"
        | "refresh_stensibly_actions_on_manifest_drift"
        | "reconnect_oauth_on_worker_auth_failure";
      instruction: string;
    }>;
  };
}

export interface GitHubProjectContextLedger {
  getGitHubProjectContext(
    input: GetGitHubProjectContextInput,
  ): Promise<GitHubProjectContextProjection>;
}

const recoveryGuidance: GitHubProjectContextProjection["recovery"]["guidance"] = [
  {
    code: "use_normal_chat",
    instruction:
      "Use a normal ChatGPT conversation; agent mode and company knowledge do not expose the write-capable app combination used for GitHub and Stensibly dogfood.",
  },
  {
    code: "select_github_and_stensibly",
    instruction:
      "Explicitly select both GitHub and Stensibly before asking to continue the issue or repository workflow.",
  },
  {
    code: "start_new_conversation_on_host_binding_failure",
    instruction:
      "If schemas appear but GitHub calls are unavailable or forbidden before any Stensibly request receipt, start a new conversation because the failure is in conversation-host tool binding.",
  },
  {
    code: "refresh_stensibly_actions_on_manifest_drift",
    instruction:
      "If Stensibly reports a stale action manifest, refresh or recreate the Stensibly app before retrying.",
  },
  {
    code: "reconnect_oauth_on_worker_auth_failure",
    instruction:
      "If a request reaches Stensibly and reports authentication failure, reconnect OAuth and retry the same bounded read.",
  },
];

export function githubProjectContextLedger(value: unknown): GitHubProjectContextLedger | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GitHubProjectContextLedger>;
  return typeof candidate.getGitHubProjectContext === "function"
    ? value as GitHubProjectContextLedger
    : null;
}

export function getSqliteGitHubProjectContext(
  store: StensiblyStore,
  input: GetGitHubProjectContextInput,
): GitHubProjectContextProjection {
  const project = boundedProject(input.project);
  const limit = boundedLimit(input.limit, "GitHub project context limit", 20, 100);
  const historyLimit = boundedLimit(
    input.historyLimit,
    "GitHub issue context history limit",
    10,
    50,
  );
  const requestedExternalId = input.externalId === undefined
    ? null
    : parseGitHubIssueExternalId(input.externalId).externalId;

  const records = requestedExternalId === null
    ? listCurrentRecords(store, project, limit)
    : currentRecord(store, project, requestedExternalId);
  const issues: GitHubIssueContextProjection[] = records.map(projectIssueContext);
  const history: GitHubIssueContextHistoryProjection[] = requestedExternalId === null
    ? []
    : listSqliteGitHubIssueContextHistory(store, {
      workspace: "default",
      project,
      externalId: requestedExternalId,
    }).slice(-historyLimit).map(projectHistory);

  return {
    version: 1,
    workspace: "default",
    project,
    mode: requestedExternalId === null ? "project" : "issue",
    requestedExternalId,
    issues,
    history,
    recovery: {
      canonicalSource: "github",
      stensiblyProjection: "last_known_accepted_context",
      incidentUrl: "https://github.com/teamleaderleo/stensibly/issues/490",
      directGitHubUrls: issues.map((issue) => issue.canonicalUrl),
      guidance: recoveryGuidance.map((entry) => ({ ...entry })),
    },
  };
}

function listCurrentRecords(
  store: StensiblyStore,
  project: string,
  limit: number,
): GitHubIssueContextRecord[] {
  ensureGitHubIssueContextSchema(store);
  const identities = store.db.query<
    { external_id: string },
    [string, string, number]
  >(`
    SELECT external_id
    FROM github_issue_contexts
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND is_current = 1
    ORDER BY external_id ASC
    LIMIT ?3
  `).all("default", project, limit);

  return identities.map(({ external_id }) => {
    const record = getCurrentSqliteGitHubIssueContext(store, {
      workspace: "default",
      project,
      externalId: external_id,
    });
    if (!record) {
      throw new Error(`Current GitHub issue context ${external_id} disappeared during projection`);
    }
    return record;
  });
}

function currentRecord(
  store: StensiblyStore,
  project: string,
  externalId: string,
): GitHubIssueContextRecord[] {
  const record = getCurrentSqliteGitHubIssueContext(store, {
    workspace: "default",
    project,
    externalId,
  });
  return record ? [record] : [];
}

function projectIssueContext(record: GitHubIssueContextRecord): GitHubIssueContextProjection {
  const snapshot = record.snapshot;
  return {
    externalId: record.externalId,
    canonicalUrl: snapshot.reference.canonicalUrl,
    repositoryFullName: snapshot.reference.repositoryFullName,
    issueNumber: snapshot.reference.number,
    title: snapshot.title,
    state: snapshot.state,
    stateReason: snapshot.stateReason,
    labels: [...snapshot.labels],
    assignees: [...snapshot.assignees],
    milestone: snapshot.milestone ? { ...snapshot.milestone } : null,
    relationships: snapshot.relationships.map((relationship) => ({
      kind: relationship.kind,
      externalId: relationship.target.externalId,
      canonicalUrl: relationship.target.canonicalUrl,
    })),
    provider: {
      sourceRevision: snapshot.sourceRevision,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    },
    synchronization: {
      status: record.syncStatus,
      degradedReasonCode: record.degradedReasonCode,
      observedAt: record.observedAt,
      acceptedAt: record.acceptedAt,
      acceptedBy: record.acceptedBy,
      outcome: record.outcome,
    },
    instructions: {
      id: record.instructionSet.id,
      sourcePaths: record.instructionSet.sources.map((source) => source.path),
    },
  };
}

function projectHistory(
  record: GitHubIssueContextRecord,
): GitHubIssueContextHistoryProjection {
  return {
    externalId: record.externalId,
    sourceRevision: record.snapshot.sourceRevision,
    providerUpdatedAt: record.snapshot.updatedAt,
    synchronizationStatus: record.syncStatus,
    degradedReasonCode: record.degradedReasonCode,
    observedAt: record.observedAt,
    acceptedAt: record.acceptedAt,
    outcome: record.outcome,
    isCurrent: record.isCurrent,
    instructionSetId: record.instructionSet.id,
  };
}

function boundedProject(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 80
    || !/^[a-z0-9][a-z0-9_-]*$/.test(value)
  ) {
    throw new RangeError("GitHub project context project is invalid");
  }
  return value;
}

function boundedLimit(
  value: number | undefined,
  label: string,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`);
  }
  return resolved;
}
