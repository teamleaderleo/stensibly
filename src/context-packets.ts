import type { Artifact } from "./artifacts.js";
import type { ItemDetail, WorkLedger } from "./ledger.js";
import type { Item, ItemEvent } from "./store.js";

export interface RunnerContextPacketOptions {
  maxEvents?: number;
  maxArtifacts?: number;
  maxRuns?: number;
  maxDependencies?: number;
  maxCharacters?: number;
  now?: Date;
}

export interface RunnerContextEvent {
  id: string;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  protected: boolean;
}

export interface RunnerContextArtifact {
  id: string;
  kind: string;
  label: string;
  uri: string;
  mimeType: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RunnerContextRecord {
  id: string;
  [key: string]: unknown;
}

export interface RunnerContextPacket {
  version: 1;
  generatedAt: string;
  item: Item;
  intent: {
    objective: string;
    summary: string | null;
    nextAction: string | null;
  };
  events: RunnerContextEvent[];
  artifacts: RunnerContextArtifact[];
  runs: RunnerContextRecord[];
  dependencies: RunnerContextRecord[];
  sourceReferences: string[];
  omitted: {
    events: number;
    artifacts: number;
    runs: number;
    dependencies: number;
  };
  characterCount: number;
}

interface NormalizedOptions {
  maxEvents: number;
  maxArtifacts: number;
  maxRuns: number;
  maxDependencies: number;
  maxCharacters: number;
  now: Date;
}

const protectedEventPattern = /(approval|block|constraint|decision|escalat|human|policy|question|risk|security)/i;
const sensitiveKeyPattern = /(api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)/i;
const sensitiveValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:ghp|github_pat|sk|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

export async function getRunnerContextPacket(
  ledger: WorkLedger,
  itemId: string,
  options: RunnerContextPacketOptions = {},
): Promise<RunnerContextPacket> {
  return buildRunnerContextPacket(await ledger.getItem(itemId), options);
}

export function buildRunnerContextPacket(
  detail: ItemDetail,
  rawOptions: RunnerContextPacketOptions = {},
): RunnerContextPacket {
  const options = normalizeOptions(rawOptions);
  const protectedEvents = detail.events.filter((event) => protectedEventPattern.test(event.type));
  const protectedIds = new Set(protectedEvents.map((event) => event.id));
  const ordinaryLimit = Math.max(0, options.maxEvents - protectedEvents.length);
  const ordinaryEvents = detail.events.filter((event) => !protectedIds.has(event.id));
  const ordinaryRecent = ordinaryLimit === 0 ? [] : ordinaryEvents.slice(-ordinaryLimit);
  let events = [...protectedEvents, ...ordinaryRecent]
    .sort(compareCreated)
    .map((event) => normalizeEvent(event, protectedIds.has(event.id)));

  let artifacts = detail.artifacts
    .slice()
    .sort(compareCreatedNewest)
    .slice(0, options.maxArtifacts)
    .map(normalizeArtifact);
  let runs = normalizeRecords(detail.runs, options.maxRuns);
  let dependencies = normalizeRecords(detail.dependencies, options.maxDependencies);
  const omitted = {
    events: Math.max(0, detail.events.length - events.length),
    artifacts: Math.max(0, detail.artifacts.length - artifacts.length),
    runs: Math.max(0, (detail.runs?.length ?? 0) - runs.length),
    dependencies: Math.max(0, (detail.dependencies?.length ?? 0) - dependencies.length),
  };

  const item = normalizeItem(detail.item);
  while (true) {
    const packet = assemblePacket(item, events, artifacts, runs, dependencies, omitted, options.now);
    if (packet.characterCount <= options.maxCharacters) return packet;

    const overflow = packet.characterCount - options.maxCharacters;
    if (item.summary && item.summary.length > 80) {
      item.summary = clip(item.summary, Math.max(80, item.summary.length - overflow - 16));
      continue;
    }
    if (item.nextAction && item.nextAction.length > 80) {
      item.nextAction = clip(item.nextAction, Math.max(80, item.nextAction.length - overflow - 16));
      continue;
    }

    const ordinaryIndex = events.findIndex((event) => !event.protected);
    if (ordinaryIndex >= 0) {
      events.splice(ordinaryIndex, 1);
      omitted.events += 1;
      continue;
    }
    if (runs.length > 0) {
      runs.pop();
      omitted.runs += 1;
      continue;
    }
    if (artifacts.length > 0) {
      artifacts.pop();
      omitted.artifacts += 1;
      continue;
    }
    if (dependencies.length > 0) {
      dependencies.pop();
      omitted.dependencies += 1;
      continue;
    }
    if (events.length > 0) {
      events.shift();
      omitted.events += 1;
      continue;
    }
    return packet;
  }
}

function assemblePacket(
  item: Item,
  events: RunnerContextEvent[],
  artifacts: RunnerContextArtifact[],
  runs: RunnerContextRecord[],
  dependencies: RunnerContextRecord[],
  omitted: RunnerContextPacket["omitted"],
  now: Date,
): RunnerContextPacket {
  const base = {
    version: 1 as const,
    generatedAt: now.toISOString(),
    item,
    intent: {
      objective: item.title,
      summary: item.summary,
      nextAction: item.nextAction,
    },
    events,
    artifacts,
    runs,
    dependencies,
    sourceReferences: [
      `item:${item.id}`,
      ...events.map((event) => `event:${event.id}`),
      ...artifacts.map((artifact) => `artifact:${artifact.id}`),
      ...runs.map((run) => `run:${run.id}`),
      ...dependencies.map((dependency) => `dependency:${dependency.id}`),
    ],
    omitted: { ...omitted },
  };
  let packet = { ...base, characterCount: 0 };
  let characterCount = JSON.stringify(packet).length;
  packet = { ...base, characterCount };
  characterCount = JSON.stringify(packet).length;
  return { ...base, characterCount };
}

function normalizeOptions(options: RunnerContextPacketOptions): NormalizedOptions {
  return {
    maxEvents: boundedInteger(options.maxEvents, 20, 1, 100, "Context event limit"),
    maxArtifacts: boundedInteger(options.maxArtifacts, 10, 0, 50, "Context artifact limit"),
    maxRuns: boundedInteger(options.maxRuns, 5, 0, 25, "Context run limit"),
    maxDependencies: boundedInteger(options.maxDependencies, 20, 0, 100, "Context dependency limit"),
    maxCharacters: boundedInteger(options.maxCharacters, 12_000, 2_000, 50_000, "Context character limit"),
    now: options.now ?? new Date(),
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function normalizeItem(item: Item): Item {
  return {
    ...item,
    title: redactText(clip(item.title, 240)),
    summary: item.summary ? redactText(clip(item.summary, 4_000)) : null,
    nextAction: item.nextAction ? redactText(clip(item.nextAction, 2_000)) : null,
  };
}

function normalizeEvent(event: ItemEvent, protectedEvent: boolean): RunnerContextEvent {
  return {
    id: event.id,
    type: event.type,
    actorId: event.actorId,
    payload: sanitizeRecord(event.payload),
    createdAt: event.createdAt,
    protected: protectedEvent,
  };
}

function normalizeArtifact(artifact: Artifact): RunnerContextArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    label: redactText(clip(artifact.label, 240)),
    uri: redactText(clip(artifact.uri, 2_000)),
    mimeType: artifact.mimeType,
    metadata: sanitizeRecord(artifact.metadata),
    createdAt: artifact.createdAt,
  };
}

function normalizeRecords(records: unknown[] | undefined, limit: number): RunnerContextRecord[] {
  if (!records || limit === 0) return [];
  return records
    .filter(isRecord)
    .slice()
    .sort(compareUnknownCreatedNewest)
    .slice(0, limit)
    .map((record, index) => {
      const sanitized = sanitizeRecord(record);
      const id = typeof sanitized.id === "string"
        ? sanitized.id
        : typeof sanitized.itemId === "string"
          ? sanitized.itemId
          : String(index + 1);
      return { ...sanitized, id };
    });
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[REDACTED]" : sanitizeValue(value, 0),
    ]),
  );
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= 4) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(clip(value, 1_000));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).slice(0, 50).map(([key, entry]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[REDACTED]" : sanitizeValue(entry, depth + 1),
      ]),
    );
  }
  return String(value);
}

function redactText(value: string): string {
  let redacted = value.replace(/:\/\/([^/@:\s]+):([^/@\s]+)@/g, "://[REDACTED]@");
  for (const pattern of sensitiveValuePatterns) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}

function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function compareCreated(left: { createdAt: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function compareCreatedNewest(left: { createdAt: string }, right: { createdAt: string }): number {
  return right.createdAt.localeCompare(left.createdAt);
}

function compareUnknownCreatedNewest(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftCreated = typeof left.createdAt === "string" ? left.createdAt : "";
  const rightCreated = typeof right.createdAt === "string" ? right.createdAt : "";
  return rightCreated.localeCompare(leftCreated);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
