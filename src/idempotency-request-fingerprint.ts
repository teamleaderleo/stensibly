import { createHash } from "node:crypto";
import { canonicalIdempotencyRequestText } from "./idempotency-request-canonical.js";

export function idempotencyRequestFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalIdempotencyRequestText(value)).digest("hex")}`;
}
