import { sha256, stableJson } from "./canonical-json.js";

export function compactPublicMcpResult(value: unknown): unknown {
  if (!isRecord(value) || value.isError === true) return value;
  const structured = ownValue(value, "structuredContent");
  if (!isRecord(structured) || !Object.hasOwn(structured, "data")) return value;
  const readable = JSON.stringify(structured.data);
  const text = typeof readable === "string" && utf8Bytes(readable) <= 2_048
    ? readable
    : JSON.stringify({
        structured: true,
        sha256: digest(structured.data),
      });
  return {
    ...value,
    content: [{ type: "text", text }],
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function digest(value: unknown): string {
  try {
    return sha256(stableJson(value ?? null));
  } catch {
    return sha256("unavailable");
  }
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
