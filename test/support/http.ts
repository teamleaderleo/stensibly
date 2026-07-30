function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

export function jsonHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  return headerRecord(headers);
}

export function bearerJsonHeaders(
  token: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const headers = new Headers(jsonHeaders(extra));
  headers.set("authorization", `Bearer ${token}`);
  return headerRecord(headers);
}
