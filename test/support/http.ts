function withoutHeaders(
  extra: Readonly<Record<string, string>>,
  protectedNames: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(extra).filter(
      ([name]) => !protectedNames.has(name.toLowerCase()),
    ),
  );
}

const jsonHeaderNames = new Set(["content-type"]);
const bearerJsonHeaderNames = new Set(["authorization", "content-type"]);

export function jsonHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...withoutHeaders(extra, jsonHeaderNames),
    "content-type": "application/json",
  };
}

export function bearerJsonHeaders(
  token: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...withoutHeaders(extra, bearerJsonHeaderNames),
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}
