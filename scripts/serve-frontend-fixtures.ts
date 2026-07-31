import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const siteRoot = resolve(import.meta.dir, "..", "site");
const realSiteRoot = await realpath(siteRoot);
const hostname = "127.0.0.1";
const port = parsePort(Bun.env.PORT);

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico") {
      return new Response(null, {
        status: 204,
        headers: responseHeaders("image/x-icon"),
      });
    }

    const filePath = await resolveFixturePath(url.pathname);
    if (!filePath) {
      return new Response("Not found", {
        status: 404,
        headers: responseHeaders("text/plain; charset=utf-8"),
      });
    }

    const file = Bun.file(filePath);
    const headers = responseHeaders(contentType(filePath));
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(file, { status: 200, headers });
  },
});

console.log(`Frontend fixtures listening at http://${hostname}:${server.port}/labs/`);

async function resolveFixturePath(rawPathname: string): Promise<string | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }

  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0")) {
    return null;
  }
  if (pathname === "/package.json") return null;

  const segments = pathname.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  const relativePath = segments.join("/");
  const directPath = resolve(siteRoot, relativePath);
  const candidates = !relativePath || pathname.endsWith("/")
    ? [resolve(directPath, "index.html")]
    : [directPath, resolve(directPath, "index.html")];

  for (const candidate of candidates) {
    if (!isInside(candidate, siteRoot)) continue;
    try {
      const verifiedPath = await realpath(candidate);
      if (!isInside(verifiedPath, realSiteRoot)) continue;
      if ((await stat(verifiedPath)).isFile()) return verifiedPath;
    } catch {
      // A missing, linked-outside-root, or unreadable candidate falls through.
    }
  }
  return null;
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 4173;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new RangeError("PORT must be an integer from 1024 through 65535");
  }
  return parsed;
}

function responseHeaders(type: string): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'none'",
      "font-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'self'",
      "frame-src 'self'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "worker-src 'none'",
    ].join("; "),
    "Content-Type": type,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}
