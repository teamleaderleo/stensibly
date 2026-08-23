import type {
  GitHubMailPublicObservationConsumeResult,
  GitHubMailPublicObservationInput,
} from "./github-mail-public-observation-consumer.js";
import {
  crossSourceGitHubObservationFingerprint,
  mapPublicGitHubRepositoryEvent,
  type PublicGitHubRepositoryObservation,
} from "./github-public-repository-observation.js";
import type {
  GitHubPublicEventsClient,
  GitHubPublicEventsPollResult,
} from "./github-public-events-client.js";
import type {
  AnyGitHubRepositoryObservation,
} from "./github-repository-observation-any-admission.js";
import type {
  HostedGitHubRepositoryObservationRecord,
} from "./github-repository-observation-convex.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export interface GitHubPublicObservationLedger {
  ingestRepositoryObservation(input: {
    deliveryId: string;
    eventType: string;
    payloadDigest: string;
    receivedAt: string;
    observation: AnyGitHubRepositoryObservation;
  }): Promise<Readonly<{ duplicate: boolean }>>;
  listRecentRepositoryObservations(
    repository: string,
    limit?: number,
  ): Promise<readonly HostedGitHubRepositoryObservationRecord[]>;
}

export interface GitHubPublicObservationMailConsumer<Result> {
  consume(
    input: GitHubMailPublicObservationInput,
  ): Promise<GitHubMailPublicObservationConsumeResult<Result>>;
}

export interface GitHubPublicRepositoryObserverOptions<Result> {
  readonly repository: string;
  readonly client: Pick<GitHubPublicEventsClient, "poll">;
  readonly ledger: GitHubPublicObservationLedger;
  readonly mail: GitHubPublicObservationMailConsumer<Result>;
  readonly recentLimit?: number;
}

export type GitHubPublicRepositoryObserverResult = Readonly<{
  status: GitHubPublicEventsPollResult["status"] | "reconciled";
  repository: string;
  fetchedEvents: number;
  supportedEvents: number;
  persistedEvents: number;
  replayedEvents: number;
  crossSourceSuppressed: number;
  published: number;
  quiet: number;
  ignored: number;
}>;

/**
 * Scheduled fallback reconciler. Provider fetch happens once; each supported
 * event is durably admitted before mail projection. Exact public replays may
 * re-enter the idempotent mail publisher so a crash between persistence and
 * delivery can recover on a later conditional cache miss.
 */
export class GitHubPublicRepositoryObserver<Result> {
  readonly #repository: string;
  readonly #client: Pick<GitHubPublicEventsClient, "poll">;
  readonly #ledger: GitHubPublicObservationLedger;
  readonly #mail: GitHubPublicObservationMailConsumer<Result>;
  readonly #recentLimit: number;

  constructor(options: GitHubPublicRepositoryObserverOptions<Result>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("GitHub public repository observer options are required");
    }
    this.#repository = normalizeGitHubRepository(options.repository);
    this.#client = options.client;
    this.#ledger = options.ledger;
    this.#mail = options.mail;
    this.#recentLimit = boundedInteger(
      options.recentLimit ?? 100,
      "GitHub public observer recent limit",
      1,
      100,
    );
  }

  async reconcile(): Promise<GitHubPublicRepositoryObserverResult> {
    const poll = await this.#client.poll();
    if (poll.status !== "events") {
      return result(this.#repository, poll.status);
    }

    const recent = await this.#ledger.listRecentRepositoryObservations(
      this.#repository,
      this.#recentLimit,
    );
    const seenObservationIds = new Set(
      recent.map((row) => row.observation.observationId),
    );
    const crossSourceFingerprints = new Set(
      recent
        .filter((row) => row.observation.sourceSchema === "github-webhook")
        .filter((row) => supportedObservation(row.observation))
        .map((row) => crossSourceGitHubObservationFingerprint(row.observation)),
    );

    let supportedEvents = 0;
    let persistedEvents = 0;
    let replayedEvents = 0;
    let crossSourceSuppressed = 0;
    let published = 0;
    let quiet = 0;
    let ignored = 0;

    // GitHub returns newest first. Reconcile oldest first so lifecycle mail
    // converges in provider order within the bounded page.
    for (const event of [...poll.events].reverse()) {
      const mapped = mapPublicGitHubRepositoryEvent(
        event,
        this.#repository,
        poll.polledAt,
      );
      if (mapped === null) continue;
      supportedEvents += 1;
      const observation = mapped.observation;
      const crossFingerprint = crossSourceGitHubObservationFingerprint(observation);
      if (crossSourceFingerprints.has(crossFingerprint)) {
        crossSourceSuppressed += 1;
        continue;
      }

      const ingestion = await this.#ledger.ingestRepositoryObservation({
        deliveryId: observation.deliveryId,
        eventType: observation.eventType,
        payloadDigest: observation.payloadDigest,
        receivedAt: observation.receivedAt,
        observation,
      });
      if (ingestion.duplicate || seenObservationIds.has(observation.observationId)) {
        replayedEvents += 1;
      } else {
        persistedEvents += 1;
      }
      seenObservationIds.add(observation.observationId);

      const mail = await this.#mail.consume({
        observation,
        currentHeadRevision: mapped.currentHeadRevision,
      });
      if (mail.status === "published") published += 1;
      else if (mail.status === "quiet") quiet += 1;
      else ignored += 1;
    }

    return Object.freeze({
      status: "reconciled",
      repository: this.#repository,
      fetchedEvents: poll.events.length,
      supportedEvents,
      persistedEvents,
      replayedEvents,
      crossSourceSuppressed,
      published,
      quiet,
      ignored,
    });
  }
}

function supportedObservation(
  observation: AnyGitHubRepositoryObservation,
): observation is PublicGitHubRepositoryObservation | AnyGitHubRepositoryObservation {
  return observation.eventType === "pull_request"
    || observation.eventType === "pull_request_review";
}

function result(
  repository: string,
  status: "deferred" | "not_modified",
): GitHubPublicRepositoryObserverResult {
  return Object.freeze({
    status,
    repository,
    fetchedEvents: 0,
    supportedEvents: 0,
    persistedEvents: 0,
    replayedEvents: 0,
    crossSourceSuppressed: 0,
    published: 0,
    quiet: 0,
    ignored: 0,
  });
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
