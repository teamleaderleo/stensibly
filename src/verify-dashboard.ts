import {
  dashboardAssetContentType,
  dashboardAssets,
} from "./dashboard-assets.ts";

export { dashboardAssets };
export type { DashboardAssetExpectation } from "./dashboard-assets.ts";

interface DashboardVerificationOptions {
  url: string;
  htmlFile?: string;
  githubAnnotation: boolean;
}

const DEFAULT_URL = "https://www.stensibly.com";
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_PATTERN = /stn\.tok_[A-Za-z0-9._-]+/i;

export function verifyDashboardHtml(html: string): void {
  const required = [
    "<title>Stensibly · Agent scrapbook</title>",
    'content="Stensibly is a shared work-in-progress ledger for humans and agents."',
    'src="/hosted-session-bridge.js"',
    'src="/app.js"',
    'href="/styles.css"',
    'href="/item-claim.css"',
    'href="/hosted-session.css"',
    'id="github-sign-in"',
    'id="connect-form"',
    'id="dashboard"',
    'id="item-detail-dialog"',
  ];
  for (const marker of required) {
    if (!html.includes(marker)) throw new Error(`dashboard HTML is missing ${marker}`);
  }
  if (TOKEN_PATTERN.test(html)) throw new Error("dashboard HTML contains a token-shaped value");
}

export async function verifyDashboardUrl(url: string): Promise<void> {
  const origin = normalizeOrigin(url);
  const html = await fetchText(origin + "/", /text\/html/i);
  verifyDashboardHtml(html);
  for (const asset of dashboardAssets) {
    const assetUrl = origin + asset.path;
    const body = await fetchText(assetUrl, dashboardAssetContentType(asset));
    if (!body.includes(asset.marker)) {
      throw new Error(`${safeUrl(assetUrl)} is missing expected marker ${JSON.stringify(asset.marker)}`);
    }
    if (TOKEN_PATTERN.test(body)) throw new Error(`${asset.path} contains a token-shaped value`);
  }
}

export function formatGitHubErrorAnnotation(message: string): string {
  return `::error title=Dashboard verification failed::${escapeGitHubCommandData(message)}`;
}

async function fetchText(url: string, expectedContentType: RegExp): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "cache-control": "no-cache" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${safeUrl(url)} returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!expectedContentType.test(contentType)) {
      throw new Error(`${safeUrl(url)} returned unexpected content type ${contentType || "<missing>"}`);
    }
    const body = await response.text();
    if (!body.trim()) throw new Error(`${safeUrl(url)} returned an empty response`);
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${safeUrl(url)} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error("dashboard verification URL must use HTTPS");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("dashboard verification URL must be a plain HTTPS origin");
  }
  return parsed.origin;
}

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "dashboard URL";
  }
}

function escapeGitHubCommandData(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function parseArgs(argv: string[]): DashboardVerificationOptions {
  const options: DashboardVerificationOptions = {
    url: DEFAULT_URL,
    githubAnnotation: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--url") {
      options.url = requireValue(argv[++index], "--url");
    } else if (value === "--html-file") {
      options.htmlFile = requireValue(argv[++index], "--html-file");
    } else if (value === "--github-annotation") {
      options.githubAnnotation = true;
    } else {
      throw new Error(`unknown option ${value}`);
    }
  }
  return options;
}

function requireValue(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.htmlFile) {
    verifyDashboardHtml(await Bun.file(options.htmlFile).text());
    console.log("dashboard HTML verification passed");
    return;
  }
  await verifyDashboardUrl(options.url);
  console.log(`dashboard verification passed: ${normalizeOrigin(options.url)}`);
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "dashboard verification failed";
    console.error(message);
    if (Bun.argv.includes("--github-annotation")) {
      console.error(formatGitHubErrorAnnotation(message));
    }
    process.exitCode = 1;
  });
}
