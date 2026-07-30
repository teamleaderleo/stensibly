export function jsonHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return canonicalHeaders(extra, { "content-type": "application/json" });
}

export function bearerJsonHeaders(
  token: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return canonicalHeaders(extra, {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
}

function canonicalHeaders(
  extra: Readonly<Record<string, string>>,
  canonical: Readonly<Record<string, string>>,
): Record<string, string> {
  const reserved = new Set(Object.keys(canonical));
  return {
    ...Object.fromEntries(
      Object.entries(extra).filter(([name]) => !reserved.has(name.toLowerCase())),
    ),
    ...canonical,
  };
}
