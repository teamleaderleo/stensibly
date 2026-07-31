import { basename } from "node:path";

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
