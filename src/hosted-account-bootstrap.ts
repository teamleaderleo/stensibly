import type {
  HostedAccountService,
  HostedAccountContext,
  HostedSessionContext,
  HostedSessionRecord,
  OAuthStateRecord,
} from "./hosted-account-service.js";

const MAX_BOOTSTRAP_PROJECTS = 32;
const MAX_BOOTSTRAP_PROJECTS_BYTES = 2048;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export function parseHostedAuthBootstrapProjects(
  value: string | undefined,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (new TextEncoder().encode(value).byteLength > MAX_BOOTSTRAP_PROJECTS_BYTES) {
    throw new Error(
      `STENSIBLY_AUTH_BOOTSTRAP_PROJECTS must be at most ${MAX_BOOTSTRAP_PROJECTS_BYTES} UTF-8 bytes`,
    );
  }
  if (!value.trim() || UNSAFE_TEXT_PATTERN.test(value)) {
    throw new Error("STENSIBLY_AUTH_BOOTSTRAP_PROJECTS is invalid");
  }

  const entries = value.split(",");
  if (entries.length > MAX_BOOTSTRAP_PROJECTS) {
    throw new Error(
      `STENSIBLY_AUTH_BOOTSTRAP_PROJECTS may contain at most ${MAX_BOOTSTRAP_PROJECTS} projects`,
    );
  }

  const normalized = entries.map((entry) => {
    const project = entry.trim().toLowerCase();
    if (!project || !PROJECT_PATTERN.test(project)) {
      throw new Error(
        "STENSIBLY_AUTH_BOOTSTRAP_PROJECTS must contain lowercase project slugs up to 80 characters",
      );
    }
    return project;
  });

  if (new Set(normalized).size !== normalized.length) {
    throw new Error("STENSIBLY_AUTH_BOOTSTRAP_PROJECTS contains duplicate projects");
  }
  return normalized.sort();
}

export function withHostedAuthBootstrapProjects(
  service: HostedAccountService,
  projects: string[] | undefined,
): HostedAccountService {
  if (projects === undefined) return service;
  const boundedProjects = [...projects];
  return {
    createOAuthState: async (input): Promise<OAuthStateRecord> =>
      await service.createOAuthState(input),
    consumeOAuthState: async (input): Promise<OAuthStateRecord | null> =>
      await service.consumeOAuthState(input),
    upsertProviderIdentity: async (input): Promise<HostedAccountContext> =>
      await service.upsertProviderIdentity({
        ...input,
        projects: [...boundedProjects],
      }),
    createSession: async (input): Promise<HostedSessionRecord> =>
      await service.createSession(input),
    authenticateSession: async (input): Promise<HostedSessionContext | null> =>
      await service.authenticateSession(input),
    touchSession: async (input): Promise<HostedSessionRecord | null> =>
      await service.touchSession(input),
    revokeSession: async (input): Promise<HostedSessionRecord | null> =>
      await service.revokeSession(input),
  };
}
