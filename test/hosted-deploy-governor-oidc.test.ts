import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import {
  createHostedDeployGovernorOidcHandlerFromEnv,
  deployGovernorOidcAudience,
} from "../src/hosted-deploy-governor-oidc.ts";

const sourceRepository = "teamleaderleo/scrapbook";
const targetRepository = "teamleaderleo/deploy-governor";
const sha = "b".repeat(40);
const ref = "refs/heads/main";
const now = Date.parse("2026-08-24T17:30:00.000Z");
const appPrivateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

function environment(): Record<string, string | undefined> {
  return {
    STENSIBLY_DEPLOY_GOVERNOR_ENABLED: "true",
    STENSIBLY_DEPLOY_GOVERNOR_REPOSITORY: targetRepository,
    STENSIBLY_DEPLOY_GOVERNOR_REPOSITORIES: sourceRepository,
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: appPrivateKeyPem,
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
  };
}

async function oidcKeys() {
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
    kid: "oidc-key",
  };
  return { keys, publicJwk };
}

function claims(repository = sourceRepository) {
  const [owner] = repository.split("/");
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: deployGovernorOidcAudience,
    sub: `repo:${repository}:ref:${ref}`,
    jti: "oidc-delivery-1",
    repository,
    repository_owner: owner,
    ref,
    ref_type: "branch",
    sha,
    workflow: "Production deploy signal",
    workflow_ref: `${repository}/.github/workflows/deploy-signal.yml@${ref}`,
    event_name: "push",
    iat: Math.floor(now / 1000) - 10,
    nbf: Math.floor(now / 1000) - 10,
    exp: Math.floor(now / 1000) + 600,
  };
}

test("accepts signed source identity and dispatches exact candidate", async () => {
  const { keys, publicJwk } = await oidcKeys();
  const dispatches: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://token.actions.test/.well-known/jwks") {
      return Response.json({ keys: [publicJwk] }, {
        headers: { "cache-control": "public, max-age=3600" },
      });
    }
    if (url.includes("/app/installations/98765/access_tokens")) {
      return Response.json({
        token: "target-token",
        expires_at: "2026-08-24T18:30:00.000Z",
        permissions: { contents: "write" },
        repository_selection: "selected",
        repositories: [{ full_name: targetRepository }],
      }, { status: 201 });
    }
    if (url === "https://api.github.test/repos/teamleaderleo/deploy-governor/dispatches") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer target-token");
      dispatches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  const handler = createHostedDeployGovernorOidcHandlerFromEnv(environment(), {
    fetch: fetchImpl,
    now: () => now,
    jwksUrl: "https://token.actions.test/.well-known/jwks",
  })!;
  const jwt = await signJwt(keys.privateKey, claims());
  const response = await handler.handle(new Request(deployGovernorOidcAudience, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  }));

  expect(response.status).toBe(204);
  expect(dispatches).toEqual([{
    event_type: "vercel-deploy-candidate",
    client_payload: {
      repository: sourceRepository,
      branch: "main",
      sha,
      delivery_id: "oidc-delivery-1",
    },
  }]);
});

test("rejects a signed repository outside the source allowlist before target authority", async () => {
  const { keys, publicJwk } = await oidcKeys();
  let providerCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://token.actions.test/.well-known/jwks") {
      return Response.json({ keys: [publicJwk] });
    }
    providerCalls += 1;
    throw new Error("must not mint or dispatch");
  }) as unknown as typeof fetch;
  const handler = createHostedDeployGovernorOidcHandlerFromEnv(environment(), {
    fetch: fetchImpl,
    now: () => now,
    jwksUrl: "https://token.actions.test/.well-known/jwks",
  })!;
  const jwt = await signJwt(keys.privateKey, claims("teamleaderleo/not-enrolled"));
  const response = await handler.handle(new Request(deployGovernorOidcAudience, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  }));

  expect(response.status).toBe(403);
  expect(providerCalls).toBe(0);
});

test("rejects missing OIDC bearer credentials", async () => {
  const handler = createHostedDeployGovernorOidcHandlerFromEnv(environment(), {
    fetch: (async () => {
      throw new Error("must not call provider");
    }) as unknown as typeof fetch,
    now: () => now,
  })!;
  const response = await handler.handle(new Request(deployGovernorOidcAudience, {
    method: "POST",
  }));
  expect(response.status).toBe(401);
});

async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: "oidc-key" });
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
