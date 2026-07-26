const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const MAX_PROJECT_SLUG_LENGTH = 80;

export function validateOptionalProjectScope(
  value: undefined,
  label?: string,
): undefined;
export function validateOptionalProjectScope(
  value: string,
  label?: string,
): string;
export function validateOptionalProjectScope(
  value: string | undefined,
  label = "project",
): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0
    || value.length > MAX_PROJECT_SLUG_LENGTH
    || !PROJECT_SLUG_PATTERN.test(value)
  ) {
    throw new RangeError(`${label} must be a lowercase project slug`);
  }
  return value;
}
