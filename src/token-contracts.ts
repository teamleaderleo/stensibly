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

export interface TokenPrincipal {
  tokenId: string;
  name: string;
  scopes: TokenScope[];
  projects: string[] | null;
}

export function principalHasScope(
  principal: TokenPrincipal,
  required: "read" | "write",
): boolean {
  return principal.scopes.includes("admin") || principal.scopes.includes(required);
}

export function principalCanAccessProject(
  principal: TokenPrincipal,
  project: string,
): boolean {
  return principal.projects === null || principal.projects.includes(project);
}

export function filterItemsForPrincipal<T extends { project: string }>(
  principal: TokenPrincipal,
  items: T[],
): T[] {
  if (principal.projects === null) return items;
  const allowed = new Set(principal.projects);
  return items.filter((item) => allowed.has(item.project));
}
