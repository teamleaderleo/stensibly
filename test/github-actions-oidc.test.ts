import { expect, test } from "bun:test";
import {
  GitHubActionsAuthenticationError,
  GitHubActionsOidcVerifier,
} from "../src/github-actions-oidc.ts";

const audience = "https://api.stensibly.com/internal/deploy-governor/candidate";
const repository = "teamleaderleo/scrapbook";
const ref = "refs/heads/main";
const sha = "a".repeat(40);
const workflowRef = `${repository}/.github/workflows/deploy-signal.yml@${ref}`;

async function fixture() {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "github-test-key",
  };
  const now = Date.parse("2026-08-24T17:15:00.000Z");
  const fakeFetch = (async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { "cache-control": "public, max-age=3600" },
  })) as unknown as typeof fetch;
  const verifier = new GitHubActionsOidcVerifier({
    audience,
    now: () => now,
    fetch: fakeFetch,
  });
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: audience,
    sub: `repo:${repository}:ref:${ref}`,
    jti: "github-run-token-1",
    repository,
    repository_owner: "teamleaderleo",
    ref,
    ref_type: "branch",
    sha,
    workflow: "Production deploy signal",
    workflow_ref: workflowRef,
    event_name: "push",
    iat: Math.floor(now / 1000) - 10,
    nbf: Math.floor(now / 1000) - 10,
    exp: Math.floor(now / 1000) + 600,
  };
  return { keys, verifier, claims };
}

test("verifies exact GitHub Actions deploy-signal identity", async () => {
  const { keys, verifier, claims } = await fixture();
  const jwt = await signJwt(keys.privateKey, claims);
  await expect(verifier.verifyAuthorizationHeader(`Bearer ${jwt}`)).resolves.toEqual({
    issuer: "https://token.actions.githubusercontent.com",
    audience,
    repository,
    repositoryOwner: "teamleaderleo",
    ref,
    branch: "main",
    sha,
    workflowRef,
    eventName: "push",
    jti: "github-run-token-1",
  });
});

test("rejects a validly signed token from another workflow", async () => {
  const { keys, verifier, claims } = await fixture();
  const jwt = await signJwt(keys.privateKey, {
    ...claims,
    workflow_ref: `${repository}/.github/workflows/ci.yml@${ref}`,
  });
  await expect(verifier.verifyAuthorizationHeader(`Bearer ${jwt}`))
    .rejects.toBeInstanceOf(GitHubActionsAuthenticationError);
});

test("rejects a validly signed token for another audience", async () => {
  const { keys, verifier, claims } = await fixture();
  const jwt = await signJwt(keys.privateKey, {
    ...claims,
    aud: "https://example.invalid",
  });
  await expect(verifier.verifyAuthorizationHeader(`Bearer ${jwt}`))
    .rejects.toBeInstanceOf(GitHubActionsAuthenticationError);
});

test("rejects non-push and non-branch identities", async () => {
  const { keys, verifier, claims } = await fixture();
  for (const patch of [
    { event_name: "workflow_dispatch" },
    { ref: "refs/tags/v1", ref_type: "tag" },
  ]) {
    const jwt = await signJwt(keys.privateKey, { ...claims, ...patch });
    await expect(verifier.verifyAuthorizationHeader(`Bearer ${jwt}`))
      .rejects.toBeInstanceOf(GitHubActionsAuthenticationError);
  }
});

async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: "github-test-key" });
  const body = encodeJson(payload);
  const input = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    Uint8Array.from(new TextEncoder().encode(input)).buffer,
  );
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
