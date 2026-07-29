export interface McpConsentRequestSecurityInput {
  origin?: string | null;
  secFetchSite?: string | null;
  secFetchMode?: string | null;
}

/**
 * Accept the normal exact-Origin browser form submission. Some OAuth browser
 * journeys omit Origin or serialize it as `null`; in that case require Fetch
 * Metadata proving a same-origin top-level navigation. Fetch Metadata headers
 * are browser-controlled, so a cross-site form cannot opt into this fallback.
 */
export function isAllowedMcpConsentRequest(
  input: McpConsentRequestSecurityInput,
  issuer: string,
): boolean {
  const origin = input.origin?.trim();
  if (origin === issuer) return true;
  if (origin && origin !== "null") return false;

  return input.secFetchSite?.trim().toLowerCase() === "same-origin"
    && input.secFetchMode?.trim().toLowerCase() === "navigate";
}
