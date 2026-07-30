import { createHmac, timingSafeEqual } from "node:crypto";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
  type GitHubRepositoryObservation,
} from "./github-repository-observation.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";

export const DEFAULT_GITHUB_INGRESS_MAX_BODY_BYTES = 256 * 1_024;

export type GitHubWebhookIngressErrorCode =
  | "invalid_request"
  | "payload_too_large"
  | "unauthorized"
  | "unsupported_media_type";

export class GitHubWebhookIngressError extends Error {
  readonly status: 400 | 401 | 413 | 415;
  readonly code: GitHubWebhookIngressErrorCode;
  readonly detailCode: string | null;
  readonly path: string | null;
  readonly authenticate: boolean;

  constructor(input: {
    status: 400 | 401 | 413 | 415;
    code: GitHubWebhookIngressErrorCode;
    message: string;
    detailCode?: string;
    path?: string;
    authenticate?: boolean;
  }) {
    super(input.message);
    this.name = "GitHubWebhookIngressError";
    this.status = input.status;
    this.code = input.code;
    this.detailCode = input.detailCode ?? null;
    this.path = input.path ?? null;
    this.authenticate = input.authenticate ?? false;
  }
}

export interface GitHubWebhookIngressOptions {
  secret: string;
  expectedRepository?: string;
  maxBodyBytes?: number;
  now?: () => number;
}

export interface PreparedGitHubWebhookDelivery {
  readonly deliveryId: string;
  readonly eventType: string;
  readonly payloadDigest: string;
  readonly bodyByteLength: number;
  readonly receivedAt: string;
  /**
   * Verified provider JSON for immediate in-process consumers. This property is
   * deliberately non-enumerable so receipts and ordinary JSON logging omit it.
   */
  readonly payload: unknown;
  readonly observation: GitHubRepositoryObservation | null;
  readonly signatureAlgorithm: "hmac-sha256";
  readonly payloadAvailability: "memory_only";
  readonly containsRawBody: false;
}

export type GitHubWebhookIngress = (
  request: Request,
) => Promise<PreparedGitHubWebhookDelivery>;

interface NormalizedOptions {
  secret: string;
  expectedRepository?: string;
  maxBodyBytes: number;
  now: () => number;
}

const deliveryPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const eventTypePattern = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Creates one reusable request compiler for GitHub webhook routes.
 *
 * The compiler consumes the request body once, verifies the signature against the
 * original bytes before decoding, parses bounded strict JSON, and returns an
 * immutable in-memory delivery. Raw body bytes are discarded before return.
 */
export function createGitHubWebhookIngress(
  options: GitHubWebhookIngressOptions,
): GitHubWebhookIngress {
  const normalized = normalizeOptions(options);
  return async (request) => prepareRequest(request, normalized);
}

async function prepareRequest(
  request: Request,
  options: NormalizedOptions,
): Promise<PreparedGitHubWebhookDelivery> {
  const deliveryId = boundedHeader(
    request.headers.get("X-GitHub-Delivery"),
    deliveryPattern,
    "X-GitHub-Delivery must be a bounded delivery identity",
  );
  const eventType = boundedHeader(
    request.headers.get("X-GitHub-Event"),
    eventTypePattern,
    "X-GitHub-Event must be a bounded event type",
  );
  const contentType = request.headers.get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new GitHubWebhookIngressError({
      status: 415,
      code: "unsupported_media_type",
      message: "GitHub webhook content type must be application/json",
    });
  }

  const receivedAt = canonicalReceiptTime(options.now());
  const body = await readBoundedBody(request, options.maxBodyBytes);
  verifySignature(
    options.secret,
    body,
    request.headers.get("X-Hub-Signature-256"),
  );

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new GitHubWebhookIngressError({
      status: 400,
      code: "invalid_request",
      message: "GitHub webhook body must be valid UTF-8 JSON",
      detailCode: "GITHUB_WEBHOOK_INVALID_UTF8",
    });
  }

  let payload: unknown;
  try {
    payload = parseStrictJson(text, {
      maxBytes: options.maxBodyBytes,
      maxDepth: 32,
      maxStringLength: options.maxBodyBytes,
      maxObjectKeys: 512,
      maxArrayLength: 2_048,
      prefix: "GITHUB_WEBHOOK_JSON",
    });
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new GitHubWebhookIngressError({
        status: 400,
        code: "invalid_request",
        message: "GitHub webhook body must be bounded strict JSON",
        detailCode: error.code,
        path: error.path,
      });
    }
    throw error;
  }

  const frozenPayload = deepFreeze(payload);
  const payloadDigest = digestGitHubWebhookPayload(body);
  let observation: GitHubRepositoryObservation | null;
  try {
    observation = mapGitHubRepositoryWebhook({
      eventType,
      deliveryId,
      payloadDigest,
      payload: frozenPayload,
      signatureVerified: true,
      receivedAt,
      ...(options.expectedRepository
        ? { expectedRepository: options.expectedRepository }
        : {}),
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new GitHubWebhookIngressError({
        status: 400,
        code: "invalid_request",
        message: "GitHub webhook payload is invalid",
        detailCode: "GITHUB_WEBHOOK_INVALID_PAYLOAD",
      });
    }
    throw error;
  }

  const prepared = {
    deliveryId,
    eventType,
    payloadDigest,
    bodyByteLength: body.byteLength,
    receivedAt,
    observation,
    signatureAlgorithm: "hmac-sha256" as const,
    payloadAvailability: "memory_only" as const,
    containsRawBody: false as const,
  } as PreparedGitHubWebhookDelivery;
  Object.defineProperty(prepared, "payload", {
    value: frozenPayload,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return deepFreeze(prepared);
}

function normalizeOptions(options: GitHubWebhookIngressOptions): NormalizedOptions {
  if (typeof options.secret !== "string") {
    throw new RangeError("GitHub webhook secret must be text");
  }
  const secretBytes = Buffer.byteLength(options.secret, "utf8");
  if (secretBytes < 16 || secretBytes > 1_024) {
    throw new RangeError(
      "GitHub webhook secret must contain between 16 and 1024 UTF-8 bytes",
    );
  }
  const maxBodyBytes = options.maxBodyBytes
    ?? DEFAULT_GITHUB_INGRESS_MAX_BODY_BYTES;
  if (
    !Number.isInteger(maxBodyBytes)
    || maxBodyBytes < 1_024
    || maxBodyBytes > 1_024 * 1_024
  ) {
    throw new RangeError(
      "GitHub webhook body bound must be between 1024 and 1048576 bytes",
    );
  }
  const expectedRepository = options.expectedRepository === undefined
    ? undefined
    : normalizeGitHubRepository(options.expectedRepository);
  return {
    secret: options.secret,
    ...(expectedRepository ? { expectedRepository } : {}),
    maxBodyBytes,
    now: options.now ?? Date.now,
  };
}

function boundedHeader(
  value: string | null,
  pattern: RegExp,
  message: string,
): string {
  if (!value || !pattern.test(value)) {
    throw new GitHubWebhookIngressError({
      status: 400,
      code: "invalid_request",
      message,
    });
  }
  return value;
}

function canonicalReceiptTime(value: number): string {
  if (!Number.isFinite(value)) {
    throw new GitHubWebhookIngressError({
      status: 400,
      code: "invalid_request",
      message: "GitHub webhook receipt time is invalid",
      detailCode: "GITHUB_WEBHOOK_INVALID_RECEIPT_TIME",
    });
  }
  try {
    return new Date(value).toISOString();
  } catch {
    throw new GitHubWebhookIngressError({
      status: 400,
      code: "invalid_request",
      message: "GitHub webhook receipt time is invalid",
      detailCode: "GITHUB_WEBHOOK_INVALID_RECEIPT_TIME",
    });
  }
}

async function readBoundedBody(
  request: Request,
  maxBodyBytes: number,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isInteger(parsedLength) || parsedLength < 0) {
      throw new GitHubWebhookIngressError({
        status: 400,
        code: "invalid_request",
        message: "Content-Length must be a non-negative integer",
      });
    }
    if (parsedLength > maxBodyBytes) throw payloadTooLarge();
  }
  if (request.bodyUsed) throw bodyReadFailed();

  const stream = request.body;
  if (!stream) return new Uint8Array(0);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    throw bodyReadFailed();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBodyBytes) {
        try {
          await reader.cancel("GitHub webhook body exceeds the configured bound");
        } catch {
          // The stream may already be closed or errored.
        }
        throw payloadTooLarge();
      }
      chunks.push(result.value.slice());
    }
  } catch (error) {
    if (error instanceof GitHubWebhookIngressError) throw error;
    try {
      await reader.cancel("GitHub webhook body could not be read");
    } catch {
      // The stream may already be closed or errored.
    }
    throw bodyReadFailed();
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function payloadTooLarge(): GitHubWebhookIngressError {
  return new GitHubWebhookIngressError({
    status: 413,
    code: "payload_too_large",
    message: "GitHub webhook body exceeds the configured bound",
  });
}

function bodyReadFailed(): GitHubWebhookIngressError {
  return new GitHubWebhookIngressError({
    status: 400,
    code: "invalid_request",
    message: "GitHub webhook body could not be read",
    detailCode: "GITHUB_WEBHOOK_BODY_READ_FAILED",
  });
}

function verifySignature(
  secret: string,
  body: Uint8Array,
  signature: string | null,
): void {
  const match = /^sha256=([0-9a-f]{64})$/iu.exec(signature ?? "");
  if (!match?.[1]) throw invalidSignature();
  const supplied = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw invalidSignature();
  }
}

function invalidSignature(): GitHubWebhookIngressError {
  return new GitHubWebhookIngressError({
    status: 401,
    code: "unauthorized",
    message: "GitHub webhook signature is invalid",
    detailCode: "GITHUB_WEBHOOK_INVALID_SIGNATURE",
    authenticate: true,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
