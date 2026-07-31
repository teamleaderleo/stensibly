import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isForbiddenBrowserEvidenceName } from "./browser-evidence-policy.ts";

const defaultRepositoryRoot = resolve(import.meta.dir, "..");
const maximumFiles = 2_000;
const maximumFileBytes = 20 * 1_024 * 1_024;
const maximumTotalBytes = 75 * 1_024 * 1_024;
const maximumPngDimension = 10_000;
const maximumPngPixels = 50_000_000;
const maximumLastRunTests = 10_000;
const maximumLastRunIdentityLength = 512;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const allowedPngChunks = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "sRGB",
  "gAMA",
  "cHRM",
  "pHYs",
]);
const uninspectableArchiveSuffixes = [
  ".7z",
  ".br",
  ".bz2",
  ".gz",
  ".rar",
  ".tar",
  ".tgz",
  ".xz",
  ".zip",
];
const credentialPatterns = [
  { name: "Stensibly token", pattern: /stn\.tok_[A-Za-z0-9._-]{8,}/u },
  { name: "GitHub fine-grained token", pattern: /github_pat_[A-Za-z0-9_]{20,}/u },
  { name: "GitHub classic token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/u },
  { name: "OpenAI-style secret", pattern: /sk-[A-Za-z0-9_-]{20,}/u },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/u },
];

export interface BrowserEvidenceArtifactSummary {
  readonly version: 1;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly requiredRoots: readonly string[];
  readonly containsCredentials: false;
}

export async function verifyBrowserEvidenceArtifacts(
  repositoryRoot = defaultRepositoryRoot,
): Promise<BrowserEvidenceArtifactSummary> {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const reportRoot = resolve(resolvedRepositoryRoot, "artifacts", "playwright-report");
  const reportPath = resolve(reportRoot, "report.json");
  const resultsRoot = resolve(resolvedRepositoryRoot, "artifacts", "playwright-results");
  const lastRunPath = resolve(resultsRoot, ".last-run.json");
  const outputPath = resolve(resolvedRepositoryRoot, "browser-test-output.txt");
  const rootsToInspect = [reportRoot, resultsRoot, outputPath];
  const requiredRoots = [reportPath, resultsRoot, outputPath] as const;
  const inspectedFiles = new Set<string>();
  const reportedAttachmentPaths = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;
  let resourceLimitExceeded = false;
  const missingRequiredRoots = new Set<string>();
  const violations: string[] = [];

  for (const root of rootsToInspect) {
    if (resourceLimitExceeded) break;
    try {
      await inspect(root);
    } catch (error) {
      if (isMissing(error)) {
        missingRequiredRoots.add(relativePath(root === reportRoot ? reportPath : root));
        continue;
      }
      throw error;
    }
  }

  if (!inspectedFiles.has(reportPath)) missingRequiredRoots.add(relativePath(reportPath));
  if (missingRequiredRoots.size) {
    violations.push(`missing required evidence roots: ${[...missingRequiredRoots].join(", ")}`);
  }

  for (const attachmentPath of reportedAttachmentPaths) {
    if (!inspectedFiles.has(attachmentPath)) {
      violations.push(`${relativePath(attachmentPath)} is referenced by the report but missing from verified results`);
    }
  }
  for (const inspectedPath of inspectedFiles) {
    if (isInside(reportRoot, inspectedPath) && inspectedPath !== reportPath) {
      violations.push(`${relativePath(inspectedPath)} is an unreferenced browser report file`);
    }
    if (isInside(resultsRoot, inspectedPath) && inspectedPath !== lastRunPath && !reportedAttachmentPaths.has(inspectedPath)) {
      violations.push(`${relativePath(inspectedPath)} is an unreferenced browser result file`);
    }
  }
  if (!reportedAttachmentPaths.size && inspectedFiles.has(reportPath)) {
    violations.push("artifacts/playwright-report/report.json contains no path-backed evidence attachments");
  }

  if (violations.length) {
    throw new Error(`Frontend browser evidence failed the artifact fence:\n- ${violations.join("\n- ")}`);
  }

  return Object.freeze({
    version: 1,
    fileCount,
    totalBytes,
    requiredRoots: Object.freeze(requiredRoots.map(relativePath)),
    containsCredentials: false,
  });

  async function inspect(path: string): Promise<void> {
    if (resourceLimitExceeded) return;
    if (isForbiddenBrowserEvidenceName(path)) {
      violations.push(`${relativePath(path)} has a forbidden private-data filename`);
      return;
    }
    if (isUninspectableArchive(path)) {
      violations.push(`${relativePath(path)} is an uninspectable compressed archive`);
      return;
    }

    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      violations.push(`${relativePath(path)} is a symbolic link`);
      return;
    }
    if (metadata.isDirectory()) {
      const children = await readdir(path);
      for (const child of children) {
        await inspect(join(path, child));
        if (resourceLimitExceeded) return;
      }
      return;
    }
    if (!metadata.isFile()) {
      violations.push(`${relativePath(path)} is not a regular file`);
      return;
    }

    const resolvedPath = resolve(path);
    inspectedFiles.add(resolvedPath);
    fileCount += 1;
    if (fileCount > maximumFiles) {
      violations.push(`evidence contains more than ${maximumFiles} files at ${relativePath(path)}`);
      resourceLimitExceeded = true;
      return;
    }

    totalBytes += metadata.size;
    if (totalBytes > maximumTotalBytes) {
      violations.push(`evidence exceeds ${maximumTotalBytes} total bytes at ${relativePath(path)}`);
      resourceLimitExceeded = true;
      return;
    }

    if (metadata.size > maximumFileBytes) {
      violations.push(`${relativePath(path)} is ${metadata.size} bytes; maximum per file is ${maximumFileBytes}`);
      return;
    }

    const bytes = await readFile(path);
    if (resolvedPath === reportPath) inspectJsonReport(bytes);
    if (resolvedPath === lastRunPath) inspectLastRun(bytes);
    if (basename(path).toLocaleLowerCase("en-US").endsWith(".png")) inspectPng(bytes, path);

    const content = bytes.toString("latin1");
    for (const candidate of credentialPatterns) {
      if (candidate.pattern.test(content)) {
        violations.push(`${relativePath(path)} contains a ${candidate.name} pattern`);
      }
    }
  }

  function inspectJsonReport(bytes: Buffer): void {
    let report: unknown;
    try {
      report = JSON.parse(bytes.toString("utf8"));
    } catch {
      violations.push("artifacts/playwright-report/report.json is invalid JSON");
      return;
    }
    walkJsonReport(report, "report");
  }

  function walkJsonReport(value: unknown, location: string): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walkJsonReport(entry, `${location}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    if (typeof record.body === "string" || typeof record.buffer === "string") {
      violations.push(`artifacts/playwright-report/report.json contains an opaque in-memory payload at ${location}`);
    }
    if (Array.isArray(record.attachments)) {
      for (const [index, attachment] of record.attachments.entries()) {
        if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
          violations.push(`artifacts/playwright-report/report.json has an invalid attachment at ${location}.attachments[${index}]`);
          continue;
        }
        const attachmentRecord = attachment as Record<string, unknown>;
        if (typeof attachmentRecord.body === "string") {
          violations.push(`artifacts/playwright-report/report.json embeds attachment bytes at ${location}.attachments[${index}]`);
          continue;
        }
        if (typeof attachmentRecord.path !== "string") {
          violations.push(`artifacts/playwright-report/report.json attachment lacks a path at ${location}.attachments[${index}]`);
          continue;
        }
        const attachmentPath = resolve(attachmentRecord.path);
        if (!isInside(resultsRoot, attachmentPath)) {
          violations.push(`report attachment path escapes verified results: ${attachmentRecord.path}`);
          continue;
        }
        reportedAttachmentPaths.add(attachmentPath);
      }
    }
    for (const [key, nested] of Object.entries(record)) {
      if (key !== "attachments") walkJsonReport(nested, `${location}.${key}`);
    }
  }

  function inspectLastRun(bytes: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      violations.push("artifacts/playwright-results/.last-run.json is invalid JSON");
      return;
    }
    if (!isPlainRecord(value)) {
      violations.push("artifacts/playwright-results/.last-run.json must be an object");
      return;
    }
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "failedTests,status,testDurations") {
      violations.push("artifacts/playwright-results/.last-run.json must use exact Playwright 1.62 control fields");
      return;
    }
    if (value.status !== "passed") {
      violations.push("artifacts/playwright-results/.last-run.json must record a passed browser run");
    }
    if (!Array.isArray(value.failedTests) || value.failedTests.length !== 0) {
      violations.push("artifacts/playwright-results/.last-run.json must contain no failed test identities");
    }
    if (!isPlainRecord(value.testDurations) || Object.keys(value.testDurations).length > maximumLastRunTests) {
      violations.push("artifacts/playwright-results/.last-run.json has invalid test durations");
      return;
    }
    for (const [id, duration] of Object.entries(value.testDurations)) {
      if (
        id.length < 1
        || id.length > maximumLastRunIdentityLength
        || typeof duration !== "number"
        || !Number.isFinite(duration)
        || duration < 0
      ) {
        violations.push("artifacts/playwright-results/.last-run.json has invalid test durations");
        break;
      }
    }
  }

  function inspectPng(bytes: Buffer, path: string): void {
    const label = relativePath(path);
    if (bytes.length < pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
      violations.push(`${label} has an invalid PNG signature`);
      return;
    }

    let offset = pngSignature.length;
    let chunkIndex = 0;
    let sawHeader = false;
    let sawImageData = false;
    let sawEnd = false;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) {
        violations.push(`${label} has a truncated PNG chunk`);
        return;
      }
      const dataLength = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      const nextOffset = offset + 12 + dataLength;
      if (nextOffset > bytes.length) {
        violations.push(`${label} has a PNG chunk outside the file boundary`);
        return;
      }
      if (!/^[A-Za-z]{4}$/u.test(type) || !allowedPngChunks.has(type)) {
        violations.push(`${label} contains disallowed PNG metadata chunk ${type || "unknown"}`);
        return;
      }
      if (chunkIndex === 0 && type !== "IHDR") {
        violations.push(`${label} must begin with a PNG IHDR chunk`);
        return;
      }
      if (type === "IHDR") {
        if (sawHeader || dataLength !== 13) {
          violations.push(`${label} has an invalid PNG IHDR chunk`);
          return;
        }
        sawHeader = true;
        const width = bytes.readUInt32BE(offset + 8);
        const height = bytes.readUInt32BE(offset + 12);
        if (width < 1 || height < 1 || width > maximumPngDimension || height > maximumPngDimension || width * height > maximumPngPixels) {
          violations.push(`${label} has PNG dimensions outside the reviewed bounds`);
          return;
        }
      } else if (type === "IDAT") {
        sawImageData = true;
      } else if (type === "IEND") {
        if (dataLength !== 0 || nextOffset !== bytes.length) {
          violations.push(`${label} has an invalid PNG IEND chunk`);
          return;
        }
        sawEnd = true;
      }
      offset = nextOffset;
      chunkIndex += 1;
    }
    if (!sawHeader || !sawImageData || !sawEnd) {
      violations.push(`${label} is missing required PNG image chunks`);
    }
  }

  function relativePath(path: string): string {
    const prefix = `${resolvedRepositoryRoot}${sep}`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await verifyBrowserEvidenceArtifacts(), null, 2));
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isUninspectableArchive(path: string): boolean {
  const name = basename(path).toLocaleLowerCase("en-US");
  return uninspectableArchiveSuffixes.some((suffix) => name.endsWith(suffix));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
