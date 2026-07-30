export function bearerJsonHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...extra,
  };
}
