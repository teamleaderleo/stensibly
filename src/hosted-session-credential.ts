export const HOSTED_SESSION_COOKIE = "__Host-stensibly-session";

export interface HostedSessionCredential {
  id: string;
  secretHash: string;
}

export async function parseHostedSessionCredential(
  raw: string | null | undefined,
): Promise<HostedSessionCredential | null> {
  if (!raw || raw.length > 256) return null;
  const split = raw.indexOf(".");
  if (split <= 0 || split !== raw.lastIndexOf(".")) return null;
  const id = raw.slice(0, split);
  const secret = raw.slice(split + 1);
  if (!/^ses_[A-Za-z0-9_-]{12,80}$/.test(id)) return null;
  if (!/^[A-Za-z0-9_-]{32,120}$/.test(secret)) return null;
  return { id, secretHash: await sha256(secret) };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
