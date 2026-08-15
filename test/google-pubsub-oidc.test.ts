import { expect, test } from "bun:test";
import {
  GooglePubSubAuthenticationError,
  GooglePubSubOidcVerifier,
} from "../src/google-pubsub-oidc.ts";

const audience = "https://api.stensibly.com/internal/gmail/pubsub";
const serviceAccount = "stensibly-gmail-push@example-project.iam.gserviceaccount.com";

test("verifies RS256 audience and exact PubSub service-account identity", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "test-key";
  const now = Date.parse("2026-08-15T06:45:00.000Z");
  const jwt = await signJwt(keys.privateKey, {
    iss: "https://accounts.google.com",
    aud: audience,
    email: serviceAccount,
    email_verified: true,
    sub: "1234567890",
    iat: Math.floor(now / 1000) - 10,
    exp: Math.floor(now / 1000) + 600,
  });
  const verifier = new GooglePubSubOidcVerifier({
    audience,
    serviceAccountEmail: serviceAccount,
    now: () => now,
    fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "cache-control": "public, max-age=3600" },
    }),
  });
  const identity = await verifier.verifyAuthorizationHeader(`Bearer ${jwt}`);
  expect(identity).toEqual({
    issuer: "https://accounts.google.com",
    audience,
    email: serviceAccount,
    subject: "1234567890",
  });
});

test("rejects a validly signed token for another service account", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "test-key";
  const now = Date.parse("2026-08-15T06:45:00.000Z");
  const jwt = await signJwt(keys.privateKey, {
    iss: "accounts.google.com",
    aud: audience,
    email: "other@example-project.iam.gserviceaccount.com",
    email_verified: true,
    sub: "1234567890",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 600,
  });
  const verifier = new GooglePubSubOidcVerifier({
    audience,
    serviceAccountEmail: serviceAccount,
    now: () => now,
    fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }),
  });
  await expect(verifier.verifyAuthorizationHeader(`Bearer ${jwt}`))
    .rejects.toBeInstanceOf(GooglePubSubAuthenticationError);
});

async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: "test-key" });
  const body = encodeJson(payload);
  const input = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
