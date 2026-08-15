import { sha256 } from "./canonical-json.js";

export const MAX_SEMANTIC_GMAIL_MESSAGE_BYTES = 64 * 1024;
export const MAX_SEMANTIC_GMAIL_CURRENT_REPLY_BYTES = 16 * 1024;
export const MAX_SEMANTIC_GMAIL_QUOTED_BYTES = 48 * 1024;
export const MAX_SEMANTIC_GMAIL_HEADERS = 64;
export const MAX_SEMANTIC_GMAIL_HEADER_VALUE_BYTES = 4 * 1024;
export const MAX_SEMANTIC_GMAIL_TOTAL_HEADER_BYTES = 16 * 1024;
export const MAX_SEMANTIC_GMAIL_MIME_PARTS = 64;
export const MAX_SEMANTIC_GMAIL_MIME_DEPTH = 8;

const stnHandlePattern = /\bSTN-(?:HANDOFF|REVIEW|DECISION|INCIDENT):[A-Z0-9]{4,32}\b/giu;
const credentialShapedPattern = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/iu;
const unsafeControlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

export type AdmittedGmailMessageDisposition =
  | "direct_human_reply"
  | "automatic"
  | "bounce"
  | "forwarded";

export interface AdmittedGmailSemanticMessage {
  readonly version: 1;
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly rfcMessageId: string;
  readonly inReplyToRfcMessageId: string;
  readonly currentReply: string;
  readonly currentReplySha256: string;
  readonly currentReplyByteLength: number;
  readonly quotedAncestrySha256: string | null;
  readonly quotedAncestryByteLength: number;
  readonly messageContentFingerprint: string;
  readonly visibleFromSha256: string | null;
  readonly recipientCount: number;
  readonly currentHandleCount: number;
  readonly quotedHandleCount: number;
  readonly messageDisposition: AdmittedGmailMessageDisposition;
  readonly containsCredentialShapedCurrentReply: boolean;
  readonly attachmentCount: 0;
  readonly containsRawMessage: false;
  readonly humanIdentityEstablished: false;
}

export function admitGmailSemanticMessage(
  input: unknown,
  expected: {
    providerMessageId: string;
    providerThreadId: string;
    expectedInReplyToRfcMessageId: string;
  },
): AdmittedGmailSemanticMessage {
  const message = record(input, "Gmail semantic message");
  const providerMessageId = providerId(message.id, "Gmail semantic message ID");
  const providerThreadId = providerId(message.threadId, "Gmail semantic thread ID");
  if (
    providerMessageId !== providerId(expected.providerMessageId, "Expected Gmail message ID")
    || providerThreadId !== providerId(expected.providerThreadId, "Expected Gmail thread ID")
  ) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_PROVIDER_IDENTITY_MISMATCH");
  }

  const payload = record(message.payload, "Gmail semantic MIME payload");
  const headers = admitHeaders(payload.headers);
  const rfcMessageId = exactRfcMessageId(requiredHeader(headers, "message-id"), "Gmail Message-ID");
  const inReplyToRfcMessageId = exactRfcMessageId(
    requiredHeader(headers, "in-reply-to"),
    "Gmail In-Reply-To",
  );
  if (
    inReplyToRfcMessageId
      !== exactRfcMessageId(expected.expectedInReplyToRfcMessageId, "Expected Gmail In-Reply-To")
  ) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_ANCESTRY_MISMATCH");
  }

  const textBody = extractSinglePlainText(payload);
  const canonicalBody = textBody.replace(/\r\n?/gu, "\n");
  const totalBodyBytes = utf8Bytes(canonicalBody);
  if (totalBodyBytes < 1 || totalBodyBytes > MAX_SEMANTIC_GMAIL_MESSAGE_BYTES) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_BODY_BOUNDS");
  }
  if (unsafeControlPattern.test(canonicalBody)) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_BODY_CONTROL_BYTES");
  }

  const split = splitCurrentReplyFromAncestry(canonicalBody);
  const currentReply = split.current.trim();
  const quotedAncestry = split.ancestry.trim();
  const currentReplyByteLength = utf8Bytes(currentReply);
  const quotedAncestryByteLength = utf8Bytes(quotedAncestry);
  if (
    currentReplyByteLength < 1
    || currentReplyByteLength > MAX_SEMANTIC_GMAIL_CURRENT_REPLY_BYTES
    || quotedAncestryByteLength > MAX_SEMANTIC_GMAIL_QUOTED_BYTES
  ) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_REPLY_BOUNDS");
  }

  const automatic = automaticResponseEvidence(headers);
  const bounce = bounceEvidence(headers, payload);
  const messageDisposition: AdmittedGmailMessageDisposition = bounce
    ? "bounce"
    : automatic
      ? "automatic"
      : split.forwarded
        ? "forwarded"
        : "direct_human_reply";
  const visibleFrom = optionalHeader(headers, "from");
  const recipients = recipientCount(headers);
  const currentReplySha256 = sha256(currentReply);
  const quotedAncestrySha256 = quotedAncestry
    ? sha256(quotedAncestry)
    : null;
  const messageContentFingerprint = sha256(JSON.stringify({
    version: 1,
    providerMessageId,
    providerThreadId,
    rfcMessageId,
    inReplyToRfcMessageId,
    currentReplySha256,
    currentReplyByteLength,
    quotedAncestrySha256,
    quotedAncestryByteLength,
    visibleFromSha256: visibleFrom ? sha256(visibleFrom) : null,
    recipientCount: recipients,
    messageDisposition,
  }));

  return Object.freeze({
    version: 1 as const,
    providerMessageId,
    providerThreadId,
    rfcMessageId,
    inReplyToRfcMessageId,
    currentReply,
    currentReplySha256,
    currentReplyByteLength,
    quotedAncestrySha256,
    quotedAncestryByteLength,
    messageContentFingerprint,
    visibleFromSha256: visibleFrom ? sha256(visibleFrom) : null,
    recipientCount: recipients,
    currentHandleCount: countHandles(currentReply),
    quotedHandleCount: countHandles(quotedAncestry),
    messageDisposition,
    containsCredentialShapedCurrentReply: credentialShapedPattern.test(currentReply),
    attachmentCount: 0 as const,
    containsRawMessage: false as const,
    humanIdentityEstablished: false as const,
  });
}

interface HeaderMap {
  readonly values: ReadonlyMap<string, readonly string[]>;
}

function admitHeaders(input: unknown): HeaderMap {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SEMANTIC_GMAIL_HEADERS) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_HEADER_COUNT");
  }
  const values = new Map<string, string[]>();
  let totalBytes = 0;
  for (const entry of input) {
    const header = record(entry, "Gmail semantic header");
    const name = headerName(header.name);
    const value = headerValue(header.value);
    totalBytes += utf8Bytes(name) + utf8Bytes(value);
    if (totalBytes > MAX_SEMANTIC_GMAIL_TOTAL_HEADER_BYTES) {
      throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_HEADER_BYTES");
    }
    const prior = values.get(name) ?? [];
    if (prior.length >= 8) {
      throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_HEADER_DUPLICATES");
    }
    prior.push(value);
    values.set(name, prior);
  }
  const frozen = new Map<string, readonly string[]>();
  for (const [name, entries] of values) frozen.set(name, Object.freeze([...entries]));
  return Object.freeze({ values: frozen });
}

function extractSinglePlainText(payload: Record<string, unknown>): string {
  const state = { parts: 0, plain: [] as string[] };
  visitMimePart(payload, 0, state);
  if (state.plain.length !== 1) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_PLAIN_TEXT_AMBIGUOUS");
  }
  return state.plain[0]!;
}

function visitMimePart(
  part: Record<string, unknown>,
  depth: number,
  state: { parts: number; plain: string[] },
): void {
  state.parts += 1;
  if (depth > MAX_SEMANTIC_GMAIL_MIME_DEPTH || state.parts > MAX_SEMANTIC_GMAIL_MIME_PARTS) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_MIME_BOUNDS");
  }
  const mimeType = optionalText(part.mimeType, "Gmail MIME type", 160)?.toLowerCase() ?? "";
  const filename = optionalText(part.filename, "Gmail MIME filename", 512) ?? "";
  const body = part.body === undefined
    ? {}
    : record(part.body, "Gmail MIME body");
  const attachmentId = optionalText(body.attachmentId, "Gmail attachment ID", 1_024);
  if (filename || attachmentId) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_ATTACHMENTS_EXCLUDED");
  }

  const parts = part.parts;
  if (Array.isArray(parts)) {
    if (parts.length > MAX_SEMANTIC_GMAIL_MIME_PARTS) {
      throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_MIME_BOUNDS");
    }
    for (const child of parts) {
      visitMimePart(record(child, "Gmail MIME child"), depth + 1, state);
    }
  } else if (parts !== undefined) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_MIME_PARTS_INVALID");
  }

  const data = optionalText(body.data, "Gmail MIME body data", 128 * 1024);
  if (mimeType === "text/plain") {
    if (!data) throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_PLAIN_TEXT_MISSING");
    const decoded = decodeBase64Url(data);
    if (utf8Bytes(decoded) > MAX_SEMANTIC_GMAIL_MESSAGE_BYTES) {
      throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_BODY_BOUNDS");
    }
    state.plain.push(decoded);
    return;
  }
  if (
    data
    && mimeType
    && mimeType !== "text/html"
    && !mimeType.startsWith("multipart/")
  ) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_UNSUPPORTED_MIME_CONTENT");
  }
}

function splitCurrentReplyFromAncestry(body: string): {
  current: string;
  ancestry: string;
  forwarded: boolean;
} {
  const lines = body.split("\n");
  let boundary = lines.length;
  let forwarded = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (
      /^>{1,}/u.test(trimmed)
      || /^On .+ wrote:$/iu.test(trimmed)
      || /^-{2,}\s*Forwarded message\s*-{2,}$/iu.test(trimmed)
      || /^Begin forwarded message:$/iu.test(trimmed)
      || trimmed === "--- STENSIBLY CURRENT HANDOFF END ---"
      || outlookForwardBoundary(lines, index)
    ) {
      boundary = index;
      if (
        /forwarded message/iu.test(trimmed)
        || /^Begin forwarded message:$/iu.test(trimmed)
        || outlookForwardBoundary(lines, index)
      ) forwarded = true;
      break;
    }
  }
  return {
    current: lines.slice(0, boundary).join("\n"),
    ancestry: lines.slice(boundary).join("\n"),
    forwarded,
  };
}

function outlookForwardBoundary(lines: readonly string[], index: number): boolean {
  const line = lines[index]!.trim();
  if (!/^_{5,}$/u.test(line)) return false;
  const sample = lines.slice(index + 1, Math.min(lines.length, index + 8))
    .map((value) => value.trim().toLowerCase());
  return sample.some((value) => value.startsWith("from:"))
    && sample.some((value) => value.startsWith("to:"))
    && sample.some((value) => value.startsWith("subject:"));
}

function automaticResponseEvidence(headers: HeaderMap): boolean {
  const autoSubmitted = optionalHeader(headers, "auto-submitted")?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  for (const name of ["x-autoreply", "x-autorespond", "x-auto-response-suppress"]) {
    if (optionalHeader(headers, name)) return true;
  }
  const precedence = optionalHeader(headers, "precedence")?.toLowerCase();
  return precedence === "auto_reply" || precedence === "auto-reply";
}

function bounceEvidence(headers: HeaderMap, payload: Record<string, unknown>): boolean {
  const mimeType = optionalText(payload.mimeType, "Gmail MIME type", 160)?.toLowerCase() ?? "";
  if (mimeType === "multipart/report") return true;
  if (optionalHeader(headers, "x-failed-recipients")) return true;
  const subject = optionalHeader(headers, "subject")?.toLowerCase() ?? "";
  return /^(delivery status notification|undeliverable|mail delivery failed|returned mail)/u.test(subject);
}

function recipientCount(headers: HeaderMap): number {
  let count = 0;
  for (const name of ["to", "cc"]) {
    for (const value of headers.values.get(name) ?? []) {
      count += value.split(",").filter((entry) => entry.trim().length > 0).length;
    }
  }
  if (count > 128) throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_RECIPIENT_BOUNDS");
  return count;
}

function countHandles(value: string): number {
  if (!value) return 0;
  return [...value.matchAll(stnHandlePattern)].length;
}

function requiredHeader(headers: HeaderMap, name: string): string {
  const values = headers.values.get(name);
  if (!values || values.length !== 1) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_REQUIRED_HEADER_AMBIGUOUS");
  }
  return values[0]!;
}

function optionalHeader(headers: HeaderMap, name: string): string | null {
  const values = headers.values.get(name);
  if (!values || values.length === 0) return null;
  if (values.length !== 1) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_HEADER_AMBIGUOUS");
  }
  return values[0]!;
}

function exactRfcMessageId(value: unknown, label: string): string {
  const text = exactText(value, label, 320);
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/u.test(text)) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_RFC_MESSAGE_ID_INVALID");
  }
  return text;
}

function providerId(value: unknown, label: string): string {
  const text = exactText(value, label, 1_024);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,1023}$/u.test(text)) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_PROVIDER_ID_INVALID");
  }
  return text;
}

function headerName(value: unknown): string {
  const text = exactText(value, "Gmail header name", 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(text)) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_HEADER_NAME_INVALID");
  }
  return text;
}

function headerValue(value: unknown): string {
  const text = exactText(value, "Gmail header value", MAX_SEMANTIC_GMAIL_HEADER_VALUE_BYTES);
  if (utf8Bytes(text) > MAX_SEMANTIC_GMAIL_HEADER_VALUE_BYTES) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_HEADER_VALUE_BOUNDS");
  }
  return text;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return exactText(value, label, max);
}

function exactText(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || /[\u0000\r\n]/u.test(value)
  ) {
    throw new GmailSemanticMessageAdmissionError(`GMAIL_SEMANTIC_TEXT_INVALID:${label}`);
  }
  return value;
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_BODY_ENCODING_INVALID");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
  } catch {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_BODY_ENCODING_INVALID");
  }
  const decoded = bytes.toString("utf8");
  if (Buffer.from(decoded, "utf8").compare(bytes) !== 0) {
    throw new GmailSemanticMessageAdmissionError("GMAIL_SEMANTIC_BODY_UTF8_INVALID");
  }
  return decoded;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GmailSemanticMessageAdmissionError(`GMAIL_SEMANTIC_RECORD_INVALID:${label}`);
  }
  return value as Record<string, unknown>;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export class GmailSemanticMessageAdmissionError extends Error {
  readonly name = "GmailSemanticMessageAdmissionError";
  constructor(readonly code: string) {
    super(code);
  }
}
