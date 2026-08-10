import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  readProjectSetupStatus,
  setupStepLabel,
} from "../site/project-setup-status.js";

const project = "scrapbook";
const steps = [
  ["deployment", "ready", true],
  ["backend", "ready", true],
  ["account", "ready", true],
  ["workspace", "ready", true],
  ["project", "ready", true],
  ["oauth_discovery", "ready", true],
  ["mcp_connection", "missing", true],
  ["first_read", "missing", true],
  ["repository", "missing", false],
  ["proofwake", "deferred", false],
] as const;

function response(repositoryRecovery: unknown, overrides: Record<string, unknown> = {}) {
  return {
    setupStatus: {
      version: 1,
      mode: "production",
      state: "partially_configured",
      observedAt: "2026-08-10T00:15:00.000Z",
      serviceOrigin: "https://api.stensibly.com",
      mcpEndpoint: "https://api.stensibly.com/mcp",
      lastVerifiedStep: "project",
      nextStep: "mcp_connection",
      requiredReady: 6,
      requiredTotal: 8,
      degradedSteps: [],
      optionalAttentionSteps: [],
      steps: steps.map(([step, state, required]) => ({ step, state, required })),
      repositoryRecovery,
      containsSecrets: false,
      ...overrides,
    },
  };
}

function repositorySetupObservation(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "repo_setup_12345678",
    project,
    repositoryFullName: "teamleaderleo/scrapbook",
    defaultBranch: "main",
    sourceKind: "github_conversation_context",
    semanticFingerprint: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-08-10T00:14:00.000Z",
    authorizesProviderEffect: false,
    containsSecrets: false,
    ...overrides,
  };
}

function contextRecovery() {
  return {
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
    authorityNotice: "server prose ignored by the reader",
    authorizesProviderEffect: false,
    containsSecrets: false,
  };
}

function attachmentRecovery(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    state: "attachment_required",
    project,
    repository: {
      fullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
    },
    requested: {
      runnerProfiles: ["codex-default"],
      workProfile: "draft_pr",
      autonomousActions: ["inspect", "propose", "create_draft_pr"],
      checks: ["bun run typecheck", "bun test"],
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
    authorityNotice: "server prose ignored by the reader",
    authorizesProviderEffect: false,
    containsSecrets: false,
    ...overrides,
  };
}

describe("dashboard project setup-status reader", () => {
  test("admits the bounded context-needed continuation", () => {
    const value = readProjectSetupStatus(response(contextRecovery()), project);
    expect(value).toMatchObject({
      version: 1,
      mode: "production",
      state: "partially_configured",
      nextStep: "mcp_connection",
      lastVerifiedStep: "project",
      repositoryRecovery: {
        state: "repository_context_required",
        nextAction: "provide_repository_context",
        authorizesProviderEffect: false,
      },
      repositorySetupObservation: null,
      containsSecrets: false,
    });
    expect(value.repositoryRecovery).not.toHaveProperty("authorityNotice");
    expect(setupStepLabel("first_read")).toBe("First verified read");
  });

  test("admits the persisted advisory repository proposal", () => {
    const value = readProjectSetupStatus(response(contextRecovery(), {
      repositorySetupObservation: repositorySetupObservation(),
    }), project);
    expect(value.repositorySetupObservation).toEqual({
      version: 1,
      id: "repo_setup_12345678",
      project,
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "github_conversation_context",
      semanticFingerprint: `sha256:${"a".repeat(64)}`,
      observedAt: "2026-08-10T00:14:00.000Z",
      authorizesProviderEffect: false,
      containsSecrets: false,
    });

    expect(() => readProjectSetupStatus(response(contextRecovery(), {
      repositorySetupObservation: repositorySetupObservation({ project: "other" }),
    }), project)).toThrow("does not match");
    expect(() => readProjectSetupStatus(response(contextRecovery(), {
      repositorySetupObservation: repositorySetupObservation({
        semanticFingerprint: ["stn", "tok", "x".repeat(44)].join("."),
      }),
    }), project)).toThrow("fingerprint is invalid");
  });

  test("admits only the local fields needed to render an attachment plan", () => {
    const value = readProjectSetupStatus(response(attachmentRecovery()), project);
    expect(value.repositoryRecovery).toMatchObject({
      state: "attachment_required",
      project,
      repository: {
        fullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
      },
      requested: {
        runnerProfiles: ["codex-default"],
        workProfile: "draft_pr",
        checks: ["bun run typecheck", "bun test"],
      },
      sourcePath: "STENSIBLY.md",
      nextAction: {
        kind: "review_and_accept_project_attachment",
        requiresAdmin: true,
        acceptAuthorityWidening: true,
      },
      verification: {
        repositoryMetadata: "get_repo",
        immutableFileRead: "fetch_file",
        immutableReadRef: "exact_commit_sha",
      },
    });
    expect(value.repositoryRecovery).not.toHaveProperty("authorityNotice");
  });

  test("distinguishes ready and deferred repository states with null recovery", () => {
    const readySteps = steps.map(([step, state, required]) => ({
      step,
      state: step === "repository" ? "ready" : state,
      required,
    }));
    const ready = readProjectSetupStatus(response(null, { steps: readySteps }), project);
    expect(ready.repositoryRecovery).toBeNull();
    expect(ready.steps.find((entry) => entry.step === "repository")?.state).toBe("ready");

    const deferredSteps = steps.map(([step, state, required]) => ({
      step,
      state: step === "repository" ? "deferred" : state,
      required,
    }));
    const deferred = readProjectSetupStatus(response(null, { steps: deferredSteps }), project);
    expect(deferred.repositoryRecovery).toBeNull();
    expect(deferred.steps.find((entry) => entry.step === "repository")?.state).toBe("deferred");
  });

  test("rejects unsafe public fields, credentials, scope mismatch, and incompatible enums", () => {
    expect(() => readProjectSetupStatus(response(contextRecovery(), {
      serviceOrigin: "https://user:secret@api.stensibly.com",
    }), project)).toThrow("Setup service origin is invalid");

    expect(() => readProjectSetupStatus(response(attachmentRecovery({
      requested: {
        runnerProfiles: ["codex-default"],
        workProfile: "draft_pr",
        checks: [["Authorization:", ["Bear", "er"].join(""), "x".repeat(26)].join(" ")],
      },
    })), project)).toThrow("Repository checks is invalid");

    expect(() => readProjectSetupStatus(response(attachmentRecovery({
      project: "other",
    })), project)).toThrow("does not match");

    expect(() => readProjectSetupStatus(response(contextRecovery(), {
      state: "magic",
    }), project)).toThrow("Setup state is invalid");
  });
});

describe("dashboard project setup-status wiring", () => {
  test("installs the explicit System attachment owner action after hosted-session fetch rewriting", async () => {
    const [bridge, entry, reader, review, css, assets] = await Promise.all([
      readFile("site/hosted-session-bridge.js", "utf8"),
      readFile("site/project-setup-status-entry.js", "utf8"),
      readFile("site/project-setup-status.js", "utf8"),
      readFile("site/project-attachment-review.js", "utf8"),
      readFile("site/project-setup-status.css", "utf8"),
      readFile("src/dashboard-assets.ts", "utf8"),
    ]);

    const bridgeInstall = bridge.indexOf("window.fetch = installHostedSessionFetchBridge");
    const cardInstall = bridge.indexOf("installProjectSetupStatusCard();");
    expect(bridgeInstall).toBeGreaterThanOrEqual(0);
    expect(cardInstall).toBeGreaterThan(bridgeInstall);
    expect(entry).toContain('/api/v1/projects/${encodeURIComponent(project)}/setup-status');
    expect(entry).toContain('/api/v1/projects/${encodeURIComponent(project)}/attachment/review');
    expect(entry).toContain('/api/v1/projects/${encodeURIComponent(project)}/attachment');
    expect(entry).toContain("method: 'POST'");
    expect(entry).toContain("method: 'PUT'");
    expect(entry).toContain("acceptAuthorityWidening");
    expect(entry).toContain("Review cancelled. No attachment action was sent.");
    expect(entry).toContain("snapshot fingerprint");
    expect(entry).toContain('id=\"project-setup-status-panel\"');
    expect(entry).toContain("saved advisory repository proposal");
    expect(entry).toContain("Proposed repository");
    expect(entry).toContain("review STENSIBLY.md");
    expect(reader).toContain("repositorySetupObservation");
    expect(reader).not.toContain("authorityNotice:");
    expect(review).toContain("createRepositoryAttachmentDraft");
    expect(review).toContain("local-draft:sha256:");
    expect(review).toContain("credential-shaped material");
    expect(css).toContain(".project-setup-status-steps");
    expect(assets).toContain('path: "/project-setup-status-entry.js"');
    expect(assets).toContain('path: "/project-setup-status.js"');
    expect(assets).toContain('path: "/project-attachment-review.js"');
    expect(assets).toContain('path: "/project-setup-status.css"');
  });
});