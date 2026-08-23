import {
  type GitHubPublicEventsPollState,
  type GitHubPublicEventsPollStateStore,
} from "./github-public-events-client.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

/**
 * First-slice ETag cache for one Worker isolate. Durable event identity remains
 * in Convex; losing this cache can cause one extra conditional-less read after
 * an isolate restart, never duplicate mail or repository effects.
 */
export class InMemoryGitHubPublicEventsPollStateStore
implements GitHubPublicEventsPollStateStore {
  readonly #states = new Map<string, GitHubPublicEventsPollState>();
  readonly #maximumRepositories: number;

  constructor(maximumRepositories = 8) {
    if (!Number.isSafeInteger(maximumRepositories) || maximumRepositories < 1 || maximumRepositories > 100) {
      throw new RangeError("GitHub public Events poll-state capacity must be 1-100");
    }
    this.#maximumRepositories = maximumRepositories;
  }

  async getPollState(repository: string): Promise<GitHubPublicEventsPollState | null> {
    const key = normalizeGitHubRepository(repository);
    const state = this.#states.get(key);
    return state ? Object.freeze({ ...state }) : null;
  }

  async putPollState(state: GitHubPublicEventsPollState): Promise<GitHubPublicEventsPollState> {
    const key = normalizeGitHubRepository(state.repository);
    if (this.#states.has(key)) this.#states.delete(key);
    while (this.#states.size >= this.#maximumRepositories) {
      const oldest = this.#states.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#states.delete(oldest);
    }
    const exact = Object.freeze({ ...state, repository: key });
    this.#states.set(key, exact);
    return exact;
  }
}

export const sharedGitHubPublicEventsPollState =
  new InMemoryGitHubPublicEventsPollStateStore();
