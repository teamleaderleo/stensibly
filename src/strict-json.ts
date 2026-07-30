export interface StrictJsonOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxStringLength?: number;
  maxObjectKeys?: number;
  maxArrayLength?: number;
  prefix?: string;
}

export class StrictJsonError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, message: string, path = "$") {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
    this.path = path;
  }
}

interface StrictJsonSettings {
  maxBytes: number;
  maxDepth: number;
  maxStringLength: number;
  maxObjectKeys: number;
  maxArrayLength: number;
  prefix: string;
}

interface Cursor {
  index: number;
}

function fail(
  settings: StrictJsonSettings,
  suffix: string,
  message: string,
  path = "$",
): never {
  throw new StrictJsonError(`${settings.prefix}_${suffix}`, message, path);
}

function skipWhitespace(text: string, cursor: Cursor): void {
  while (
    cursor.index < text.length
    && /[\t\n\r ]/u.test(text[cursor.index] ?? "")
  ) {
    cursor.index += 1;
  }
}

function parseString(
  text: string,
  cursor: Cursor,
  settings: StrictJsonSettings,
  path: string,
): string {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < text.length) {
    const code = text.charCodeAt(cursor.index);
    if (code === 0x22) {
      cursor.index += 1;
      let value: unknown;
      try {
        value = JSON.parse(text.slice(start, cursor.index)) as unknown;
      } catch {
        fail(settings, "INVALID_JSON", "Invalid JSON string escape.", path);
      }
      if (typeof value !== "string") {
        fail(settings, "INVALID_JSON", "JSON string did not decode to text.", path);
      }
      if ([...value].length > settings.maxStringLength) {
        fail(
          settings,
          "STRING_TOO_LONG",
          `JSON string exceeds ${settings.maxStringLength} characters.`,
          path,
        );
      }
      return value;
    }
    if (code < 0x20) {
      fail(
        settings,
        "INVALID_JSON",
        "Unescaped control character in JSON string.",
        path,
      );
    }
    if (code === 0x5c) {
      cursor.index += 1;
      if (cursor.index >= text.length) {
        fail(settings, "INVALID_JSON", "Incomplete JSON escape.", path);
      }
      if (text[cursor.index] === "u") {
        const hex = text.slice(cursor.index + 1, cursor.index + 5);
        if (!/^[a-fA-F0-9]{4}$/u.test(hex)) {
          fail(settings, "INVALID_JSON", "Invalid Unicode escape.", path);
        }
        cursor.index += 5;
        continue;
      }
      if (!/["\\/bfnrt]/u.test(text[cursor.index] ?? "")) {
        fail(settings, "INVALID_JSON", "Invalid JSON escape.", path);
      }
    }
    cursor.index += 1;
  }
  fail(settings, "INVALID_JSON", "Unterminated JSON string.", path);
}

function parseNumber(
  text: string,
  cursor: Cursor,
  settings: StrictJsonSettings,
  path: string,
): void {
  const match = text.slice(cursor.index).match(
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u,
  );
  if (!match?.[0]) {
    fail(settings, "INVALID_JSON", "Invalid JSON number.", path);
  }
  cursor.index += match[0].length;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) {
    fail(settings, "NON_FINITE_NUMBER", "JSON numbers must be finite.", path);
  }
}

function parseValue(
  text: string,
  cursor: Cursor,
  depth: number,
  settings: StrictJsonSettings,
  path: string,
): void {
  if (depth > settings.maxDepth) {
    fail(
      settings,
      "TOO_DEEP",
      `JSON nesting exceeds ${settings.maxDepth}.`,
      path,
    );
  }
  skipWhitespace(text, cursor);
  const char = text[cursor.index];
  if (char === "{") {
    parseObject(text, cursor, depth + 1, settings, path);
    return;
  }
  if (char === "[") {
    parseArray(text, cursor, depth + 1, settings, path);
    return;
  }
  if (char === '"') {
    parseString(text, cursor, settings, path);
    return;
  }
  if (char === "-" || /\d/u.test(char ?? "")) {
    parseNumber(text, cursor, settings, path);
    return;
  }
  for (const literal of ["true", "false", "null"]) {
    if (text.startsWith(literal, cursor.index)) {
      cursor.index += literal.length;
      return;
    }
  }
  fail(settings, "INVALID_JSON", "Unexpected JSON token.", path);
}

function parseObject(
  text: string,
  cursor: Cursor,
  depth: number,
  settings: StrictJsonSettings,
  path: string,
): void {
  cursor.index += 1;
  skipWhitespace(text, cursor);
  if (text[cursor.index] === "}") {
    cursor.index += 1;
    return;
  }
  const keys = new Set<string>();
  while (cursor.index < text.length) {
    skipWhitespace(text, cursor);
    if (text[cursor.index] !== '"') {
      fail(settings, "INVALID_JSON", "Object keys must be strings.", path);
    }
    const key = parseString(text, cursor, settings, path);
    if (keys.has(key)) {
      fail(
        settings,
        "DUPLICATE_KEY",
        `Duplicate JSON key: ${key}.`,
        `${path}.${key}`,
      );
    }
    keys.add(key);
    if (keys.size > settings.maxObjectKeys) {
      fail(
        settings,
        "OBJECT_TOO_LARGE",
        `JSON object exceeds ${settings.maxObjectKeys} keys.`,
        path,
      );
    }
    skipWhitespace(text, cursor);
    if (text[cursor.index] !== ":") {
      fail(
        settings,
        "INVALID_JSON",
        "Expected colon after object key.",
        `${path}.${key}`,
      );
    }
    cursor.index += 1;
    parseValue(text, cursor, depth, settings, `${path}.${key}`);
    skipWhitespace(text, cursor);
    if (text[cursor.index] === "}") {
      cursor.index += 1;
      return;
    }
    if (text[cursor.index] !== ",") {
      fail(
        settings,
        "INVALID_JSON",
        "Expected comma between object entries.",
        path,
      );
    }
    cursor.index += 1;
  }
  fail(settings, "INVALID_JSON", "Unterminated JSON object.", path);
}

function parseArray(
  text: string,
  cursor: Cursor,
  depth: number,
  settings: StrictJsonSettings,
  path: string,
): void {
  cursor.index += 1;
  skipWhitespace(text, cursor);
  if (text[cursor.index] === "]") {
    cursor.index += 1;
    return;
  }
  let index = 0;
  while (cursor.index < text.length) {
    if (index >= settings.maxArrayLength) {
      fail(
        settings,
        "ARRAY_TOO_LARGE",
        `JSON array exceeds ${settings.maxArrayLength} entries.`,
        path,
      );
    }
    parseValue(text, cursor, depth, settings, `${path}[${index}]`);
    skipWhitespace(text, cursor);
    if (text[cursor.index] === "]") {
      cursor.index += 1;
      return;
    }
    if (text[cursor.index] !== ",") {
      fail(
        settings,
        "INVALID_JSON",
        "Expected comma between array entries.",
        path,
      );
    }
    cursor.index += 1;
    index += 1;
  }
  fail(settings, "INVALID_JSON", "Unterminated JSON array.", path);
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseStrictJson(
  text: string,
  options: StrictJsonOptions = {},
): unknown {
  const settings: StrictJsonSettings = {
    maxBytes: boundedInteger(
      options.maxBytes ?? 65_536,
      "Strict JSON byte bound",
      1,
      16 * 1_024 * 1_024,
    ),
    maxDepth: boundedInteger(
      options.maxDepth ?? 16,
      "Strict JSON depth bound",
      1,
      256,
    ),
    maxStringLength: boundedInteger(
      options.maxStringLength ?? 4_096,
      "Strict JSON string bound",
      1,
      8 * 1_024 * 1_024,
    ),
    maxObjectKeys: boundedInteger(
      options.maxObjectKeys ?? 128,
      "Strict JSON object-key bound",
      1,
      100_000,
    ),
    maxArrayLength: boundedInteger(
      options.maxArrayLength ?? 128,
      "Strict JSON array bound",
      1,
      100_000,
    ),
    prefix: options.prefix ?? "STRICT_JSON",
  };
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(settings.prefix)) {
    throw new RangeError("Strict JSON error prefix is invalid");
  }
  if (typeof text !== "string") {
    fail(settings, "INVALID_JSON", "JSON input must be a string.");
  }
  if (Buffer.byteLength(text, "utf8") > settings.maxBytes) {
    fail(
      settings,
      "TOO_LARGE",
      `JSON input exceeds ${settings.maxBytes} bytes.`,
    );
  }
  const cursor: Cursor = { index: 0 };
  parseValue(text, cursor, 0, settings, "$");
  skipWhitespace(text, cursor);
  if (cursor.index !== text.length) {
    fail(settings, "INVALID_JSON", "Trailing data after JSON value.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(settings, "INVALID_JSON", "Input contains invalid JSON.");
  }
}
