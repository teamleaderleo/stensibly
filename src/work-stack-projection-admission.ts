import { createHash } from "node:crypto";
import {
  WORK_STACK_LIMITS,
  WORK_STACK_PROJECTION_VERSION,
  type WorkStackAttentionReason,
  type WorkStackItemKind,
  type WorkStackLinkInput,
  type WorkStackLinkKind,
  type WorkStackProjectionInput,
  type WorkStackRecordInput,
  type WorkStackReviewState,
  type WorkStackState,
} from "./work-stack-projection-types.ts";
import {
  boundedIdentity,
  boundedInteger,
  boundedText,
  canonicalTimestamp,
  compareCodeUnits,
  denseDataArray,
  enumValue,
  lowercaseSlug,
  nullableText,
  requirePlainObject,
  requireUnique,
} from "./work-stack-projection-validation.ts";

const itemKinds = new Set<WorkStackItemKind>([
  "task", "finding", "question", "decision", "tip", "handoff", "note",
]);
const states = new Set<WorkStackState>(["ready", "active", "blocked", "done", "archived"]);
const attentionReasons = new Set<WorkStackAttentionReason>([
  "human_decision", "ambiguous_outcome", "failed_verification", "expired_lease",
  "missed_heartbeat", "shared_blocker", "external_wait", "stale_observation",
  "ordinary_block",
]);
const reviewStates = new Set<WorkStackReviewState>(["none", "actionable", "reviewed"]);
const linkKinds = new Set<WorkStackLinkKind>([
  "item", "run", "request", "receipt", "github_issue", "github_pull_request",
  "github_review", "github_commit", "github_check", "artifact", "deployment",
  "provider_observation", "parent", "dependency", "handoff", "supersession",
]);

export interface AdmittedProjectionInput extends WorkStackProjectionInput {
  records: WorkStackRecordInput[];
}

export function admitProjectionInput(value: WorkStackProjectionInput): AdmittedProjectionInput {
  requirePlainObject(
    value,
    ["version", "project", "observedAt", "selectedId", "limits", "records"],
    "work-stack input",
  );
  if (value.version !== WORK_STACK_PROJECTION_VERSION) {
    throw new TypeError("Unsupported work-stack projection version");
  }
  const project = lowercaseSlug(value.project, "project");
  const observedAt = canonicalTimestamp(value.observedAt, "observedAt");
  const selectedId = value.selectedId === null
    ? null
    : boundedIdentity(value.selectedId, "selectedId");
  requirePlainObject(value.limits, ["hot", "review", "warm", "index"], "work-stack limits");
  const limits = {
    hot: boundedInteger(value.limits.hot, 1, WORK_STACK_LIMITS.maxHot, "hot limit"),
    review: boundedInteger(
      value.limits.review,
      1,
      WORK_STACK_LIMITS.maxReview,
      "review limit",
    ),
    warm: boundedInteger(value.limits.warm, 1, WORK_STACK_LIMITS.maxWarm, "warm limit"),
    index: boundedInteger(value.limits.index, 1, WORK_STACK_LIMITS.maxIndex, "index limit"),
  };
  const records = denseDataArray(
    value.records,
    WORK_STACK_LIMITS.maxInputRecords,
    "records",
  );
  const observedMs = Date.parse(observedAt);
  const admittedRecords = records.map((record) => admitRecord(record, project, observedMs));
  requireUnique(admittedRecords.map((record) => record.id), "record identity");
  return {
    version: WORK_STACK_PROJECTION_VERSION,
    project,
    observedAt,
    selectedId,
    limits,
    records: admittedRecords,
  };
}

function admitRecord(
  value: WorkStackRecordInput,
  project: string,
  observedMs: number,
): WorkStackRecordInput {
  requirePlainObject(value, [
    "id", "project", "kind", "title", "state", "priority", "summary", "nextAction",
    "owner", "createdAt", "updatedAt", "actionableAt", "latestEvidenceAt",
    "attentionReason", "reviewState", "blockedFanOut", "links",
  ], "work-stack record");
  const record: WorkStackRecordInput = {
    id: boundedIdentity(value.id, "record id"),
    project: lowercaseSlug(value.project, "record project"),
    kind: enumValue(value.kind, itemKinds, "record kind"),
    title: boundedText(value.title, 1, 240, "record title"),
    state: enumValue(value.state, states, "record state"),
    priority: boundedInteger(value.priority, 0, 100, "record priority"),
    summary: nullableText(value.summary, 1_000, "record summary"),
    nextAction: nullableText(value.nextAction, 500, "record next action"),
    owner: nullableText(value.owner, 160, "record owner"),
    createdAt: canonicalTimestamp(value.createdAt, "record createdAt"),
    updatedAt: canonicalTimestamp(value.updatedAt, "record updatedAt"),
    actionableAt: value.actionableAt === null
      ? null
      : canonicalTimestamp(value.actionableAt, "record actionableAt"),
    latestEvidenceAt: value.latestEvidenceAt === null
      ? null
      : canonicalTimestamp(value.latestEvidenceAt, "record latestEvidenceAt"),
    attentionReason: value.attentionReason === null
      ? null
      : enumValue(value.attentionReason, attentionReasons, "attention reason"),
    reviewState: enumValue(value.reviewState, reviewStates, "review state"),
    blockedFanOut: boundedInteger(value.blockedFanOut, 0, 10_000, "blocked fan-out"),
    links: denseDataArray(
      value.links,
      WORK_STACK_LIMITS.maxLinksPerRecord,
      "record links",
    ).map(admitLink).sort(compareLinks),
  };
  if (record.project !== project) {
    throw new TypeError("Record project does not match projection project");
  }
  const createdMs = Date.parse(record.createdAt);
  const updatedMs = Date.parse(record.updatedAt);
  if (createdMs > updatedMs || updatedMs > observedMs) {
    throw new TypeError("Record timestamps are outside the observed snapshot");
  }
  for (const [label, timestamp] of [
    ["actionableAt", record.actionableAt],
    ["latestEvidenceAt", record.latestEvidenceAt],
  ] as const) {
    if (timestamp !== null) {
      const timestampValue = Date.parse(timestamp);
      if (timestampValue < createdMs || timestampValue > observedMs) {
        throw new TypeError(`Record ${label} is outside the observed snapshot`);
      }
    }
  }
  if (record.reviewState === "actionable" && record.actionableAt === null) {
    throw new TypeError("Actionable review records require actionableAt");
  }
  if (record.attentionReason !== null) {
    if (record.actionableAt === null) {
      throw new TypeError("Attention records require actionableAt");
    }
    if (record.nextAction === null) {
      throw new TypeError("Attention records require a next action");
    }
  }
  requireUnique(record.links.map((link) => link.identity), "record link identity");
  return record;
}

function admitLink(value: WorkStackLinkInput): WorkStackLinkInput {
  requirePlainObject(value, ["kind", "identity", "href", "label"], "work-stack link");
  return {
    kind: enumValue(value.kind, linkKinds, "link kind"),
    identity: boundedIdentity(value.identity, "link identity"),
    href: admitHref(value.href),
    label: boundedText(value.label, 1, 160, "link label"),
  };
}

function compareLinks(left: WorkStackLinkInput, right: WorkStackLinkInput): number {
  return compareCodeUnits(left.kind, right.kind)
    || compareCodeUnits(left.identity, right.identity)
    || compareCodeUnits(left.href, right.href)
    || compareCodeUnits(left.label, right.label);
}

function admitHref(value: unknown): string {
  const href = boundedText(value, 1, 2_048, "link href");
  try {
    if (href.startsWith("/")) {
      if (href.startsWith("//") || href.includes("\\")) {
        throw new TypeError("invalid root-relative link");
      }
      const parsed = new URL(href, "https://stensibly.invalid");
      if (parsed.origin !== "https://stensibly.invalid") {
        throw new TypeError("invalid root-relative link");
      }
      return href;
    }
    const parsed = new URL(href);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname.length === 0
      || parsed.username !== ""
      || parsed.password !== ""
    ) {
      throw new TypeError("invalid HTTPS link");
    }
    return href;
  } catch {
    throw new TypeError(
      "Link href must be credential-free HTTPS or a root-relative path",
    );
  }
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
