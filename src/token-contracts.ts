export const tokenScopes = ["read", "write", "admin"] as const;
export type TokenScope = (typeof tokenScopes)[number];

export const runnerCredentialTools = [
  "claim_runner_work",
  "heartbeat_runner_run",
  "transition_runner_run",
  "reserve_workstation_adapter_command",
  "settle_runner_adapter_command",
] as const;
export type RunnerCredentialTool = (typeof runnerCredentialTools)[number];

/**
 * Narrow machine identity admitted only by the runner endpoint.
 *
 * Project scope remains on the enclosing token. This grant additionally binds the
 * actor, runner implementation, adapter, named physical profiles, and exact tool
 * vocabulary. A token carrying this grant is rejected by ordinary API/MCP auth.
 */
export interface RunnerCredentialGrantV1 {
  version: 1;
  actorId: string;
  runnerType: string;
  adapterId: string;
  profiles: string[];
  tools: RunnerCredentialTool[];
}

export function normalizeRunnerCredentialGrant(
  value: RunnerCredentialGrantV1 | undefined,
): RunnerCredentialGrantV1 | undefined {
  if (value === undefined) return undefined;
  if (value.version !== 1) throw new RangeError("Runner credential grant version is invalid");
  const actorId = boundedRunnerValue(value.actorId, "Runner actor ID", 120);
  const runnerType = boundedRunnerValue(value.runnerType, "Runner type", 80);
  const adapterId = boundedRunnerValue(value.adapterId, "Runner adapter ID", 80);
  const profiles = [...new Set(value.profiles.map((profile) =>
    boundedRunnerValue(profile, "Runner profile", 160)
  ))].sort();
  if (profiles.length === 0 || profiles.length > 16) {
    throw new RangeError("Runner credential requires between one and 16 profiles");
  }
  const allowed = new Set<RunnerCredentialTool>(runnerCredentialTools);
  const tools = [...new Set(value.tools)];
  if (tools.length === 0 || tools.some((tool) => !allowed.has(tool))) {
    throw new RangeError("Runner credential tool grant is invalid");
  }
  return Object.freeze({ version: 1, actorId, runnerType, adapterId, profiles, tools });
}

function boundedRunnerValue(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

export interface TokenRecord {
  id: string;
  name: string;
  scopes: TokenScope[];
  projects: string[] | null;
  runnerGrant?: RunnerCredentialGrantV1;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedToken extends TokenRecord {
  token: string;
}

export interface AuthorizationPrincipal {
  name: string;
  scopes: TokenScope[];
  projects: string[] | null;
  runnerGrant?: RunnerCredentialGrantV1;
}

export interface TokenPrincipal extends AuthorizationPrincipal {
  tokenId: string;
  /** Stable authorization identity when the presented credential rotates. */
  authorizationId?: string;
  /** Hosted account identity admitted from a verified OAuth access token only. */
  oauthAccountId?: string;
}

export function principalAuthorizationId(principal: TokenPrincipal): string {
  return principal.authorizationId ?? principal.tokenId;
}

export function principalHasScope(
  principal: AuthorizationPrincipal,
  required: "read" | "write",
): boolean {
  return principal.scopes.includes("admin") || principal.scopes.includes(required);
}

export function principalCanAccessProject(
  principal: AuthorizationPrincipal,
  project: string,
): boolean {
  return principal.projects === null || principal.projects.includes(project);
}

export function filterItemsForPrincipal<T extends { project: string }>(
  principal: AuthorizationPrincipal,
  items: T[],
): T[] {
  if (principal.projects === null) return items;
  const allowed = new Set(principal.projects);
  return items.filter((item) => allowed.has(item.project));
}
