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

type ProjectionState = "pending" | "baseline_suppressed" | "projected" | null;

class Ledger implements GitHubPublicObservationLedger {
  readonly rows: Array<{
    id: string;
    observation: AnyGitHubRepositoryObservation;
    mailProjectionState: ProjectionState;
    createdAt: string;
  }> = [];
  ingestions = 0;
  marks = 0;

  async ingestRepositoryObservation(input: {
    observation: AnyGitHubRepositoryObservation;
  }, projection?: { readonly mailProjectionState?: "pending" | "baseline_suppressed" }) {
    this.ingestions += 1;
    const existing = this.rows.find((candidate) =>
      candidate.observation.observationId === input.observation.observationId
      && candidate.observation.deliveryId === input.observation.deliveryId
      && candidate.observation.payloadDigest === input.observation.payloadDigest);
    if (existing) {
      // Mirrors the Convex duplicate path: the exact durable row - with its
      // live projection state - is returned to the observer.
      return {
        duplicate: true,
        mailProjectionState: existing.mailProjectionState,
      };
    }
    const mailProjectionState = projection?.mailProjectionState ?? null;
    this.rows.unshift({
      id: `row-${this.ingestions}`,
      observation: input.observation,
      mailProjectionState,
      createdAt: polledAt,
    });
    return { duplicate: false, mailProjectionState };
  }

  async markRepositoryObservationMailProjected(input: {
    observationId: string;
  }) {
    this.marks += 1;
    const row = this.rows.find((candidate) =>
      candidate.observation.observationId === input.observationId);
    if (!row || row.mailProjectionState !== "pending") {
      throw new Error("GITHUB_REPOSITORY_MAIL_PROJECTION_CONFLICT");
    }
    row.mailProjectionState = "projected";
  }

  async listRecentRepositoryObservations() {
    return this.rows;
  }
}

function eventsPage(options: {
  initial?: boolean;
  onAcknowledge?: () => void;
  values?: readonly unknown[];
} = {}) {
  return {
    status: "events" as const,
    repository: "coreys-quarry/quarry",
    polledAt,
    nextEligibleAt: "2026-08-23T04:01:00.000Z",
    initial: options.initial ?? false,
    events: options.values ?? [event()],
    async acknowledge() {
      options.onAcknowledge?.();
    },
  };
}

function eventObservation(): AnyGitHubRepositoryObservation {
  const mapped = mapPublicGitHubRepositoryEvent(event(), repository, polledAt);
  if (!mapped) throw new Error("fixture event must map");
  return mapped.observation;
}

function secondEvent() {
  const first = event("20002");
  return {
    ...first,
    payload: {
      ...first.payload,
      number: 782,
      pull_request: { ...first.payload.pull_request, number: 782 },
    },
  };
}

// A durable row can sit outside the bounded recent window while remaining
// exactly reachable through duplicate ingest; this ledger reproduces that
// split so suppression cannot silently depend on the snapshot.
class OutOfWindowLedger extends Ledger {
  override async listRecentRepositoryObservations() {
    return [];
  }
}

describe("public GitHub repository observer", () => {
  test("persists a supported event before publishing and acknowledging", async () => {
    const order: string[] = [];
    const ledger = new Ledger();
    const originalIngest = ledger.ingestRepositoryObservation.bind(ledger);
    ledger.ingestRepositoryObservation = async (input, projection) => {
      order.push("persist");
      return await originalIngest(input, projection);
    };
    const originalMark = ledger.markRepositoryObservationMailProjected
      .bind(ledger);
    ledger.markRepositoryObservationMailProjected = async (input) => {
      order.push("mark");
      return await originalMark(input);
    };
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: {
        async poll() {
          return eventsPage({ onAcknowledge: () => order.push("ack") });
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
      baselinedEvents: 0,
      replayedEvents: 0,
      published: 1,
    });
    expect(order).toEqual(["persist", "mail", "mark", "ack"]);
    expect(ledger.rows[0]?.mailProjectionState).toBe("projected");
    expect(ledger.marks).toBe(1);
  });

  test("baselines the first public page durably without historical mail", async () => {
    const ledger = new Ledger();
    let mailCalls = 0;
    let acknowledged = false;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: {
        async poll() {
          return eventsPage({
            initial: true,
            onAcknowledge: () => { acknowledged = true; },
          });
        },
      },
      ledger,
      mail: {
        async consume() {
          mailCalls += 1;
          throw new Error("bootstrap must stay quiet");
        },
      },
    });
    expect(await observer.reconcile()).toMatchObject({
      persistedEvents: 1,
      baselinedEvents: 1,
      published: 0,
    });
    expect(mailCalls).toBe(0);
    expect(acknowledged).toBe(true);
    expect(ledger.rows[0]?.mailProjectionState).toBe("baseline_suppressed");
    expect(ledger.marks).toBe(0);
  });

  test("a crash after the durable pending insert retries once and reaches projected", async () => {
    const ledger = new Ledger();
    let consumeCalls = 0;
    let publishes = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: { async poll() { return eventsPage(); } },
      ledger,
      mail: {
        async consume() {
          consumeCalls += 1;
          if (consumeCalls === 1) {
            throw new Error("simulated crash after durable ingest");
          }
          publishes += 1;
          return {
            status: "published" as const,
            sourceObservationId: "github-public:pull_request:public-event:20001",
            materialFingerprint: `sha256:${"5".repeat(64)}`,
            threadId: "mail_thread_781",
            handle: "STN-REVIEW:Q781",
            result: {},
          };
        },
      },
    });

    await expect(observer.reconcile()).rejects.toThrow(
      "simulated crash after durable ingest",
    );
    expect(ledger.rows[0]?.mailProjectionState).toBe("pending");

    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 0,
      published: 1,
    });
    expect(consumeCalls).toBe(2);
    expect(publishes).toBe(1);
    expect(ledger.rows[0]?.mailProjectionState).toBe("projected");
  });

  test("a crash after the delivery effect still converges without a second mail", async () => {
    const ledger = new Ledger();
    let consumeCalls = 0;
    let sends = 0;
    let threadReserved = false;
    let markCalls = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: { async poll() { return eventsPage(); } },
      ledger,
      mail: {
        async consume() {
          consumeCalls += 1;
          if (threadReserved) {
            // Idempotent replay through the existing delivery-effect identity.
            return {
              status: "published" as const,
              sourceObservationId: "github-public:pull_request:public-event:20001",
              materialFingerprint: `sha256:${"5".repeat(64)}`,
              threadId: "mail_thread_781",
              handle: "STN-REVIEW:Q781",
              result: { duplicate: true },
            };
          }
          threadReserved = true;
          sends += 1;
          return {
            status: "published" as const,
            sourceObservationId: "github-public:pull_request:public-event:20001",
            materialFingerprint: `sha256:${"5".repeat(64)}`,
            threadId: "mail_thread_781",
            handle: "STN-REVIEW:Q781",
            result: { duplicate: false },
          };
        },
      },
    });
    const originalMark = ledger.markRepositoryObservationMailProjected
      .bind(ledger);
    ledger.markRepositoryObservationMailProjected = async (input) => {
      markCalls += 1;
      if (markCalls === 1) {
        throw new Error("simulated crash after send before transition");
      }
      return await originalMark(input);
    };

    await expect(observer.reconcile()).rejects.toThrow(
      "simulated crash after send before transition",
    );
    expect(sends).toBe(1);
    expect(ledger.rows[0]?.mailProjectionState).toBe("pending");

    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 0,
      published: 1,
    });
    expect(consumeCalls).toBe(2);
    expect(sends).toBe(1);
    expect(ledger.rows[0]?.mailProjectionState).toBe("projected");

    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 1,
      published: 0,
    });
    expect(consumeCalls).toBe(2);
  });

  test("duplicates of an already projected row are suppressed without consuming", async () => {
    const ledger = new Ledger();
    ledger.rows.unshift({
      id: "row-projected",
      observation: eventObservation(),
      mailProjectionState: "projected",
      createdAt: polledAt,
    });
    let mailCalls = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: { async poll() { return eventsPage(); } },
      ledger,
      mail: {
        async consume() {
          mailCalls += 1;
          throw new Error("projected rows must not re-enter the mail engine");
        },
      },
    });
    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 1,
      published: 0,
    });
    expect(mailCalls).toBe(0);
    expect(ledger.marks).toBe(0);
  });

  test("replays idempotent mail for a pending duplicate and then projects it", async () => {
    const ledger = new Ledger();
    ledger.rows.unshift({
      id: "row-pending",
      observation: eventObservation(),
      mailProjectionState: "pending",
      createdAt: polledAt,
    });
    let mailCalls = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: { async poll() { return eventsPage(); } },
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
    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      quiet: 1,
      replaySuppressed: 0,
    });
    expect(mailCalls).toBe(1);
    expect(ledger.rows[0]?.mailProjectionState).toBe("projected");
  });

  test("an out-of-window pending duplicate retries from the exact ingest result", async () => {
    // Regression for the #1648 crash window: the durable row crashed as
    // `pending` before any mail projection and sits outside the bounded
    // recent snapshot, so only the ingest response knows it is retryable.
    const ledger = new OutOfWindowLedger();
    ledger.rows.unshift({
      id: "row-crashed",
      observation: eventObservation(),
      mailProjectionState: "pending",
      createdAt: polledAt,
    });
    let consumeCalls = 0;
    let publishes = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: { async poll() { return eventsPage(); } },
      ledger,
      mail: {
        async consume() {
          consumeCalls += 1;
          publishes += 1;
          return {
            status: "published" as const,
            sourceObservationId: "github-public:pull_request:public-event:20001",
            materialFingerprint: `sha256:${"7".repeat(64)}`,
            threadId: "mail_thread_781",
            handle: "STN-REVIEW:Q781",
            result: {},
          };
        },
      },
    });

    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 0,
      published: 1,
    });
    expect(consumeCalls).toBe(1);
    expect(publishes).toBe(1);
    expect(ledger.marks).toBe(1);
    expect(ledger.rows[0]?.mailProjectionState).toBe("projected");

    // A later duplicate of the now-projected row is suppressed from the exact
    // durable state without another mail attempt.
    expect(await observer.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 1,
      published: 0,
    });
    expect(consumeCalls).toBe(1);
    expect(ledger.marks).toBe(1);
  });

  test("bootstrap consumes an exact pending duplicate and baselines only new history", async () => {
    const ledger = new OutOfWindowLedger();
    ledger.rows.unshift({
      id: "row-crashed",
      observation: eventObservation(),
      mailProjectionState: "pending",
      createdAt: polledAt,
    });
    let consumeCalls = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: {
        async poll() {
          return eventsPage({
            initial: true,
            values: [secondEvent(), event()],
          });
        },
      },
      ledger,
      mail: {
        async consume() {
          consumeCalls += 1;
          return {
            status: "published" as const,
            sourceObservationId: "github-public:pull_request:public-event:20001",
            materialFingerprint: `sha256:${"8".repeat(64)}`,
            threadId: "mail_thread_781",
            handle: "STN-REVIEW:Q781",
            result: {},
          };
        },
      },
    });

    expect(await observer.reconcile()).toMatchObject({
      supportedEvents: 2,
      persistedEvents: 1,
      baselinedEvents: 1,
      replayedEvents: 1,
      replaySuppressed: 0,
      published: 1,
    });
    expect(consumeCalls).toBe(1);
    expect(ledger.marks).toBe(1);
    expect(
      ledger.rows.find((row) =>
        row.observation.observationId.endsWith("20001")
      )?.mailProjectionState,
    ).toBe("projected");
    expect(
      ledger.rows.find((row) =>
        row.observation.observationId.endsWith("20002")
      )?.mailProjectionState,
    ).toBe("baseline_suppressed");
  });

  test("keeps baseline-suppressed and legacy duplicates permanently quiet", async () => {
    const suppressedLedger = new Ledger();
    suppressedLedger.rows.unshift({
      id: "row-baseline",
      observation: eventObservation(),
      mailProjectionState: "baseline_suppressed",
      createdAt: polledAt,
    });
    let suppressedMailCalls = 0;
    const suppressedObserver = new GitHubPublicRepositoryObserver({
      repository,
      client: { async poll() { return eventsPage(); } },
      ledger: suppressedLedger,
      mail: {
        async consume() {
          suppressedMailCalls += 1;
          throw new Error("baseline-supplied history must stay quiet");
        },
      },
    });
    expect(await suppressedObserver.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 1,
      published: 0,
    });
    expect(suppressedMailCalls).toBe(0);

    const legacyLedger = new Ledger();
    legacyLedger.rows.unshift({
      id: "row-legacy",
      observation: eventObservation(),
      mailProjectionState: null,
      createdAt: polledAt,
    });
    let legacyMailCalls = 0;
    const legacyObserver = new GitHubPublicRepositoryObserver({
      repository,
      client: { async poll() { return eventsPage(); } },
      ledger: legacyLedger,
      mail: {
        async consume() {
          legacyMailCalls += 1;
          throw new Error("legacy rows must stay quiet");
        },
      },
    });
    expect(await legacyObserver.reconcile()).toMatchObject({
      replayedEvents: 1,
      replaySuppressed: 1,
      published: 0,
    });
    expect(legacyMailCalls).toBe(0);
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
    ledger.rows.push({
      id: "webhook-row",
      observation: webhookLike,
      mailProjectionState: null,
      createdAt: polledAt,
    });
    let mailCalls = 0;
    const observer = new GitHubPublicRepositoryObserver({
      repository,
      client: { async poll() { return eventsPage(); } },
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
