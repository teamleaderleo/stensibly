import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import type {
  GitHubPublicEventsPollState,
  GitHubPublicEventsPollStateStore,
} from "./github-public-events-client.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

const getRef = makeFunctionReference<"query">(
  "githubPublicEventsPollState:get",
);
const putRef = makeFunctionReference<"mutation">(
  "githubPublicEventsPollState:put",
);

const maximumEtagBytes = 1024;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;

export class ConvexGitHubPublicEventsPollStateError extends Error {
  constructor(message = "GitHub public Events poll state storage failed") {
    super(message);
    this.name = "ConvexGitHubPublicEventsPollStateError";
  }
}

export interface ConvexGitHubPublicEventsPollStateStoreOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

/**
 * Durable conditional-polling state for one configured public repository.
 * ETag and next-eligible timing survive Worker isolate restarts so the
 * scheduled fallback keeps honouring provider poll intervals instead of
 * re-reading unconditionally after every isolate loss. Event identity and
 * mail dedupe remain owned by the existing observation ledger.
 */
export class ConvexGitHubPublicEventsPollStateStore
implements GitHubPublicEventsPollStateStore {
  readonly #client: ConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: ConvexGitHubPublicEventsPollStateStoreOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("GitHub public Events poll-state store options are required");
    }
    this.#client = options.client;
    if (typeof options.serviceSecret !== "string" || options.serviceSecret.length < 1) {
      throw new TypeError("GitHub public Events poll-state store service secret is required");
    }
    this.#serviceSecret = options.serviceSecret;
    this.#workspace = normalizeWorkspace(options.workspace ?? "default");
  }

  async getPollState(repository: string): Promise<GitHubPublicEventsPollState | null> {
    const canonicalRepository = normalizeGitHubRepository(repository);
    let raw: unknown;
    try {
      raw = await this.#client.query(getRef, {
        serviceSecret: this.#serviceSecret,
        workspace: this.#workspace,
        repository: canonicalRepository,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
    if (raw === null) return null;
    return admitStoredState(raw, canonicalRepository);
  }

  async putPollState(
    state: GitHubPublicEventsPollState,
  ): Promise<GitHubPublicEventsPollState> {
    if (!state || typeof state !== "object") {
      throw new ConvexGitHubPublicEventsPollStateError(
        "GitHub public Events poll state is required",
      );
    }
    const canonicalRepository = normalizeGitHubRepository(state.repository);
    const etag = exactEtag(state.etag);
    const nextEligibleAt = exactMilliseconds(state.nextEligibleAt);
    const lastPolledAt = state.lastPolledAt === null
      ? null
      : exactMilliseconds(state.lastPolledAt);
    let stored: unknown;
    try {
      stored = await this.#client.mutation(putRef, {
        serviceSecret: this.#serviceSecret,
        workspace: this.#workspace,
        repository: canonicalRepository,
        etag,
        nextEligibleAt,
        lastPolledAt,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
    return admitStoredState(stored, canonicalRepository);
  }
}

function admitStoredState(
  value: unknown,
  repository: string,
): GitHubPublicEventsPollState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConvexGitHubPublicEventsPollStateError();
  }
  const record = value as Record<string, unknown>;
  if (record.repository !== repository) {
    throw new ConvexGitHubPublicEventsPollStateError();
  }
  return Object.freeze({
    repository,
    etag: exactEtag(record.etag),
    nextEligibleAt: isoTimestamp(record.nextEligibleAt),
    lastPolledAt: record.lastPolledAt === null
      ? null
      : isoTimestamp(record.lastPolledAt),
  });
}

function exactEtag(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || new TextEncoder().encode(value).byteLength > maximumEtagBytes
    || controlCharacterPattern.test(value)
  ) {
    throw new ConvexGitHubPublicEventsPollStateError(
      "GitHub public Events ETag is invalid",
    );
  }
  return value;
}

function exactMilliseconds(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConvexGitHubPublicEventsPollStateError(
      "GitHub public Events poll time is invalid",
    );
  }
  return parsed;
}

function isoTimestamp(value: unknown): string {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new ConvexGitHubPublicEventsPollStateError();
  }
  return new Date(value).toISOString();
}

function normalizeWorkspace(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9-_]{0,79}$/u.test(value)) {
    throw new Error(
      "Workspace must be an exact lowercase slug up to 80 characters",
    );
  }
  return value;
}

function mapStorageError(error: unknown): ConvexGitHubPublicEventsPollStateError {
  if (error instanceof ConvexGitHubPublicEventsPollStateError) {
    return error;
  }
  return new ConvexGitHubPublicEventsPollStateError();
}
