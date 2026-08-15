import { expect, test } from "bun:test";
import type { GmailUnattendedRuntime } from "../src/gmail-unattended-runtime.ts";
import {
  GMAIL_PUBSUB_PATH,
  handleGmailPubSubRequest,
  runGmailScheduledReconciliation,
  type GmailUnattendedMount,
} from "../src/gmail-unattended-worker.ts";
import {
  GooglePubSubAuthenticationError,
  type GooglePubSubOidcVerifier,
} from "../src/google-pubsub-oidc.ts";

const callback = `https://api.stensibly.com${GMAIL_PUBSUB_PATH}`;

test("rejects PubSub before reading or reconciling the envelope when OIDC fails", async () => {
  let runtimeCalls = 0;
  const mount = {
    verifier: {
      verifyAuthorizationHeader: async () => {
        throw new GooglePubSubAuthenticationError();
      },
    } as unknown as GooglePubSubOidcVerifier,
    runtime: {
      receivePubSubEnvelope: async () => {
        runtimeCalls += 1;
        throw new Error("runtime must stay unreachable");
      },
    } as unknown as GmailUnattendedRuntime,
  } satisfies GmailUnattendedMount;

  const request = new Request(callback, {
    method: "POST",
    headers: { authorization: "Bearer rejected" },
    body: JSON.stringify({ message: { data: "ignored" } }),
  });
  const response = await handleGmailPubSubRequest(request, mount);
  expect(response?.status).toBe(401);
  expect(runtimeCalls).toBe(0);
});

test("acknowledges only after authenticated durable reconciliation returns", async () => {
  const envelope = {
    subscription: "projects/example/subscriptions/stensibly-gmail-handoffs",
    message: { data: "encoded", messageId: "pubsub-101" },
  };
  let received: unknown;
  const mount = {
    verifier: {
      verifyAuthorizationHeader: async () => ({
        issuer: "https://accounts.google.com",
        audience: callback,
        email: "push@example.iam.gserviceaccount.com",
        subject: "123",
      }),
    } as unknown as GooglePubSubOidcVerifier,
    runtime: {
      receivePubSubEnvelope: async (value: unknown) => {
        received = value;
        return {
          duplicate: false,
          revision: 7,
          cursor: "101",
          admittedObservations: 2,
          materialObservations: 1,
          archivedMessages: 1,
          recoveryAction: null,
        };
      },
    } as unknown as GmailUnattendedRuntime,
  } satisfies GmailUnattendedMount;

  const request = new Request(callback, {
    method: "POST",
    headers: { authorization: "Bearer accepted" },
    body: JSON.stringify(envelope),
  });
  const response = await handleGmailPubSubRequest(request, mount);
  expect(response?.status).toBe(204);
  expect(response?.headers.get("x-stensibly-mailbox-revision")).toBe("7");
  expect(response?.headers.get("x-stensibly-mailbox-observations")).toBe("2");
  expect(received).toEqual(envelope);
});

test("publishes only a fixed reconciliation failure code", async () => {
  const mount = {
    verifier: {
      verifyAuthorizationHeader: async () => ({
        issuer: "https://accounts.google.com",
        audience: callback,
        email: "push@example.iam.gserviceaccount.com",
        subject: "123",
      }),
    } as unknown as GooglePubSubOidcVerifier,
    runtime: {
      receivePubSubEnvelope: async () => {
        throw new RangeError("Gmail Pub/Sub subscription binding mismatch");
      },
    } as unknown as GmailUnattendedRuntime,
  } satisfies GmailUnattendedMount;

  const response = await handleGmailPubSubRequest(new Request(callback, {
    method: "POST",
    headers: { authorization: "Bearer accepted" },
    body: JSON.stringify({ message: { data: "encoded" } }),
  }), mount);

  expect(response?.status).toBe(503);
  expect(response?.headers.get("x-stensibly-gmail-failure"))
    .toBe("gmail_push_subscription_mismatch");
  expect(await response?.text()).toBe("Mailbox reconciliation failed");
});

test("cancels an undeclared Gmail push body as soon as it exceeds 64 KiB", async () => {
  let cancelled = false;
  let runtimeCalls = 0;
  const oversizedChunk = new Uint8Array(64 * 1024 + 1).fill(0x20);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(oversizedChunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const mount = {
    verifier: {
      verifyAuthorizationHeader: async () => ({
        issuer: "https://accounts.google.com",
        audience: callback,
        email: "push@example.iam.gserviceaccount.com",
        subject: "123",
      }),
    } as unknown as GooglePubSubOidcVerifier,
    runtime: {
      receivePubSubEnvelope: async () => {
        runtimeCalls += 1;
        throw new Error("runtime must stay unreachable");
      },
    } as unknown as GmailUnattendedRuntime,
  } satisfies GmailUnattendedMount;

  const response = await handleGmailPubSubRequest(new Request(callback, {
    method: "POST",
    headers: { authorization: "Bearer accepted" },
    body,
    duplex: "half",
  } as RequestInit), mount);

  expect(response?.status).toBe(400);
  expect(cancelled).toBe(true);
  expect(runtimeCalls).toBe(0);
});

test("scheduled reconciliation bootstraps or catches up through the same runtime", async () => {
  let calls = 0;
  const mount = {
    verifier: {} as GooglePubSubOidcVerifier,
    runtime: {
      bootstrapOrCatchUp: async () => {
        calls += 1;
        return {
          duplicate: false,
          revision: 1,
          cursor: "100",
          admittedObservations: 0,
          materialObservations: 0,
          archivedMessages: 0,
          recoveryAction: null,
        };
      },
    } as unknown as GmailUnattendedRuntime,
  } satisfies GmailUnattendedMount;

  await runGmailScheduledReconciliation(mount);
  expect(calls).toBe(1);
});
