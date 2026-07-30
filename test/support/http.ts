export function jsonHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  return Object.fromEntries(headers.entries());
}

export function bearerJsonHeaders(
  token: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const headers = new Headers(jsonHeaders(extra));
  headers.set("authorization", `Bearer ${token}`);
  return Object.fromEntries(headers.entries());
}
