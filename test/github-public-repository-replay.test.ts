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
  row: {
    id: string;
    observation: AnyGitHubRepositoryObservation;
    mailProjectionState: "pending" | "baseline_suppressed" | "projected" | null;
    createdAt: string;
  } | null = null;
  canonical: string | null = null;
  receivedAt: string | null = null;
  marks = 0;

  async ingestRepositoryObservation(input: {
    deliveryId: string;
    eventType: string;
    payloadDigest: string;
    receivedAt: string;
    observation: AnyGitHubRepositoryObservation;
  }, projection?: { readonly mailProjectionState?: "pending" | "baseline_suppressed" }) {
    const canonical = canonicalJsonString(input.observation);
    if (this.row === null) {
      this.canonical = canonical;
      this.receivedAt = input.receivedAt;
      this.row = {
        id: "public-row-782",
        observation: input.observation,
        mailProjectionState: projection?.mailProjectionState ?? null,
        createdAt: "2026-08-23T04:01:00.000Z",
      };
      return { duplicate: false };
    }
    if (this.canonical === null || this.receivedAt === null) {
      throw new Error("exact replay ledger lost its retained identity");
    }
    expect(canonical).toBe(this.canonical);
    expect(input.receivedAt).toBe(this.receivedAt);
    return { duplicate: true };
  }

  async markRepositoryObservationMailProjected(input: {
    observationId: string;
  }) {
    this.marks += 1;
    if (!this.row || this.row.observation.observationId !== input.observationId) {
      throw new Error("GITHUB_REPOSITORY_MAIL_PROJECTION_MISSING");
    }
    if (this.row.mailProjectionState !== "pending") {
      throw new Error("GITHUB_REPOSITORY_MAIL_PROJECTION_CONFLICT");
    }
    this.row.mailProjectionState = "projected";
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
        async consume() {
          throw new Error("baseline/replay without eligibility stays quiet");
        },
      },
    });

    expect(await observer.reconcile()).toMatchObject({
      persistedEvents: 1,
      baselinedEvents: 1,
    });
    expect(ledger.row?.mailProjectionState).toBe("baseline_suppressed");
    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 1,
    });
    expect(ledger.receivedAt).toBe("2026-08-23T04:00:00.000Z");
  });

  test("a crash between durable ingest and thread reservation still converges to one mail projection", async () => {
    const ledger = new ExactReplayLedger();
    let poll = 0;
    let consumeCalls = 0;
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
            initial: false,
            events: [providerEvent()],
            async acknowledge() {},
          };
        },
      },
      ledger,
      mail: {
        async consume() {
          consumeCalls += 1;
          if (consumeCalls === 1) {
            throw new Error("simulated crash before thread reservation");
          }
          return {
            status: "published" as const,
            sourceObservationId: "github-public:pull_request:public-event:30001",
            materialFingerprint: `sha256:${"6".repeat(64)}`,
            threadId: "mail_thread_782",
            handle: "STN-REVIEW:R782",
            result: {},
          };
        },
      },
    });

    await expect(observer.reconcile()).rejects.toThrow(
      "simulated crash before thread reservation",
    );
    expect(ledger.row?.mailProjectionState).toBe("pending");

    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 0,
      published: 1,
    });
    expect(consumeCalls).toBe(2);
    expect(ledger.row?.mailProjectionState).toBe("projected");
    expect(ledger.marks).toBe(1);

    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 1,
      published: 0,
    });
    expect(consumeCalls).toBe(2);
  });
});
