export type GitHubDelegatedCallerAdmissionErrorFactory = (
  message: string,
) => Error;

/**
 * Snapshot only the declared caller-owned fields without enumerating the
 * caller's key set. Unrelated string/symbol decorations are deliberately
 * ignored so physical work is bounded by the reviewed field vocabulary.
 */
export function admitGitHubDelegatedCallerRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  label: string,
  invalid: GitHubDelegatedCallerAdmissionErrorFactory,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw invalid(`${label} must be a plain object`);
  }

  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw invalid(`${label} could not be inspected`);
  }
  if (isArray) {
    throw invalid(`${label} must be a plain object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`${label} must use a plain or null prototype`);
  }

  const required = new Set(requiredFields);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of allowedFields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw invalid(`${label} could not be inspected`);
    }
    if (!descriptor) {
      if (required.has(key)) {
        throw invalid(`${label} is missing a required field`);
      }
      continue;
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw invalid(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return result;
}
