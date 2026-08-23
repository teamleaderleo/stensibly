import { normalizeGitHubRepository } from "./github-provider-validation.js";

export interface GitHubPublicEventsPollState {
  readonly repository: string;
  readonly etag: string | null;
  readonly nextEligibleAt: string;
  readonly lastPolledAt: string | null;
}

export interface GitHubPublicEventsPollStateStore {
  getPollState(repository: string): Promise<GitHubPublicEventsPollState | null>;
  putPollState(state: GitHubPublicEventsPollState): Promise<GitHubPublicEventsPollState>;
}

export type GitHubPublicEventsPollResult =
  | Readonly<{
      status: "deferred";
      repository: string;
      nextEligibleAt: string;
    }>
  | Readonly<{
      status: "not_modified";
      repository: string;
      polledAt: string;
      nextEligibleAt: string;
    }>
  | Readonly<{
      status: "events";
      repository: string;
      polledAt: string;
      nextEligibleAt: string;
      events: readonly unknown[];
    }>;

export interface GitHubPublicEventsClientOptions {
  readonly repository: string;
  readonly stateStore: GitHubPublicEventsPollStateStore;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
  readonly now?: () => number;
  readonly pageSize?: number;
  readonly maximumBodyBytes?: number;
}

export class GitHubPublicEventsProviderError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GitHubPublicEventsProviderError";
    this.status = status;
  }
}

const defaultApiBaseUrl = "https://api.github.com";
const defaultPageSize = 30;
const defaultMaximumBodyBytes = 2 * 1024 * 1024;
const minimumPollSeconds = 60;
const maximumPollSeconds = 24 * 60 * 60;

/**
 * One bounded unauthenticated read of GitHub's public repository Events API.
 * State is external so ETag and next-eligible time survive Worker isolates.
 */
export class GitHubPublicEventsClient {
  readonly #repository: string;
  readonly #stateStore: GitHubPublicEventsPollStateStore;
  readonly #fetch: typeof fetch;
  readonly #apiBaseUrl: string;
  readonly #now: () => number;
  readonly #pageSize: number;
  readonly #maximumBodyBytes: number;

  constructor(options: GitHubPublicEventsClientOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("GitHub public Events client options are required");
    }
    this.#repository = normalizeGitHubRepository(options.repository);
    this.#stateStore = options.stateStore;
    if (!this.#stateStore) {
      throw new TypeError("GitHub public Events poll-state store is required");
    }
    this.#fetch = options.fetch ?? fetch;
    this.#apiBaseUrl = exactApiBaseUrl(options.apiBaseUrl ?? defaultApiBaseUrl);
    this.#now = options.now ?? (() => Date.now());
    this.#pageSize = boundedInteger(
      options.pageSize ?? defaultPageSize,
      "GitHub public Events page size",
      1,
      100,
    );
    this.#maximumBodyBytes = boundedInteger(
      options.maximumBodyBytes ?? defaultMaximumBodyBytes,
      "GitHub public Events maximum body bytes",
      1024,
      8 * 1024 * 1024,
    );
  }

  async poll(): Promise<GitHubPublicEventsPollResult> {
    const now = exactTime(this.#now(), "GitHub public Events current time");
    const previous = await this.#stateStore.getPollState(this.#repository);
    if (previous !== null) assertExactStateRepository(previous, this.#repository);
    if (previous !== null && Date.parse(previous.nextEligibleAt) > now) {
      return Object.freeze({
        status: "deferred",
        repository: this.#repository,
        nextEligibleAt: previous.nextEligibleAt,
      });
    }

    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Stensibly-Public-Repository-Observer/1",
    });
    if (previous?.etag) headers.set("If-None-Match", previous.etag);

    let response: Response;
    try {
      response = await this.#fetch(this.#eventsUrl(), {
        method: "GET",
        headers,
        redirect: "error",
      });
    } catch {
      throw new GitHubPublicEventsProviderError("GitHub public Events request failed");
    }

    const polledAt = new Date(now).toISOString();
    const nextEligibleAt = new Date(
      now + pollDelayMilliseconds(response.headers),
    ).toISOString();
    const responseEtag = canonicalEtag(response.headers.get("etag"));
    const etag = responseEtag ?? previous?.etag ?? null;

    if (response.status === 304) {
      await this.#stateStore.putPollState({
        repository: this.#repository,
        etag,
        nextEligibleAt,
        lastPolledAt: polledAt,
      });
      return Object.freeze({
        status: "not_modified",
        repository: this.#repository,
        polledAt,
        nextEligibleAt,
      });
    }

    if (response.status !== 200) {
      const retryAt = retryEligibleAt(response.headers, now) ?? nextEligibleAt;
      await this.#stateStore.putPollState({
        repository: this.#repository,
        etag: previous?.etag ?? null,
        nextEligibleAt: retryAt,
        lastPolledAt: polledAt,
      });
      throw new GitHubPublicEventsProviderError(
        `GitHub public Events request returned HTTP ${response.status}`,
        response.status,
      );
    }

    const bytes = await readBoundedResponse(response, this.#maximumBodyBytes);
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new GitHubPublicEventsProviderError("GitHub public Events response was invalid JSON");
    }
    if (!Array.isArray(decoded) || decoded.length > this.#pageSize) {
      throw new GitHubPublicEventsProviderError("GitHub public Events response exceeded the bounded page");
    }
    const events = Object.freeze([...decoded]);
    await this.#stateStore.putPollState({
      repository: this.#repository,
      etag,
      nextEligibleAt,
      lastPolledAt: polledAt,
    });
    return Object.freeze({
      status: "events",
      repository: this.#repository,
      polledAt,
      nextEligibleAt,
      events,
    });
  }

  #eventsUrl(): string {
    const [owner, repository] = this.#repository.split("/");
    return `${this.#apiBaseUrl}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}/events?per_page=${this.#pageSize}`;
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new GitHubPublicEventsProviderError("GitHub public Events response was oversized");
    }
  }
  if (response.bodyUsed || !response.body) {
    throw new GitHubPublicEventsProviderError("GitHub public Events response body was unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        try {
          await reader.cancel("GitHub public Events response exceeded the configured bound");
        } catch {
          // The provider stream may already be closed.
        }
        throw new GitHubPublicEventsProviderError("GitHub public Events response was oversized");
      }
      chunks.push(next.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function pollDelayMilliseconds(headers: Headers): number {
  const seconds = boundedHeaderSeconds(
    headers.get("x-poll-interval"),
    minimumPollSeconds,
  );
  return Math.max(minimumPollSeconds, seconds) * 1000;
}

function retryEligibleAt(headers: Headers, now: number): string | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) return null;
  if (/^[0-9]{1,8}$/u.test(retryAfter)) {
    const seconds = Math.min(maximumPollSeconds, Number(retryAfter));
    return new Date(now + Math.max(minimumPollSeconds, seconds) * 1000).toISOString();
  }
  const parsed = Date.parse(retryAfter);
  return Number.isFinite(parsed) && parsed > now
    ? new Date(Math.min(parsed, now + maximumPollSeconds * 1000)).toISOString()
    : null;
}

function boundedHeaderSeconds(value: string | null, fallback: number): number {
  if (value === null || !/^[0-9]{1,8}$/u.test(value)) return fallback;
  return Math.min(maximumPollSeconds, Number(value));
}

function canonicalEtag(value: string | null): string | null {
  if (value === null) return null;
  if (
    value.length < 1
    || value.length > 1024
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new GitHubPublicEventsProviderError("GitHub public Events ETag was invalid");
  }
  return value;
}

function exactApiBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new RangeError("GitHub public Events API base URL is invalid");
  }
  return url.origin;
}

function exactTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} is invalid`);
  return value;
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be ${minimum}-${maximum}`);
  }
  return value;
}

function assertExactStateRepository(
  state: GitHubPublicEventsPollState,
  repository: string,
): void {
  if (normalizeGitHubRepository(state.repository) !== repository) {
    throw new Error("GitHub public Events poll state belongs to another repository");
  }
  if (!Number.isFinite(Date.parse(state.nextEligibleAt))) {
    throw new Error("GitHub public Events poll state has invalid next eligibility");
  }
  if (state.lastPolledAt !== null && !Number.isFinite(Date.parse(state.lastPolledAt))) {
    throw new Error("GitHub public Events poll state has invalid last poll time");
  }
  canonicalEtag(state.etag);
}
