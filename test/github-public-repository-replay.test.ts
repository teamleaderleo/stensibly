import { describe, expect, test } from "bun:test";
import { canonicalJsonString } from "../src/idempotency-request-fingerprint.ts";
import {
  GitHubPublicRepositoryObserver,
  type GitHubPublicObservationLedger,
} from "../src/github-public-repository-observer.ts";
import type { AnyGitHubRepositoryObservation } from "../src/github-repository-observation-any-admission.ts";

const repository = "Coreys-Quarry/quarry";
const head = "a".repeat(40);
const base = "b".repeat(40);

function providerEvent() {
  return {
    id: "30001",
    type: "PullRequestEvent",
    actor: { login: "teamleaderleo" },
    repo: { name: repository },
    public: true,
    created_at: "2026-08-23T04:00:00Z",
    payload: {
      action: "opened",
      number: 782,
      pull_request: {
        number: 782,
        state: "open",
        draft: false,
        locked: false,
        merged: false,
        updated_at: "2026-08-23T04:00:00Z",
        title: "Replay-stable public observation",
        body: "Same provider event on a later conditional cache miss.",
        head: { sha: head },
        base: { sha: base },
        merge_commit_sha: null,
      },
    },
  };
}

class ExactReplayLedger implements GitHubPublicObservationLedger {
  row: { id: string; observation: AnyGitHubRepositoryObservation; createdAt: string } | null = null;
  canonical: string | null = null;
  receivedAt: string | null = null;

  async ingestRepositoryObservation(input: {
    deliveryId: string;
    eventType: string;
    payloadDigest: string;
    receivedAt: string;
    observation: AnyGitHubRepositoryObservation;
  }) {
    const canonical = canonicalJsonString(input.observation);
    if (this.row === null) {
      this.canonical = canonical;
      this.receivedAt = input.receivedAt;
      this.row = {
        id: "public-row-782",
        observation: input.observation,
        createdAt: "2026-08-23T04:01:00.000Z",
      };
      return { duplicate: false };
    }
    expect(canonical).toBe(this.canonical);
    expect(input.receivedAt).toBe(this.receivedAt);
    return { duplicate: true };
  }

  async listRecentRepositoryObservations() {
    return this.row === null ? [] : [this.row];
  }
}

describe("public GitHub provider-event replay", () => {
  test("the same event remains byte-identical when observed in a later poll", async () => {
    const ledger = new ExactReplayLedger();
    let poll = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: {
        async poll() {
          poll += 1;
          return {
            status: "events" as const,
            repository: "coreys-quarry/quarry",
            polledAt: poll === 1
              ? "2026-08-23T04:01:00.000Z"
              : "2026-08-23T05:01:00.000Z",
            nextEligibleAt: poll === 1
              ? "2026-08-23T04:02:00.000Z"
              : "2026-08-23T05:02:00.000Z",
            initial: poll === 1,
            events: [providerEvent()],
            async acknowledge() {},
          };
        },
      },
      ledger,
      mail: {
        async hasThread() {
          return false;
        },
        async consume() {
          throw new Error("baseline/replay without a thread stays quiet");
        },
      },
    });

    expect(await observer.reconcile()).toMatchObject({
      persistedEvents: 1,
      baselinedEvents: 1,
    });
    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replayWithoutThread: 1,
    });
    expect(ledger.receivedAt).toBe("2026-08-23T04:00:00.000Z");
  });
});
