import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  compareDeepSeekInventoryNames,
  estimateRepositoryTokenRange,
} from "../src/deepseek-harness-campaign.js";

const root = resolve(process.argv[2] ?? process.cwd());
const filesResult = Bun.spawnSync(["git", "-C", root, "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" });
if (filesResult.exitCode !== 0) throw new Error("Unable to list tracked repository files");
const revisionResult = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
if (revisionResult.exitCode !== 0) throw new Error("Unable to resolve repository revision");

const decoder = new TextDecoder();
const paths = decoder.decode(filesResult.stdout).split("\0").filter(Boolean).sort();
const byTopLevel = new Map<string, { files: number; utf8Bytes: number }>();
let textFiles = 0;
let binaryFiles = 0;
let symbolicLinks = 0;
let utf8Bytes = 0;
let oversizedFiles = 0;
const largest: Array<{ path: string; utf8Bytes: number }> = [];

for (const path of paths) {
  const absolute = resolve(root, path);
  const relation = relative(root, absolute);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Tracked path escaped repository root: ${path}`);
  }
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) {
    symbolicLinks += 1;
    continue;
  }
  if (!metadata.isFile()) continue;
  if (metadata.size > 5_000_000) {
    oversizedFiles += 1;
    continue;
  }
  const bytes = new Uint8Array(await readFile(absolute));
  if (bytes.subarray(0, 8_192).includes(0)) {
    binaryFiles += 1;
    continue;
  }
  textFiles += 1;
  utf8Bytes += bytes.byteLength;
  const topLevel = path.includes("/") ? path.slice(0, path.indexOf("/")) : "(root)";
  const current = byTopLevel.get(topLevel) ?? { files: 0, utf8Bytes: 0 };
  current.files += 1;
  current.utf8Bytes += bytes.byteLength;
  byTopLevel.set(topLevel, current);
  largest.push({ path, utf8Bytes: bytes.byteLength });
}

largest.sort((left, right) =>
  right.utf8Bytes - left.utf8Bytes || compareDeepSeekInventoryNames(left.path, right.path)
);
const report = {
  version: 1,
  repository: basename(root),
  revision: decoder.decode(revisionResult.stdout).trim(),
  trackedFiles: paths.length,
  textFiles,
  binaryFiles,
  symbolicLinks,
  oversizedFiles,
  utf8Bytes,
  estimatedTokens: estimateRepositoryTokenRange(utf8Bytes),
  estimateNotice: "The token range is a byte-based planning estimate, not an exact DeepSeek tokenizer result.",
  byTopLevel: Object.fromEntries(
  [...byTopLevel.entries()].sort(([left], [right]) => compareDeepSeekInventoryNames(left, right)),
),
  largestTextFiles: largest.slice(0, 25),
};

console.log(JSON.stringify(report, null, 2));
