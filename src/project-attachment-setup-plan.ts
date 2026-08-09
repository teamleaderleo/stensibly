import { normalizeGitHubRepository } from "./github-provider-validation.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";

export const repositorySetupWorkProfiles = ["read_only", "draft_pr"] as const;
export type RepositorySetupWorkProfile = typeof repositorySetupWorkProfiles[number];

export interface ProjectAttachmentSetupContext {
  repositoryFullName: string;
  defaultBranch: string;
  runnerProfiles: readonly string[];
  workProfile: RepositorySetupWorkProfile;
  checks: readonly string[];
}

export interface ProjectAttachmentSetupContextRequest {
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
  authorityNotice: string;
  authorizesProviderEffect: false;
  containsSecrets: false;
}

export interface ProjectAttachmentSetupPlan {
  version: 1;
  state: "attachment_required";
  project: string;
  repository: {
    fullName: string;
    defaultBranch: string;
  };
  requested: {
    runnerProfiles: readonly string[];
    workProfile: RepositorySetupWorkProfile;
    autonomousActions: readonly string[];
    checks: readonly string[];
  };
  sourcePath: "STENSIBLY.md";
  nextAction: {
    kind: "review_and_accept_project_attachment";
    requiresAdmin: true;
    acceptAuthorityWidening: true;
    steps: readonly [
      "create_or_review_stensibly_md",
      "compile_attachment_snapshot",
      "admin_accept_attachment",
      "verify_guarded_repository_read",
    ];
  };
  verification: {
    acceptedAttachment: "get_project_attachment";
    repositoryMetadata: "get_repo";
    immutableFileRead: "fetch_file";
    immutableReadRef: "exact_commit_sha";
  };
  authorityNotice: string;
  authorizesProviderEffect: false;
  containsSecrets: false;
}

export type ProjectAttachmentRecovery =
  | ProjectAttachmentSetupContextRequest
  | ProjectAttachmentSetupPlan
  | null;

const contextRequest: ProjectAttachmentSetupContextRequest = deepFreeze({
  version: 1,
  state: "repository_context_required",
  nextAction: "provide_repository_context",
  requiredFields: [
    "repositoryFullName",
    "defaultBranch",
    "runnerProfiles",
    "workProfile",
    "checks",
  ],
  authorityNotice:
    "Repository context can prepare an attachment setup plan but cannot grant Stensibly authority.",
  authorizesProviderEffect: false,
  containsSecrets: false,
});

/**
 * Returns one bounded continuation for a project whose accepted attachment is
 * absent. Existing accepted attachments remain authoritative and suppress any
 * replacement proposal.
 */
export function projectAttachmentRecovery(
  projectInput: string,
  current: ProjectAttachmentRecord | null,
  setupContext?: ProjectAttachmentSetupContext | null,
): ProjectAttachmentRecovery {
  if (current) return null;
  const project = projectSlug(projectInput);
  if (setupContext === undefined || setupContext === null) return contextRequest;

  const repositoryFullName = normalizeGitHubRepository(
    exactText(setupContext.repositoryFullName, "Repository full name", 140),
  );
  const defaultBranch = branchName(setupContext.defaultBranch);
  const runnerProfiles = canonicalIdentifiers(
    setupContext.runnerProfiles,
    "Runner profile",
    16,
  );
  const workProfile = setupContext.workProfile;
  if (!repositorySetupWorkProfiles.includes(workProfile)) {
    throw new RangeError("Repository setup work profile is invalid");
  }
  const checks = canonicalChecks(setupContext.checks);
  const autonomousActions = workProfile === "read_only"
    ? ["inspect", "propose", "record_progress", "attach_artifact"]
    : [
      "inspect",
      "propose",
      "record_progress",
      "attach_artifact",
      "create_draft_pr",
    ];

  return deepFreeze({
    version: 1,
    state: "attachment_required",
    project,
    repository: {
      fullName: repositoryFullName,
      defaultBranch,
    },
    requested: {
      runnerProfiles,
      workProfile,
      autonomousActions,
      checks,
    },
    sourcePath: "STENSIBLY.md",
    nextAction: {
      kind: "review_and_accept_project_attachment",
      requiresAdmin: true,
      acceptAuthorityWidening: true,
      steps: [
        "create_or_review_stensibly_md",
        "compile_attachment_snapshot",
        "admin_accept_attachment",
        "verify_guarded_repository_read",
      ],
    },
    verification: {
      acceptedAttachment: "get_project_attachment",
      repositoryMetadata: "get_repo",
      immutableFileRead: "fetch_file",
      immutableReadRef: "exact_commit_sha",
    },
    authorityNotice:
      "This plan is advisory. The first accepted attachment widens declared project policy and requires explicit admin review; GitHub access does not grant Stensibly authority.",
    authorizesProviderEffect: false,
    containsSecrets: false,
  });
}

function projectSlug(value: string): string {
  const project = exactText(value, "Project", 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(project)) {
    throw new RangeError("Project must be an exact lowercase project slug");
  }
  return project;
}

function branchName(value: string): string {
  const branch = exactText(value, "Default branch", 240);
  if (
    branch === "@"
    || branch === "HEAD"
    || branch.startsWith("refs/heads/")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.startsWith("-")
    || branch.includes("//")
    || branch.includes("..")
    || branch.includes("@{")
    || /[~^:?*\[\\\s]/u.test(branch)
  ) {
    throw new RangeError("Default branch is invalid");
  }
  if (branch.split("/").some((segment) =>
    !segment
    || segment === "."
    || segment === ".."
    || segment.startsWith(".")
    || segment.endsWith(".")
    || segment.endsWith(".lock")
  )) {
    throw new RangeError("Default branch is invalid");
  }
  return branch;
}

function canonicalIdentifiers(
  values: readonly string[],
  label: string,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) {
    throw new RangeError(`${label} list accepts 1 to ${maximum} values`);
  }
  const admitted = values.map((value) => {
    const result = exactText(value, label, 120);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) {
      throw new RangeError(`${label} is invalid`);
    }
    return result;
  });
  if (new Set(admitted).size !== admitted.length) {
    throw new RangeError(`${label} values must be unique`);
  }
  return Object.freeze([...admitted].sort(codeUnitCompare));
}

function canonicalChecks(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 32) {
    throw new RangeError("Repository setup accepts up to 32 explicit checks");
  }
  const admitted = values.map((value) => exactText(value, "Repository check", 512));
  if (new Set(admitted).size !== admitted.length) {
    throw new RangeError("Repository checks must be unique");
  }
  return Object.freeze([...admitted]);
}

function exactText(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/u.test(value)
  ) {
    throw new RangeError(`${label} must use exact printable ASCII without surrounding whitespace`);
  }
  if (credentialShapedPattern.test(value)) {
    throw new RangeError(`${label} cannot contain credential-shaped text`);
  }
  return value;
}

const credentialShapedPattern =
  /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:env|secret):\/\/|bearer\s+[A-Za-z0-9._~+\/-]{16,})/iu;

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
