import { describe, expect, test } from "bun:test";
import {
  GitHubPublicRepositoryObserver,
  type GitHubPublicObservationLedger,
} from "../src/github-public-repository-observer.ts";
import {
  crossSourceGitHubObservationFingerprint,
  mapPublicGitHubRepositoryEvent,
} from "../src/github-public-repository-observation.ts";
import type { AnyGitHubRepositoryObservation } from "../src/github-repository-observation-any-admission.ts";

const repository = "Coreys-Quarry/quarry";
const head = "a".repeat(40);
const base = "b".repeat(40);
const polledAt = "2026-08-23T04:00:00.000Z";

function event(id = "20001") {
  return {
    id,
    type: "PullRequestEvent",
    actor: { login: "teamleaderleo" },
    repo: { name: repository },
    public: true,
    created_at: "2026-08-23T03:59:00Z",
    payload: {
      action: "opened",
      number: 781,
      pull_request: {
        number: 781,
        state: "open",
        draft: false,
        locked: false,
        merged: false,
        updated_at: "2026-08-23T03:59:00Z",
        title: "Public observer candidate",
        body: "Bounded body",
        head: { sha: head },
        base: { sha: base },
        merge_commit_sha: null,
      },
    },
  };
}

class Ledger implements GitHubPublicObservationLedger {
  readonly rows: Array<{ id: string; observation: AnyGitHubRepositoryObservation; createdAt: string }> = [];
  duplicate = false;
  ingestions = 0;

  async ingestRepositoryObservation(input: {
    observation: AnyGitHubRepositoryObservation;
  }) {
    this.ingestions += 1;
    if (!this.duplicate) {
      this.rows.unshift({
        id: `row-${this.ingestions}`,
        observation: input.observation,
        createdAt: polledAt,
      });
    }
    return { duplicate: this.duplicate };
  }

  async listRecentRepositoryObservations() {
    return this.rows;
  }
}

describe("public GitHub repository observer", () => {
  test("persists a supported event before publishing mail", async () => {
    const order: string[] = [];
    const ledger = new Ledger();
    const originalIngest = ledger.ingestRepositoryObservation.bind(ledger);
    ledger.ingestRepositoryObservation = async (input) => {
      order.push("persist");
      return await originalIngest(input);
    };
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: {
        async poll() {
          return {
            status: "events" as const,
            repository: "coreys-quarry/quarry",
            polledAt,
            nextEligibleAt: "2026-08-23T04:01:00.000Z",
            events: [event()],
          };
        },
      },
      ledger,
      mail: {
        async consume() {
          order.push("mail");
          return {
            status: "published" as const,
            sourceObservationId: "github-public:pull_request:public-event:20001",
            materialFingerprint: `sha256:${"1".repeat(64)}`,
            threadId: "mail_thread_781",
            handle: "STN-REVIEW:Q781",
            result: {},
          };
        },
      },
    });

    expect(await observer.reconcile()).toMatchObject({
      status: "reconciled",
      fetchedEvents: 1,
      supportedEvents: 1,
      persistedEvents: 1,
      replayedEvents: 0,
      published: 1,
    });
    expect(order).toEqual(["persist", "mail"]);
  });

  test("replays idempotent mail after an exact durable public duplicate", async () => {
    const ledger = new Ledger();
    ledger.duplicate = true;
    let mailCalls = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: {
        async poll() {
          return {
            status: "events" as const,
            repository: "coreys-quarry/quarry",
            polledAt,
            nextEligibleAt: "2026-08-23T04:01:00.000Z",
            events: [event()],
          };
        },
      },
      ledger,
      mail: {
        async consume() {
          mailCalls += 1;
          return {
            status: "quiet" as const,
            sourceObservationId: "github-public:pull_request:public-event:20001",
            materialFingerprint: `sha256:${"2".repeat(64)}`,
          };
        },
      },
    });
    expect(await observer.reconcile()).toMatchObject({ replayedEvents: 1, quiet: 1 });
    expect(mailCalls).toBe(1);
  });

  test("suppresses a public event already represented by signed webhook semantics", async () => {
    const ledger = new Ledger();
    const mapped = mapPublicGitHubRepositoryEvent(event(), repository, polledAt)!;
    const webhookLike = {
      ...mapped.observation,
      sourceSchema: "github-webhook",
      observationId: "github:pull_request:webhook-781",
      deliveryId: "webhook-781",
      payloadDigest: `sha256:${"3".repeat(64)}`,
      semanticFingerprint: `sha256:${"4".repeat(64)}`,
    } as unknown as AnyGitHubRepositoryObservation;
    expect(crossSourceGitHubObservationFingerprint(webhookLike))
      .toBe(crossSourceGitHubObservationFingerprint(mapped.observation));
    ledger.rows.push({ id: "webhook-row", observation: webhookLike, createdAt: polledAt });
    let mailCalls = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: {
        async poll() {
          return {
            status: "events" as const,
            repository: "coreys-quarry/quarry",
            polledAt,
            nextEligibleAt: "2026-08-23T04:01:00.000Z",
            events: [event()],
          };
        },
      },
      ledger,
      mail: {
        async consume() {
          mailCalls += 1;
          throw new Error("mail should be suppressed");
        },
      },
    });
    expect(await observer.reconcile()).toMatchObject({
      crossSourceSuppressed: 1,
      persistedEvents: 0,
      published: 0,
    });
    expect(ledger.ingestions).toBe(0);
    expect(mailCalls).toBe(0);
  });

  test("304/deferred results do no ledger or mail work", async () => {
    const ledger = new Ledger();
    let mailCalls = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: {
        async poll() {
          return {
            status: "not_modified" as const,
            repository: "coreys-quarry/quarry",
            polledAt,
            nextEligibleAt: "2026-08-23T04:01:00.000Z",
          };
        },
      },
      ledger,
      mail: {
        async consume() {
          mailCalls += 1;
          throw new Error("mail should stay quiet");
        },
      },
    });
    expect(await observer.reconcile()).toMatchObject({ status: "not_modified", fetchedEvents: 0 });
    expect(ledger.ingestions).toBe(0);
    expect(mailCalls).toBe(0);
  });
});
