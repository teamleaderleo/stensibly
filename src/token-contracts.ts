export const tokenScopes = ["read", "write", "admin"] as const;
export type TokenScope = (typeof tokenScopes)[number];

export interface TokenRecord {
  id: string;
  name: string;
  scopes: TokenScope[];
  projects: string[] | null;
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
}

export interface TokenPrincipal extends AuthorizationPrincipal {
  tokenId: string;
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
