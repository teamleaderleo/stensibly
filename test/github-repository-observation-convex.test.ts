import { describe, expect, test } from "bun:test";
import {
  ConvexGitHubRepositoryObservationService,
  GitHubRepositoryObservationConflictError,
  GitHubRepositoryObservationStorageError,
} from "../src/github-repository-observation-convex.ts";
import { mapGitHubRepositoryWebhook } from "../src/github-repository-observation.ts";
import type { HostedGitHubRepositoryObservationInput } from "../src/hosted-provider-capacity-api.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

describe("Convex GitHub repository observation service", () => {
  test("stores only the canonical content-minimised observation", async () => {
    const observation = issueObservation();
    const calls: Record<string, unknown>[] = [];
    const service = new ConvexGitHubRepositoryObservationService({
      client: {
        async mutation(_reference, args) {
          calls.push(args);
          return {
            duplicate: false,
            record: storedRecord(String(args.observationJson)),
          };
        },
        async query() {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
      workspace: "default",
    });

    expect(await service.ingestRepositoryObservation({
      deliveryId: observation.deliveryId,
      eventType: observation.eventType,
      payloadDigest: observation.payloadDigest,
      receivedAt: observation.receivedAt,
      observation,
    })).toEqual({ duplicate: false });
    const captured = calls[0];
    expect(captured).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "default",
      deliveryId: "delivery-591",
      eventType: "issues",
      payloadDigest: `sha256:${"a".repeat(64)}`,
      receivedAt: Date.parse("2026-07-31T15:00:01.000Z"),
    });
    const observationJson = String(captured?.observationJson ?? "");
    expect(observationJson).not.toContain("private issue body");
    expect(observationJson).not.toContain("rawPayload");
    expect(observationJson).toContain(observation.semanticFingerprint);
  });

  test("rejects input accessors without invoking them or calling Convex", async () => {
    const observation = issueObservation();
    let getterCalls = 0;
    let mutationCalls = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      deliveryId: { enumerable: true, value: observation.deliveryId },
      eventType: { enumerable: true, value: observation.eventType },
      payloadDigest: { enumerable: true, value: observation.payloadDigest },
      receivedAt: { enumerable: true, value: observation.receivedAt },
      observation: {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("credential-shaped getter text");
        },
      },
    });
    const service = new ConvexGitHubRepositoryObservationService({
      client: {
        async mutation() {
          mutationCalls += 1;
          throw new Error("must not run");
        },
        async query() {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
    });

    await expect(service.ingestRepositoryObservation(
      hostile as unknown as HostedGitHubRepositoryObservationInput,
    )).rejects.toThrow(
      "GitHub repository observation input.observation must be an enumerable data property",
    );
    expect(getterCalls).toBe(0);
    expect(mutationCalls).toBe(0);
  });

  test("rejects backend result accessors without invoking them", async () => {
    const observation = issueObservation();
    let getterCalls = 0;
    const hostileResult = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostileResult, {
      duplicate: {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("backend credential-shaped getter text");
        },
      },
      record: {
        enumerable: true,
        value: storedRecord(canonicalJson(observation)),
      },
    });
    const service = serviceWithMutationResult(hostileResult);

    await expect(service.ingestRepositoryObservation(observationInput(observation)))
      .rejects.toBeInstanceOf(GitHubRepositoryObservationStorageError);
    expect(getterCalls).toBe(0);
  });

  test("does not invoke a nested backend proxy get trap", async () => {
    const observation = issueObservation();
    let getCalls = 0;
    const proxiedRecord = new Proxy(
      storedRecord(canonicalJson(observation)),
      {
        get() {
          getCalls += 1;
          throw new Error("nested proxy get trap must not run");
        },
      },
    );
    const service = serviceWithMutationResult({
      duplicate: false,
      record: proxiedRecord,
    });

    expect(await service.ingestRepositoryObservation(observationInput(observation)))
      .toEqual({ duplicate: false });
    expect(getCalls).toBe(0);
  });

  test("does not invoke a thrown message accessor", async () => {
    const observation = issueObservation();
    let getterCalls = 0;
    const hostileError = Object.create(Error.prototype);
    Object.defineProperty(hostileError, "message", {
      enumerable: false,
      get() {
        getterCalls += 1;
        throw new Error("thrown message getter must not run");
      },
    });
    const service = new ConvexGitHubRepositoryObservationService({
      client: {
        async mutation() {
          throw hostileError;
        },
        async query() {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
    });

    await expect(service.ingestRepositoryObservation(observationInput(observation)))
      .rejects.toBeInstanceOf(GitHubRepositoryObservationStorageError);
    expect(getterCalls).toBe(0);
  });

  test("maps changed delivery reuse to one typed conflict", async () => {
    const observation = issueObservation();
    const service = new ConvexGitHubRepositoryObservationService({
      client: {
        async mutation() {
          throw new Error("GITHUB_REPOSITORY_DELIVERY_CONFLICT");
        },
        async query() {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
    });
    await expect(service.ingestRepositoryObservation(observationInput(observation)))
      .rejects.toBeInstanceOf(GitHubRepositoryObservationConflictError);
  });

  test("reads bounded canonical observations", async () => {
    const observation = issueObservation();
    const service = new ConvexGitHubRepositoryObservationService({
      client: {
        async mutation() {
          throw new Error("not used");
        },
        async query(_reference, args) {
          expect(args).toMatchObject({
            serviceSecret: "service-secret",
            workspace: "default",
            repository: "teamleaderleo/stensibly",
            limit: 10,
          });
          return [storedRecord(canonicalJson(observation))];
        },
      },
      serviceSecret: "service-secret",
    });
    const records = await service.listRecentRepositoryObservations(
      "TEAMLEADERLEO/STENSIBLY",
      10,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "observation-row-1",
      createdAt: "2026-07-31T15:00:02.000Z",
      observation: {
        observationId: "github:issues:delivery-591",
        repository: "teamleaderleo/stensibly",
      },
    });
  });

  test("rejects query accessors without invoking them", async () => {
    let getterCalls = 0;
    const hostileRows: unknown[] = [];
    Object.defineProperty(hostileRows, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("query getter must not run");
      },
    });
    const service = new ConvexGitHubRepositoryObservationService({
      client: {
        async mutation() {
          throw new Error("not used");
        },
        async query() {
          return hostileRows;
        },
      },
      serviceSecret: "service-secret",
    });

    await expect(service.listRecentRepositoryObservations(
      "teamleaderleo/stensibly",
      10,
    )).rejects.toBeInstanceOf(GitHubRepositoryObservationStorageError);
    expect(getterCalls).toBe(0);
  });

  test("rejects coherently fingerprinted stored semantic forgery", async () => {
    const decoded = JSON.parse(canonicalJson(issueObservation()));
    decoded.subject = {
      kind: "pull_request",
      externalId: "github:teamleaderleo/stensibly#pull/591",
    };
    decoded.relationships.pullRequestNumber = 591;
    refingerprint(decoded);
    const service = new ConvexGitHubRepositoryObservationService({
      client: {
        async mutation() {
          throw new Error("not used");
        },
        async query() {
          return [storedRecord(canonicalJson(decoded))];
        },
      },
      serviceSecret: "service-secret",
    });

    await expect(service.listRecentRepositoryObservations(
      "teamleaderleo/stensibly",
      10,
    )).rejects.toBeInstanceOf(GitHubRepositoryObservationStorageError);
  });
});

function issueObservation() {
  const observation = mapGitHubRepositoryWebhook({
    eventType: "issues",
    deliveryId: "delivery-591",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    signatureVerified: true,
    receivedAt: "2026-07-31T15:00:01.000Z",
    expectedRepository: "teamleaderleo/stensibly",
    payload: {
      action: "edited",
      repository: { full_name: "teamleaderleo/stensibly" },
      sender: { login: "teamleaderleo" },
      issue: {
        number: 591,
        title: "Synchronize repository observations",
        body: "private issue body",
        state: "open",
        state_reason: null,
        locked: false,
        created_at: "2026-07-31T14:00:00.000Z",
        updated_at: "2026-07-31T15:00:00.000Z",
        labels: [],
        assignees: [],
        milestone: null,
      },
    },
  });
  if (!observation) throw new Error("Expected issue observation");
  return observation;
}

function observationInput(observation: ReturnType<typeof issueObservation>) {
  return {
    deliveryId: observation.deliveryId,
    eventType: observation.eventType,
    payloadDigest: observation.payloadDigest,
    receivedAt: observation.receivedAt,
    observation,
  };
}

function serviceWithMutationResult(result: unknown) {
  return new ConvexGitHubRepositoryObservationService({
    client: {
      async mutation() {
        return result;
      },
      async query() {
        throw new Error("not used");
      },
    },
    serviceSecret: "service-secret",
  });
}

function storedRecord(observationJson: string) {
  const observation = JSON.parse(observationJson);
  return {
    id: "observation-row-1",
    observationId: observation.observationId,
    deliveryId: observation.deliveryId,
    payloadDigest: observation.payloadDigest,
    semanticFingerprint: observation.semanticFingerprint,
    eventType: observation.eventType,
    action: observation.action,
    repository: observation.repository,
    actor: observation.actor,
    subjectKind: observation.subject.kind,
    subjectExternalId: observation.subject.externalId,
    sourceTime: Date.parse(observation.sourceTime),
    sourceTimeSource: observation.sourceTimeSource,
    receivedAt: Date.parse(observation.receivedAt),
    observationJson,
    createdAt: Date.parse("2026-07-31T15:00:02.000Z"),
  };
}

function refingerprint(observation: Record<string, any>): void {
  const {
    observationId: _observationId,
    deliveryId: _deliveryId,
    payloadDigest: _payloadDigest,
    semanticFingerprint: _semanticFingerprint,
    receivedAt: _receivedAt,
    ...canonicalSemantics
  } = observation;
  observation.semanticFingerprint = fingerprintCanonicalRequest(canonicalSemantics);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}
