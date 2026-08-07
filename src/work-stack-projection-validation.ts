const credentialPatterns = Object.freeze([
  /(?:^|[^A-Za-z0-9])stn\.tok_[A-Za-z0-9._-]{20,}(?=$|[^A-Za-z0-9._-])/i,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}(?=$|[^A-Za-z0-9_])/i,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?=$|[^A-Za-z0-9])/i,
  /(?:^|[^A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?=$|[^A-Za-z0-9_-])/i,
  /(?:^|[^A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}(?=$|[\s,;])/i,
]);

export function snapshotPlainObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError(`${label} could not be inspected`);
  }
  if (prototype !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new TypeError(`${label} could not be inspected`);
    }
    if (!descriptor) {
      throw new TypeError(`${label} has an invalid field set`);
    }
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function denseDataArray<T>(value: unknown, max: number, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be a bounded ordinary array`);
  }
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new TypeError(`${label} could not be inspected`);
  }
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (
    prototype !== Array.prototype
    || typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > max
  ) {
    throw new TypeError(`${label} must be a bounded ordinary array`);
  }
  const result: T[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw new TypeError(`${label} could not be inspected`);
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} entries must be enumerable data properties`);
    }
    result.push(descriptor.value as T);
  }
  return result;
}

export function lowercaseSlug(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value)) {
    throw new TypeError(`${label} must be an exact lowercase slug`);
  }
  return value;
}

export function boundedIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 240
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@+-]*$/.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  if (containsCredentialShape(value)) {
    throw new TypeError(`${label} contains credential-shaped text`);
  }
  return value;
}

export function boundedText(
  value: unknown,
  min: number,
  max: number,
  label: string,
): string {
  if (
    typeof value !== "string"
    || value.length < min
    || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  if (containsCredentialShape(value)) {
    throw new TypeError(`${label} contains credential-shaped text`);
  }
  return value;
}

export function nullableText(value: unknown, max: number, label: string): string | null {
  return value === null ? null : boundedText(value, 1, max, label);
}

export function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    !Number.isInteger(value)
    || typeof value !== "number"
    || Object.is(value, -0)
    || value < min
    || value > max
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}

export function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

export function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} must be unique`);
  }
}

export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonicalJsonUtf8Length(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertCanonicalJsonByteBudget(
  value: unknown,
  maxBytes: number,
  label: string,
): void {
  if (canonicalJsonUtf8Length(value) > maxBytes) {
    throw new RangeError(`${label} exceeds the ${maxBytes}-byte output limit`);
  }
}

function containsCredentialShape(value: string): boolean {
  return credentialPatterns.some((pattern) => pattern.test(value));
}
