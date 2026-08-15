import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import type { MailSemanticAdmissionEvidence } from "./mail-semantic-admission.js";

const keys = [
  "version", "admissionId", "admissionFingerprint", "sourceObservationId",
  "sourceObservationFingerprint", "provider", "mailboxBindingId",
  "providerMessageId", "providerThreadId", "threadId", "handle", "project",
  "replyClass", "semantic", "replyId", "replyFingerprint", "bodySha256",
  "bodyByteLength", "messageContentFingerprint", "quotedAncestrySha256",
  "quotedAncestryByteLength", "visibleFromSha256", "recipientCount",
  "currentHandleCount", "quotedHandleCount", "messageDisposition",
  "effectCapability", "authorityFingerprint", "effect", "effectRequestSuppressed",
  "containsCredentialShapedCurrentReply", "humanIdentityEstablished",
  "grantsAuthority", "grantsResponsibility", "grantsApproval",
  "providerDispatchAuthorized", "containsRawMailBody", "containsQuotedMailBody",
  "attachmentsAdmitted",
] as const;

const replyClasses = new Set([
  "mail.note", "mail.handoff", "mail.review_finding", "mail.answer",
  "mail.acknowledgement", "mail.github_comment_proposal", "mail.github_review_proposal",
]);
const semantics = new Set([
  "private_coordination", "conversation_comment_proposal", "formal_review_proposal",
]);
const dispositions = new Set(["direct_human_reply", "automatic", "bounce", "forwarded"]);
const capabilities = new Set([
  "coordination_only", "github_conversation_comment", "github_formal_review",
]);

export function admitMailSemanticAdmissionEvidenceJson(value: unknown): MailSemanticAdmissionEvidence {
  if (typeof value !== "string" || value.length < 2 || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new RangeError("Mail semantic admission JSON is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RangeError("Mail semantic admission JSON is invalid");
  }
  return admitMailSemanticAdmissionEvidence(parsed);
}

export function admitMailSemanticAdmissionEvidence(value: unknown): MailSemanticAdmissionEvidence {
  const source = exactRecord(value, keys, "Mail semantic admission evidence");
  if (source.version !== 1 || source.provider !== "gmail") {
    throw new RangeError("Mail semantic admission version/provider is invalid");
  }
  for (const field of [
    "humanIdentityEstablished", "grantsAuthority", "grantsResponsibility",
    "grantsApproval", "providerDispatchAuthorized", "containsRawMailBody",
    "containsQuotedMailBody", "attachmentsAdmitted",
  ] as const) {
    if (source[field] !== false) {
      throw new RangeError(`Mail semantic admission ${field} must remain false`);
    }
  }
  if (
    typeof source.effectRequestSuppressed !== "boolean"
    || typeof source.containsCredentialShapedCurrentReply !== "boolean"
  ) {
    throw new RangeError("Mail semantic admission boolean evidence is invalid");
  }

  const replyClass = closed(source.replyClass, replyClasses, "Mail reply class");
  const semantic = closed(source.semantic, semantics, "Mail semantic class");
  const messageDisposition = closed(source.messageDisposition, dispositions, "Mail message disposition");
  const effectCapability = closed(source.effectCapability, capabilities, "Mail effect capability");
  const effect = effectValue(source.effect);
  if (
    (semantic === "private_coordination" && effect !== null)
    || (semantic === "conversation_comment_proposal"
      && (!effect || effect.kind !== "github_conversation_comment"))
    || (semantic === "formal_review_proposal"
      && (!effect || effect.kind !== "github_formal_review"))
  ) {
    throw new RangeError("Mail semantic admission effect disagrees with its semantic class");
  }
  if (source.effectRequestSuppressed === true && (replyClass !== "mail.note" || effect !== null)) {
    throw new RangeError("Suppressed mail effect must remain a private note");
  }

  const admitted = {
    version: 1 as const,
    admissionId: identity(source.admissionId, "Mail semantic admission ID", 256),
    sourceObservationId: identity(source.sourceObservationId, "Mail source observation ID", 512),
    sourceObservationFingerprint: sha(source.sourceObservationFingerprint, "Mail source observation fingerprint"),
    provider: "gmail" as const,
    mailboxBindingId: identity(source.mailboxBindingId, "Mail mailbox binding ID", 240),
    providerMessageId: identity(source.providerMessageId, "Mail provider message ID", 1_024),
    providerThreadId: identity(source.providerThreadId, "Mail provider thread ID", 1_024),
    threadId: identity(source.threadId, "Mail canonical thread ID", 240),
    handle: identity(source.handle, "Mail canonical handle", 80),
    project: identity(source.project, "Mail project", 120),
    replyClass,
    semantic,
    replyId: identity(source.replyId, "Mail reply ID", 256),
    replyFingerprint: sha(source.replyFingerprint, "Mail reply fingerprint"),
    bodySha256: sha(source.bodySha256, "Mail current body fingerprint"),
    bodyByteLength: integer(source.bodyByteLength, 1, 16 * 1024, "Mail current body bytes"),
    messageContentFingerprint: sha(source.messageContentFingerprint, "Mail provider content fingerprint"),
    quotedAncestrySha256: source.quotedAncestrySha256 === null
      ? null
      : sha(source.quotedAncestrySha256, "Mail quoted ancestry fingerprint"),
    quotedAncestryByteLength: integer(
      source.quotedAncestryByteLength,
      0,
      48 * 1024,
      "Mail quoted ancestry bytes",
    ),
    visibleFromSha256: source.visibleFromSha256 === null
      ? null
      : sha(source.visibleFromSha256, "Mail visible From fingerprint"),
    recipientCount: integer(source.recipientCount, 0, 128, "Mail recipient count"),
    currentHandleCount: integer(source.currentHandleCount, 0, 256, "Mail current handle count"),
    quotedHandleCount: integer(source.quotedHandleCount, 0, 256, "Mail quoted handle count"),
    messageDisposition,
    effectCapability,
    authorityFingerprint: sha(source.authorityFingerprint, "Mail trusted binding fingerprint"),
    effect,
    effectRequestSuppressed: source.effectRequestSuppressed,
    containsCredentialShapedCurrentReply: source.containsCredentialShapedCurrentReply,
    humanIdentityEstablished: false as const,
    grantsAuthority: false as const,
    grantsResponsibility: false as const,
    grantsApproval: false as const,
    providerDispatchAuthorized: false as const,
    containsRawMailBody: false as const,
    containsQuotedMailBody: false as const,
    attachmentsAdmitted: false as const,
  };
  if ((admitted.quotedAncestrySha256 === null) !== (admitted.quotedAncestryByteLength === 0)) {
    throw new RangeError("Mail quoted ancestry fingerprint and bytes disagree");
  }
  const admissionFingerprint = sha(source.admissionFingerprint, "Mail semantic admission fingerprint");
  if (admissionFingerprint !== fingerprintCanonicalRequest(admitted)) {
    throw new RangeError("Mail semantic admission fingerprint is invalid");
  }
  return Object.freeze({ ...admitted, admissionFingerprint }) as MailSemanticAdmissionEvidence;
}

function effectValue(value: unknown): MailSemanticAdmissionEvidence["effect"] {
  if (value === null) return null;
  const effect = record(value, "Mail semantic effect");
  if (effect.kind !== "github_conversation_comment" && effect.kind !== "github_formal_review") {
    throw new RangeError("Mail semantic effect kind is invalid");
  }
  if (forbidden(effect, new WeakSet<object>(), 0)) {
    throw new RangeError("Mail semantic effect contains raw/authority-bearing content");
  }
  if (Buffer.byteLength(JSON.stringify(effect), "utf8") > 24 * 1024) {
    throw new RangeError("Mail semantic effect is oversized");
  }
  return Object.freeze(structuredClone(effect)) as unknown as MailSemanticAdmissionEvidence["effect"];
}

function forbidden(value: unknown, seen: WeakSet<object>, depth: number): boolean {
  if (depth > 12) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.length > 64 || value.some((entry) => forbidden(entry, seen, depth + 1));
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (
        normalized === "body"
        || normalized.includes("token")
        || normalized.includes("secret")
        || normalized.includes("credential")
        || normalized === "authorization"
      ) return true;
      if (forbidden(child, seen, depth + 1)) return true;
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  expectedKeys: K,
  label: string,
): Record<K[number], unknown> {
  const source = record(value, label);
  const actual = Object.keys(source).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RangeError(`${label} has noncanonical fields`);
  }
  return source as Record<K[number], unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function identity(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function closed<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T;
}
