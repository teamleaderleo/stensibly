import { parseToken } from "./token-provider.js";

const DEFAULT_ENDPOINT = "https://api.stensibly.com";
const APPROVED_ENDPOINTS = new Set([
  DEFAULT_ENDPOINT,
  "https://stensibly-api.leoli-082000.workers.dev",
]);
const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u;
const DELIVERY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TOKEN_PATTERN = /stn\.tok_[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}/gu;

export interface VerifyGitHubObservationReadbackOptions {
  endpoint: string;
  token: string;
  repository: string;
  revision: string;
  limit?: number;
  timeoutMs?: number;
}

export interface ParsedVerifyGitHubObservationReadbackArgs {
  help: boolean;
  options?: VerifyGitHubObservationReadbackOptions;
}

export interface GitHubObservationReadbackReceipt {
  readonly repository: string;
  readonly revision: string;
  readonly observationId: string;
  readonly deliveryId: string;
  readonly semanticFingerprint: string;
  readonly receivedAt: string;
  readonly createdAt: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function parseVerifyGitHubObservationReadbackArgs(
  rawArgs: string[],
  env: Record<string, string | undefined> = process.env,
): ParsedVerifyGitHubObservationReadbackArgs {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
  let endpoint = env.STENSIBLY_ENDPOINT ?? DEFAULT_ENDPOINT;
  let token = env.STENSIBLY_TOKEN ?? "";
  let repository = env.STENSIBLY_GITHUB_REPOSITORY ?? env.GITHUB_REPOSITORY ?? "";
  let revision = env.STENSIBLY_GITHUB_REVISION ?? env.TARGET_REVISION ?? "";
  let limit = DEFAULT_LIMIT;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--endpoint") {
      endpoint = requireValue(args, ++index, "--endpoint");
      continue;
    }
    if (argument === "--token") {
      token = requireValue(args, ++index, "--token");
      continue;
    }
    if (argument === "--repository") {
      repository = requireValue(args, ++index, "--repository");
      continue;
    }
    if (argument === "--revision") {
      revision = requireValue(args, ++index, "--revision");
      continue;
    }
    if (argument === "--limit") {
      limit = parseLimit(requireValue(args, ++index, "--limit"));
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  // Protected environment values may carry one shell newline. Token trimming is
  // deliberate and stays separate from exact public endpoint and identity admission.
  const normalizedToken = token.trim();
  if (!parseToken(normalizedToken)) {
    throw new Error("A generated Stensibly read token is required");
  }

  return {
    help: false,
    options: {
      endpoint: admitEndpoint(endpoint),
      token: normalizedToken,
      repository: admitRepository(repository),
      revision: admitRevision(revision),
      limit,
    },
  };
}

export async function verifyGitHubObservationReadback(
  options: VerifyGitHubObservationReadbackOptions,
  fetchImpl: FetchLike = fetch,
): Promise<GitHubObservationReadbackReceipt> {
  // See the parser note above: token whitespace is an environment transport concern,
  // while endpoint and GitHub identities preserve exact caller bytes.
  const token = options.token.trim();
  if (!parseToken(token)) {
    throw new Error("A generated Stensibly read token is required");
  }
  const endpoint = admitEndpoint(options.endpoint);
  const repository = admitRepository(options.repository);
  const revision = admitRevision(options.revision);
  const limit = parseLimit(String(options.limit ?? DEFAULT_LIMIT));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("timeoutMs must be an integer between 100 and 60000");
  }

  const url = new URL("/api/v1/github/repository-observations", `${endpoint}/`);
  url.searchParams.set("repository", repository);
  url.searchParams.set("limit", String(limit));
  const response = await request(fetchImpl, url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      Authorization: `Bearer ${token}`,
    },
    redirect: "error",
  }, timeoutMs);

  if (response.redirected || response.url !== url.toString()) {
    await cancelResponseBody(response);
    throw new Error("Hosted observation readback returned from an unexpected URL");
  }
  if (response.status !== 200) {
    await cancelResponseBody(response);
    throw new Error(`Hosted observation readback returned HTTP ${response.status}`);
  }

  const body = await readBoundedJson(response);
  if (!isRecord(body) || !hasExactKeys(body, ["observations"])) {
    throw new Error("Hosted observation readback returned a noncanonical envelope");
  }
  if (!Array.isArray(body.observations) || body.observations.length > limit) {
    throw new Error("Hosted observation readback returned an invalid row set");
  }

  for (const raw of body.observations) {
    const receipt = matchingReceipt(raw, repository, revision);
    if (receipt) return Object.freeze(receipt);
  }
  throw new Error(
    `No signed push observation for ${repository}@${revision} was found in the latest ${limit} rows`,
  );
}

export function formatGitHubObservationReadbackReceipt(
  receipt: GitHubObservationReadbackReceipt,
): string {
  return [
    "[PASS] hosted GitHub observation readback",
    `repository=${receipt.repository}`,
    `revision=${receipt.revision}`,
    `observationId=${receipt.observationId}`,
    `deliveryId=${receipt.deliveryId}`,
    `semanticFingerprint=${receipt.semanticFingerprint}`,
    `receivedAt=${receipt.receivedAt}`,
    `createdAt=${receipt.createdAt}`,
  ].join(" ");
}

export function redactGitHubObservationVerifierSecrets(
  value: unknown,
  token?: string,
): string {
  let output = value instanceof Error ? value.message : String(value);
  if (token) output = output.split(token).join("[REDACTED]");
  return output.replace(TOKEN_PATTERN, "[REDACTED]");
}

export function githubObservationReadbackUsage(): string {
  return `Stensibly hosted GitHub observation readback verifier

Usage:
  STENSIBLY_TOKEN=stn.tok_… bun src/verify-github-observation-readback.ts -- \\
    --repository owner/repository --revision 40-character-sha [options]

Options:
  --endpoint URL          Reviewed API origin (default: ${DEFAULT_ENDPOINT})
  --token TOKEN           Read token; STENSIBLY_TOKEN is preferred
  --repository OWNER/REPO Exact lowercase GitHub repository
  --revision SHA          Exact lowercase 40-character Git revision
  --limit NUMBER          Recent rows to inspect, 1-100 (default: ${DEFAULT_LIMIT})
  -h, --help              Show this help

Environment aliases:
  STENSIBLY_ENDPOINT
  STENSIBLY_TOKEN
  STENSIBLY_GITHUB_REPOSITORY or GITHUB_REPOSITORY
  STENSIBLY_GITHUB_REVISION or TARGET_REVISION

The verifier is read-only, sends the token only to a reviewed Stensibly origin, and never prints the token or observation content.`;
}

function matchingReceipt(
  value: unknown,
  repository: string,
  revision: string,
): GitHubObservationReadbackReceipt | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "observation", "createdAt"])) {
    throw new Error("Hosted observation readback returned a noncanonical row");
  }
  const createdAt = exactTimestamp(value.createdAt, "observation creation time");
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 200) {
    throw new Error("Hosted observation readback returned an invalid row identity");
  }
  const observation = value.observation;
  if (!isRecord(observation)) {
    throw new Error("Hosted observation readback returned an invalid observation");
  }
  if (
    observation.provider !== "github"
    || observation.repository !== repository
    || observation.containsRawContent !== false
    || observation.eventType !== "push"
  ) return null;
  if (!isRecord(observation.relationships)) {
    throw new Error("Hosted push observation is missing relationships");
  }
  if (observation.relationships.revision !== revision) return null;

  const observationId = boundedIdentity(
    observation.observationId,
    "observation identity",
  );
  const deliveryId = boundedIdentity(observation.deliveryId, "delivery identity");
  if (!DELIVERY_PATTERN.test(deliveryId)) {
    throw new Error("Hosted push observation has an invalid delivery identity");
  }
  if (observationId !== `github:push:${deliveryId}`) {
    throw new Error("Hosted push observation has an inconsistent observation identity");
  }
  const semanticFingerprint = observation.semanticFingerprint;
  if (typeof semanticFingerprint !== "string" || !HASH_PATTERN.test(semanticFingerprint)) {
    throw new Error("Hosted push observation has an invalid semantic fingerprint");
  }
  const receivedAt = exactTimestamp(
    observation.receivedAt,
    "observation receipt time",
  );
  return {
    repository,
    revision,
    observationId,
    deliveryId,
    semanticFingerprint,
    receivedAt,
    createdAt,
  };
}

async function request(
  fetchImpl: FetchLike,
  input: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw new Error("Hosted observation readback request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  let declaredLength: number | null;
  try {
    declaredLength = admitContentLength(response.headers.get("content-length"));
  } catch (error) {
    await cancelResponseBody(response);
    throw error;
  }
  if (declaredLength !== null && declaredLength > MAXIMUM_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new Error("Hosted observation readback response exceeded 1 MiB");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    if (declaredLength !== null && declaredLength !== 0) {
      throw new Error("Hosted observation readback response length did not match its declaration");
    }
    return null;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read().catch(async () => {
        await cancelReader(reader);
        throw new Error("Hosted observation readback response stream failed");
      });
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        await cancelReader(reader);
        throw new Error("Hosted observation readback returned an invalid byte stream");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
        await cancelReader(reader);
        throw new Error("Hosted observation readback response exceeded 1 MiB");
      }
      chunks.push(result.value.slice());
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== null && declaredLength !== totalBytes) {
    throw new Error("Hosted observation readback response length did not match its declaration");
  }
  if (totalBytes === 0) return null;

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Hosted observation readback returned invalid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Hosted observation readback returned invalid JSON");
  }
}

function admitContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Hosted observation readback returned an invalid Content-Length");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new Error("Hosted observation readback returned an invalid Content-Length");
  }
  return length;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body || response.body.locked) return;
  try {
    await response.body.cancel();
  } catch {
    // Cancellation is best-effort after a fixed verifier decision.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort after a fixed verifier decision.
  }
}

function admitEndpoint(value: string): string {
  if (value !== value.trim() || !APPROVED_ENDPOINTS.has(value)) {
    throw new Error("endpoint must be an exact reviewed Stensibly HTTPS origin");
  }
  return value;
}

function admitRepository(value: string): string {
  if (value !== value.trim() || !REPOSITORY_PATTERN.test(value)) {
    throw new Error("repository must be an exact lowercase owner/name identity");
  }
  return value;
}

function admitRevision(value: string): string {
  if (value !== value.trim() || !SHA_PATTERN.test(value)) {
    throw new Error("revision must be an exact lowercase 40-character Git SHA");
  }
  return value;
}

function parseLimit(value: string): number {
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/u.test(value)) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return Number(value);
}

function boundedIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240) {
    throw new Error(`Hosted push observation has an invalid ${label}`);
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Hosted observation has an invalid ${label}`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`Hosted observation has an invalid ${label}`);
  }
  return value;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const canonical = [...expected].sort(codeUnitCompare);
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  let token: string | undefined;
  try {
    const parsed = parseVerifyGitHubObservationReadbackArgs(Bun.argv.slice(2));
    if (parsed.help) {
      console.log(githubObservationReadbackUsage());
    } else if (parsed.options) {
      token = parsed.options.token;
      const receipt = await verifyGitHubObservationReadback(parsed.options);
      console.log(formatGitHubObservationReadbackReceipt(receipt));
    }
  } catch (error) {
    console.error(redactGitHubObservationVerifierSecrets(error, token));
    process.exitCode = 1;
  }
}
