import { sha256Hex } from "./sha256.js";

export interface CreateItemFingerprintInput {
  project: string;
  kind: string;
  title: string;
  summary: string | null;
  nextAction: string | null;
  priority: number;
  actorId: string | null;
}

export interface AttachArtifactFingerprintInput {
  itemId: string;
  actorId: string;
  kind: string;
  label: string;
  uri: string;
  mimeType: string | null;
  metadata: Record<string, unknown>;
}

export function createItemRequestFingerprint(
  input: CreateItemFingerprintInput,
): string {
  return fingerprintCanonicalRequest({
    version: 1,
    operation: "item.create",
    project: input.project,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    nextAction: input.nextAction,
    priority: input.priority,
    actorId: input.actorId,
  });
}

export function attachArtifactRequestFingerprint(
  input: AttachArtifactFingerprintInput,
): string {
  return fingerprintCanonicalRequest({
    version: 1,
    operation: "artifact.attach",
    itemId: input.itemId,
    actorId: input.actorId,
    kind: input.kind,
    label: input.label,
    uri: input.uri,
    mimeType: input.mimeType,
    metadata: input.metadata,
  });
}

export function fingerprintCanonicalRequest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJsonString(value))}`;
}

export function fingerprintExactText(value: string): string {
  return `sha256:${sha256Hex(value)}`;
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
