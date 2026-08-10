import { expect, test } from "bun:test";
import {
  admitHostedGitHubRepositoryObservationInput,
} from "../src/github-repository-observation-admission.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";

const repository = "teamleaderleo/stensibly";
const receivedAt = "2026-08-08T00:00:00.000Z";

function observation() {
  const payload = {
    action: "edited",
    repository: { full_name: repository },
    sender: { login: "teamleaderleo" },
    issue: {
      number: 1247,
      title: "Bound nested repository observation admission",
      body: "private body",
      state: "open",
      state_reason: null,
      locked: false,
      created_at: "2026-08-07T23:59:00.000Z",
      updated_at: receivedAt,
      labels: [{ name: "concern:reliability" }],
      assignees: [],
      milestone: null,
    },
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const result = mapGitHubRepositoryWebhook({
    eventType: "issues",
    deliveryId: "delivery-nested-observation-boundary",
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt,
    expectedRepository: repository,
  });
  if (!result) throw new Error("fixture did not produce an observation");
  return result;
}

function hostedInput(value: ReturnType<typeof observation>) {
  return {
    deliveryId: value.deliveryId,
    eventType: value.eventType,
    payloadDigest: value.payloadDigest,
    receivedAt: value.receivedAt,
    observation: value,
  };
}

test("hosted admission reads the fixed observation shell without caller key enumeration", () => {
  const base = observation();
  let getCalls = 0;
  let ownKeysCalls = 0;
  const hostileObservation = new Proxy(base, {
    get() {
      getCalls += 1;
      throw new Error("nested observation get must remain unreachable");
    },
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("nested observation ownKeys must remain unreachable");
    },
  });

  const admitted = admitHostedGitHubRepositoryObservationInput({
    ...hostedInput(base),
    observation: hostileObservation,
  });

  expect(admitted.observationId).toBe(base.observationId);
  expect(admitted.semanticFingerprint).toBe(base.semanticFingerprint);
  expect(getCalls).toBe(0);
  expect(ownKeysCalls).toBe(0);
});

test("hosted admission detaches fixed nested records and content revision arrays", () => {
  const base = observation();
  let getCalls = 0;
  let ownKeysCalls = 0;
  const hostile = <T extends object>(value: T): T => new Proxy(value, {
    get() {
      getCalls += 1;
      throw new Error("fixed nested get must remain unreachable");
    },
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("fixed nested ownKeys must remain unreachable");
    },
  });

  const nested = {
    ...base,
    subject: hostile({ ...base.subject, ignoredDecoration: true }),
    relationships: hostile({ ...base.relationships, ignoredDecoration: true }),
    contentRevisions: hostile(base.contentRevisions.map((entry) =>
      hostile({ ...entry, ignoredDecoration: true })
    )),
  };

  const admitted = admitHostedGitHubRepositoryObservationInput({
    ...hostedInput(base),
    observation: nested,
  });

  expect(admitted.observationId).toBe(base.observationId);
  expect(admitted.semanticFingerprint).toBe(base.semanticFingerprint);
  expect(getCalls).toBe(0);
  expect(ownKeysCalls).toBe(0);
});

test("revoked fixed nested records collapse to a local inspection diagnostic", () => {
  const base = observation();
  const revoked = Proxy.revocable(base.subject, {});
  revoked.revoke();
  expect(() => admitHostedGitHubRepositoryObservationInput({
    ...hostedInput(base),
    observation: { ...base, subject: revoked.proxy },
  })).toThrow("GitHub repository observation subject could not be inspected");
});
