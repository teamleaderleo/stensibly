import type { McpOAuthGrant } from "./mcp-oauth-service.js";
import type { TokenPrincipal } from "./token-contracts.js";

export interface AccessTokenRuntimeOptions {
  issuer: string;
  resource: string;
  workspace: string;
  signingSecret: Uint8Array;
  accessTokenSeconds: number;
  now: () => number;
  randomBytes: (length: number) => Uint8Array;
}

export async function createAccessToken(
  grant: McpOAuthGrant,
  options: AccessTokenRuntimeOptions,
): Promise<string> {
  const now = Math.floor(options.now() / 1000);
  const scopes = grant.scopes.filter((scope): scope is "read" | "write" => scope !== "offline_access");
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    iss: options.issuer,
    sub: grant.principal.accountId,
    aud: options.resource,
    client_id: grant.clientId,
    jti: `oauth_access_${base64Url(options.randomBytes(18))}`,
    iat: now,
    exp: now + options.accessTokenSeconds,
    name: grant.principal.name,
    workspace: grant.principal.workspace,
    role: grant.principal.role,
    scope: scopes.join(" "),
    projects: grant.principal.projects,
  })));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${await signDetached(signingInput, options.signingSecret)}`;
}

export async function verifyAccessToken(
  token: string,
  options: AccessTokenRuntimeOptions,
): Promise<TokenPrincipal | null> {
  if (token.length > 16_384) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  if (!(await verifyDetached(`${parts[0]}.${parts[1]}`, parts[2], options.signingSecret))) return null;
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    return null;
  }
  if (!isRecord(header) || header.alg !== "HS256" || header.typ !== "JWT" || !isRecord(payload)) return null;
  const now = Math.floor(options.now() / 1000);
  if (
    payload.iss !== options.issuer
    || payload.aud !== options.resource
    || typeof payload.sub !== "string"
    || typeof payload.client_id !== "string"
    || typeof payload.jti !== "string"
    || typeof payload.name !== "string"
    || payload.workspace !== options.workspace
    || typeof payload.iat !== "number"
    || typeof payload.exp !== "number"
    || payload.iat > now + 60
    || payload.exp <= now
    || payload.exp > payload.iat + options.accessTokenSeconds + 60
  ) return null;
  const scopes = parseAccessScopes(payload.scope);
  const projects = parseProjectsClaim(payload.projects);
  if (!scopes || projects === undefined) return null;
  return {
    tokenId: payload.jti,
    name: payload.name,
    scopes,
    projects,
  };
}

export async function createOpaqueCredential(
  kind: "code" | "refresh",
  randomBytes: (length: number) => Uint8Array,
) {
  const id = `oauth_${kind}_${base64Url(randomBytes(18))}`;
  const secret = base64Url(randomBytes(32));
  return { id, raw: `${id}.${secret}`, secretHash: await sha256Hex(secret) };
}

export async function parseOpaqueCredential(raw: string, kind: "code" | "refresh") {
  if (raw.length > 256) return null;
  const split = raw.indexOf(".");
  if (split <= 0 || split !== raw.lastIndexOf(".")) return null;
  const id = raw.slice(0, split);
  const secret = raw.slice(split + 1);
  if (!new RegExp(`^oauth_${kind}_[A-Za-z0-9_-]{12,96}$`).test(id)) return null;
  if (!/^[A-Za-z0-9_-]{32,120}$/.test(secret)) return null;
  return { id, secretHash: await sha256Hex(secret) };
}

export async function signDetached(value: string, secret: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  ));
}

export async function verifyDetached(
  value: string,
  signature: string,
  secret: Uint8Array,
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(signature);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(bytes),
    new TextEncoder().encode(value),
  );
}

export async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ));
}

export function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url");
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function parseAccessScopes(value: unknown): ("read" | "write")[] | null {
  if (typeof value !== "string") return null;
  const scopes = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  if (
    !scopes.includes("read")
    || scopes.some((scope) => scope !== "read" && scope !== "write")
  ) return null;
  return (["read", "write"] as const).filter((scope) => scopes.includes(scope));
}

function parseProjectsClaim(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1000) return undefined;
  const projects: string[] = [];
  for (const project of value) {
    if (typeof project !== "string" || !/^[a-z0-9][a-z0-9-_]*$/.test(project)) {
      return undefined;
    }
    projects.push(project);
  }
  return [...new Set(projects)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
