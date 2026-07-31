import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const maximumMcpOutputBytes = 25_000_000;
const maximumMcpEnvironmentValueBytes = 8_192;
const booleanMcpSwitches = new Set([
  "--isolated",
  "--headless",
  "--sandbox",
  "--block-service-workers",
]);
const valuedMcpSwitches = new Set([
  "--allowed-origins",
  "--image-responses",
  "--output-mode",
  "--output-dir",
  "--output-max-size",
  "--viewport-size",
]);
const requiredMcpSwitches = new Set([...booleanMcpSwitches, ...valuedMcpSwitches]);
const mcpEnvironmentKeys = [
  "BUN_INSTALL",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
] as const;
const unsafeEnvironmentText = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const credentialEnvironmentText = /(?:^|[._:/=@-])(?:(?:env|secret):\/\/|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-|AKIA[0-9A-Z]{16})/iu;

const exactPrivateNames = new Set([
  ".dev.vars",
  ".npmrc",
  ".pypirc",
  "autofillstrikedatabase",
  "bookmarks",
  "bookmarks.bak",
  "cache",
  "code cache",
  "cookies",
  "cookies.json",
  "cookies.txt",
  "extensions",
  "favicons",
  "gpucache",
  "history",
  "indexeddb",
  "login data",
  "local state",
  "local storage",
  "network action predictor",
  "network persistent state",
  "preferences",
  "reporting and nel",
  "secure preferences",
  "service worker",
  "session storage",
  "sessions",
  "sharedstorage",
  "shortcuts",
  "storage-state.json",
  "storagestate.json",
  "storage_state.json",
  "sync data",
  "top sites",
  "transportsecurity",
  "trust tokens",
  "visited links",
  "web data",
]);
const privateDatabaseSuffixes = ["-journal", "-shm", "-wal"];

export function isForbiddenBrowserEvidenceName(path: string): boolean {
  const name = basename(path).toLocaleLowerCase("en-US");
  if (exactPrivateNames.has(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name === ".dev.vars" || name.startsWith(".dev.vars.")) return true;
  if (name === "cookies" || name.startsWith("cookies.")) return true;
  if (privateDatabaseSuffixes.some((suffix) => name.endsWith(suffix) && exactPrivateNames.has(name.slice(0, -suffix.length)))) {
    return true;
  }

  const compact = name.replace(/[ ._-]/gu, "");
  if (compact.startsWith("storagestate")) return true;
  return /\.(?:sqlite|sqlite-shm|sqlite-wal)$/u.test(name);
}

export function validatePlaywrightMcpArgs(
  args: readonly string[],
  repositoryRoot: string,
): readonly string[] {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return Object.freeze([...args]);
  if (args.length < 1) throw new TypeError("Playwright MCP requires the reviewed isolated research arguments");

  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (booleanMcpSwitches.has(argument)) {
      if (seen.has(argument)) throw new TypeError(`Playwright MCP switch appears more than once: ${argument}`);
      seen.add(argument);
      continue;
    }
    if (valuedMcpSwitches.has(argument)) {
      if (seen.has(argument)) throw new TypeError(`Playwright MCP switch appears more than once: ${argument}`);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`Playwright MCP requires a value for ${argument}`);
      seen.add(argument);
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw new TypeError("Playwright MCP arguments must use the reviewed switch set");
  }

  for (const required of requiredMcpSwitches) {
    if (!seen.has(required)) throw new TypeError(`Playwright MCP requires ${required}`);
  }

  const allowedOrigins = values.get("--allowed-origins")!;
  const origins = allowedOrigins.split(";").map((value) => value.trim()).filter(Boolean);
  if (origins.length < 1 || origins.length > 20) throw new TypeError("Playwright MCP requires 1-20 exact allowed origins");
  for (const origin of origins) validateOrigin(origin);

  if (values.get("--image-responses") !== "omit") {
    throw new TypeError("Playwright MCP requires --image-responses omit");
  }
  if (values.get("--output-mode") !== "file") {
    throw new TypeError("Playwright MCP requires --output-mode file");
  }

  const outputDirectory = values.get("--output-dir")!;
  if (!isAbsolute(outputDirectory)) throw new TypeError("Playwright MCP output directory must be absolute");
  const realRepositoryRoot = realpathSync(resolve(repositoryRoot));
  const projectedOutput = resolveThroughExistingAncestor(outputDirectory);
  if (!isOutside(realRepositoryRoot, projectedOutput)) {
    throw new TypeError("Playwright MCP output directory must stay outside the repository after symlink resolution");
  }

  const outputMaximum = Number(values.get("--output-max-size"));
  if (!Number.isSafeInteger(outputMaximum) || outputMaximum < 1 || outputMaximum > maximumMcpOutputBytes) {
    throw new TypeError(`Playwright MCP output maximum must be 1-${maximumMcpOutputBytes} bytes`);
  }

  const viewport = values.get("--viewport-size")!;
  if (!/^(?:[3-9]\d{2}|[1-4]\d{3})x(?:[3-9]\d{2}|[1-2]\d{3})$/u.test(viewport)) {
    throw new TypeError("Playwright MCP viewport must be a bounded WIDTHxHEIGHT value");
  }

  return Object.freeze([...args]);
}

export function createPlaywrightMcpEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const admitted: Record<string, string> = {};
  for (const key of mcpEnvironmentKeys) {
    const value = environment[key];
    if (value === undefined || value === "") continue;
    if (
      Buffer.byteLength(value, "utf8") > maximumMcpEnvironmentValueBytes
      || unsafeEnvironmentText.test(value)
      || credentialEnvironmentText.test(value)
    ) {
      throw new TypeError("Playwright MCP execution environment contains an unsafe admitted value");
    }
    admitted[key] = value;
  }
  return Object.freeze(admitted);
}

function resolveThroughExistingAncestor(path: string): string {
  const target = resolve(path);
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  return resolve(realAncestor, relative(ancestor, target));
}

function isOutside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
}

function validateOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Playwright MCP allowed origin is invalid");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("Playwright MCP allowed origin must use HTTPS or loopback HTTP");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value) {
    throw new TypeError("Playwright MCP requires an exact credential-free origin");
  }
}
