export function exactBooleanEnv(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const value = env[key];
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${key} must be exact true or false`);
}
