import { sha256, stableJson } from "./canonical-json.js";
import {
  exactMailDisplayText,
  exactMailThreadIdentifier,
  exactMailThreadSha256,
  freezeMailThreadRecord,
  type MailThreadRecord,
  type MailThreadState,
} from "./mail-thread-contract.js";

export interface MailSourceReference {
  label: string;
  reference: string;
}

export interface MailOutboundEnvelopeInput {
  thread: MailThreadRecord;
  sourceFingerprint: string;
  whatChanged: string;
  attentionReason: string;
  nextAction: string;
  sourceObject: string;
  sourceRevision?: string | null;
  blocker?: string | null;
  resolutionCondition: string;
  threadState: MailThreadState;
  references?: readonly MailSourceReference[];
}

export interface MailOutboundEnvelope {
  version: 1;
  threadId: string;
  handle: string;
  subject: string;
  body: string;
  launchLine: string;
  sourceFingerprint: string;
  materialFingerprint: string;
  sourceObject: string;
  sourceRevision: string | null;
  resolutionCondition: string;
  threadState: MailThreadState;
  containsSecrets: false;
}

interface AdmittedEnvelopeSemantics {
  version: 1;
  threadId: string;
  handle: string;
  workspace: string;
  project: string;
  threadClass: string;
  canonicalSubject: string;
  sourceIdentity: string;
  sourceFingerprint: string;
  whatChanged: string;
  attentionReason: string;
  nextAction: string;
  sourceObject: string;
  sourceRevision: string | null;
  blocker: string | null;
  resolutionCondition: string;
  threadState: MailThreadState;
  references: readonly MailSourceReference[];
}

const maxBodyBytes = 12 * 1024;

export function renderMailOutboundEnvelope(
  input: MailOutboundEnvelopeInput,
): MailOutboundEnvelope {
  const thread = freezeMailThreadRecord(input.thread);
  const semantics = admitEnvelopeSemantics(input, thread);
  const materialFingerprint = sha256(stableJson(semantics));
  const launchLine = `Continue ${thread.handle}.`;
  const subject = `[${thread.handle}] ${thread.canonicalSubject}`;
  const body = renderBody(semantics, launchLine);
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
    throw new RangeError("Mail outbound body exceeds the bounded first-slice size");
  }
  return Object.freeze({
    version: 1,
    threadId: thread.threadId,
    handle: thread.handle,
    subject,
    body,
    launchLine,
    sourceFingerprint: semantics.sourceFingerprint,
    materialFingerprint,
    sourceObject: semantics.sourceObject,
    sourceRevision: semantics.sourceRevision,
    resolutionCondition: semantics.resolutionCondition,
    threadState: semantics.threadState,
    containsSecrets: false,
  });
}

export function fingerprintMailOutboundSemantics(
  input: MailOutboundEnvelopeInput,
): string {
  const thread = freezeMailThreadRecord(input.thread);
  return sha256(stableJson(admitEnvelopeSemantics(input, thread)));
}

function admitEnvelopeSemantics(
  input: MailOutboundEnvelopeInput,
  thread: MailThreadRecord,
): AdmittedEnvelopeSemantics {
  const threadState = exactThreadState(input.threadState);
  const resolutionCondition = exactMailDisplayText(
    input.resolutionCondition,
    "Outbound mail resolution condition",
    800,
  );
  const references = admitReferences(input.references ?? []);
  return Object.freeze({
    version: 1,
    threadId: thread.threadId,
    handle: thread.handle,
    workspace: thread.workspace,
    project: thread.project,
    threadClass: thread.threadClass,
    canonicalSubject: thread.canonicalSubject,
    sourceIdentity: thread.sourceIdentity,
    sourceFingerprint: exactMailThreadSha256(
      input.sourceFingerprint,
      "Outbound mail source fingerprint",
    ),
    whatChanged: exactMailDisplayText(
      input.whatChanged,
      "Outbound mail change summary",
      1600,
    ),
    attentionReason: exactMailDisplayText(
      input.attentionReason,
      "Outbound mail attention reason",
      1200,
    ),
    nextAction: exactMailDisplayText(
      input.nextAction,
      "Outbound mail next action",
      1200,
    ),
    sourceObject: exactMailThreadIdentifier(
      input.sourceObject,
      "Outbound mail source object",
      480,
    ),
    sourceRevision: input.sourceRevision === undefined || input.sourceRevision === null
      ? null
      : exactMailThreadIdentifier(
          input.sourceRevision,
          "Outbound mail source revision",
          240,
        ),
    blocker: input.blocker === undefined || input.blocker === null
      ? null
      : exactMailDisplayText(input.blocker, "Outbound mail blocker", 1200),
    resolutionCondition,
    threadState,
    references,
  });
}

function renderBody(
  semantics: AdmittedEnvelopeSemantics,
  launchLine: string,
): string {
  const lines = [
    "What changed",
    semantics.whatChanged,
    "",
    "Why this reached attention",
    semantics.attentionReason,
    "",
    "Next",
    semantics.nextAction,
    "",
    `Handle: ${semantics.handle}`,
    `Project: ${semantics.project}`,
    `Subject: ${semantics.sourceObject}`,
  ];
  if (semantics.sourceRevision !== null) lines.push(`Revision: ${semantics.sourceRevision}`);
  if (semantics.blocker !== null) lines.push(`Blocker: ${semantics.blocker}`);
  lines.push(
    `Resolution: ${semantics.resolutionCondition}`,
    "",
    launchLine,
  );
  if (semantics.references.length > 0) {
    lines.push("", "Sources");
    for (const reference of semantics.references) {
      lines.push(`- ${reference.label}: ${reference.reference}`);
    }
  }
  return lines.join("\n");
}

function admitReferences(
  input: readonly MailSourceReference[],
): readonly MailSourceReference[] {
  if (!Array.isArray(input) || input.length > 8) {
    throw new TypeError("Outbound mail source references are invalid");
  }
  const seen = new Set<string>();
  const admitted = input.map((reference) => {
    if (
      typeof reference !== "object"
      || reference === null
      || Array.isArray(reference)
      || Object.getPrototypeOf(reference) !== Object.prototype
    ) {
      throw new TypeError("Outbound mail source reference is invalid");
    }
    const label = exactMailDisplayText(
      reference.label,
      "Outbound mail source reference label",
      80,
    );
    const value = exactReference(reference.reference);
    const key = `${label}\u0000${value}`;
    if (seen.has(key)) throw new TypeError("Outbound mail source references contain a duplicate");
    seen.add(key);
    return Object.freeze({ label, reference: value });
  });
  return Object.freeze(admitted);
}

function exactReference(value: unknown): string {
  return exactMailDisplayText(value, "Outbound mail source reference", 800);
}

function exactThreadState(value: unknown): MailThreadState {
  if (value === "open" || value === "quiet" || value === "resolved" || value === "superseded") {
    return value;
  }
  throw new TypeError("Outbound mail thread state is invalid");
}
