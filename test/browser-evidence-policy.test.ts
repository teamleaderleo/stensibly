import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isForbiddenBrowserEvidenceName,
  validatePlaywrightMcpArgs,
} from "../scripts/browser-evidence-policy.ts";
import { verifyBrowserEvidenceArtifacts } from "../scripts/verify-browser-evidence-artifacts.ts";

const repositoryRoot = join(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const playwrightConfig = readFileSync(join(repositoryRoot, "playwright.config.ts"), "utf8");
const browserSuite = readFileSync(join(repositoryRoot, "browser-tests", "frontend-labs.spec.ts"), "utf8");
const serviceWorkerSuite = readFileSync(join(repositoryRoot, "browser-tests", "frontend-service-worker-boundary.spec.ts"), "utf8");
const fixtureServer = readFileSync(join(repositoryRoot, "scripts", "serve-frontend-fixtures.ts"), "utf8");
const launcher = readFileSync(join(repositoryRoot, "scripts", "run-playwright-mcp.ts"), "utf8");
const verifier = readFileSync(join(repositoryRoot, "scripts", "verify-browser-evidence-artifacts.ts"), "utf8");

const acceptedArgs = [
  "--isolated",
  "--headless",
  "--sandbox",
  "--block-service-workers",
  "--allowed-origins",
  "https://example.com;http://127.0.0.1:4173",
  "--image-responses",
  "omit",
  "--output-mode",
  "file",
  "--output-dir",
  "/tmp/stensibly-browser-research/run-17",
  "--output-max-size",
  "25000000",
  "--viewport-size",
  "1440x900",
] as const;

describe("browser evidence policy", () => {
  test("admits only the reviewed isolated MCP profile", () => {
    expect(validatePlaywrightMcpArgs(acceptedArgs, repositoryRoot)).toEqual([...acceptedArgs]);
    expect(validatePlaywrightMcpArgs(["--help"], repositoryRoot)).toEqual(["--help"]);
    expect(() => validatePlaywrightMcpArgs([], repositoryRoot)).toThrow("reviewed isolated research arguments");
    expect(() => validatePlaywrightMcpArgs(acceptedArgs.filter((arg) => arg !== "--isolated"), repositoryRoot)).toThrow("requires --isolated");
    expect(() => validatePlaywrightMcpArgs([...acceptedArgs, "--storage-state", "/tmp/state.json"], repositoryRoot)).toThrow("reviewed switch set");
    expect(() => validatePlaywrightMcpArgs([...acceptedArgs, "--allowed-origins", "https://other.example"], repositoryRoot)).toThrow("appears more than once");
    expect(() => validatePlaywrightMcpArgs(replaceValue(acceptedArgs, "--allowed-origins", "http://example.com"), repositoryRoot)).toThrow("HTTPS or loopback HTTP");
    expect(() => validatePlaywrightMcpArgs(replaceValue(acceptedArgs, "--allowed-origins", "https://example.com/path"), repositoryRoot)).toThrow("exact credential-free origin");
    expect(() => validatePlaywrightMcpArgs(replaceValue(acceptedArgs, "--output-dir", join(repositoryRoot, "artifacts", "research")), repositoryRoot)).toThrow("outside the repository after symlink resolution");
    expect(() => validatePlaywrightMcpArgs(replaceValue(acceptedArgs, "--output-max-size", "25000001"), repositoryRoot)).toThrow("1-25000000 bytes");
  });

  test("keeps hostile MCP values out of validation diagnostics", () => {
    const secret = "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const cases: readonly (readonly string[])[] = [
      [secret],
      replaceValue(acceptedArgs, "--allowed-origins", `https://${secret}@example.com`),
      replaceValue(acceptedArgs, "--allowed-origins", `${secret}://example.com`),
    ];

    for (const args of cases) {
      let message = "";
      try {
        validatePlaywrightMcpArgs(args, repositoryRoot);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(secret);
    }
  });

  test("rejects an outside-looking MCP output path that resolves into the repository", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "stensibly-browser-policy-"));
    const linkedRepository = join(temporaryRoot, "linked-repository");
    try {
      symlinkSync(repositoryRoot, linkedRepository, "dir");
      const args = replaceValue(acceptedArgs, "--output-dir", join(linkedRepository, "artifacts", "research"));
      expect(() => validatePlaywrightMcpArgs(args, repositoryRoot)).toThrow("outside the repository after symlink resolution");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects private browser-profile filename families case-insensitively", () => {
    for (const name of [
      ".env",
      ".ENV.production",
      ".Dev.Vars.local",
      "Cookies",
      "Cookies-journal",
      "StorageState.json",
      "storage_state.JSON",
      "profile/Bookmarks",
      "profile/Cache",
      "profile/History-journal",
      "profile/Login Data-shm",
      "profile/Local Storage",
      "profile/Service Worker",
      "profile/Sessions",
      "profile/Web Data",
      "trace.sqlite",
      "trace.SQLITE-WAL",
    ]) {
      expect(isForbiddenBrowserEvidenceName(name), name).toBe(true);
    }
    for (const name of ["catalogue-wide.png", "fixture-state.json", "cookie-policy.txt", "trace.zip"]) {
      expect(isForbiddenBrowserEvidenceName(name), name).toBe(false);
    }
  });

  test("accepts one complete path-backed Playwright 1.62 evidence set", async () => {
    const evidence = createEvidenceRoot();
    try {
      const summary = await verifyBrowserEvidenceArtifacts(evidence.root);
      expect(summary).toEqual({
        version: 1,
        fileCount: 5,
        totalBytes: evidence.totalBytes,
        requiredRoots: [
          "artifacts/playwright-report/report.json",
          "artifacts/playwright-results",
          "browser-test-output.txt",
        ],
        containsCredentials: false,
      });
      expect(Object.isFrozen(summary)).toBe(true);
      expect(Object.isFrozen(summary.requiredRoots)).toBe(true);
    } finally {
      evidence.remove();
    }
  });

  test("rejects extra, failed, and nonempty Playwright control envelopes", async () => {
    for (const lastRun of [
      { status: "passed", failedTests: [], testDurations: {} },
      { status: "failed", failedTests: [] },
      { status: "passed", failedTests: ["browser-case"] },
    ]) {
      const evidence = createEvidenceRoot(lastRun);
      try {
        await expect(verifyBrowserEvidenceArtifacts(evidence.root)).rejects.toThrow();
      } finally {
        evidence.remove();
      }
    }
  });

  test("distinguishes long task identities from OpenAI-style secrets", async () => {
    const evidence = createEvidenceRoot();
    try {
      writeFileSync(evidence.receiptPath, JSON.stringify({
        caseId: "task-recommended-work--wide-no-preference-fixture-paper-lantern",
      }));
      await expect(verifyBrowserEvidenceArtifacts(evidence.root)).resolves.toMatchObject({
        containsCredentials: false,
      });

      writeFileSync(evidence.receiptPath, JSON.stringify({
        secret: "sk-abcdefghijklmnopqrstuvwxyz123456",
      }));
      await expect(verifyBrowserEvidenceArtifacts(evidence.root)).rejects.toThrow(
        "contains a OpenAI-style secret pattern",
      );
    } finally {
      evidence.remove();
    }
  });

  test("rejects compressed, embedded, escaped, unreferenced, and metadata-bearing evidence", async () => {
    const cases: Array<(evidence: ReturnType<typeof createEvidenceRoot>) => void> = [
      (evidence) => {
        const archive = join(evidence.resultsRoot, "trace.zip");
        writeFileSync(archive, "opaque archive");
        writeFileSync(evidence.reportPath, reportWithAttachments([archive]));
      },
      (evidence) => {
        writeFileSync(evidence.reportPath, JSON.stringify({ suites: [{ specs: [{ tests: [{ results: [{ attachments: [{ name: "opaque", contentType: "application/json", body: "e30=" }] }] }] }] }] }));
      },
      (evidence) => {
        const outside = join(evidence.root, "outside.json");
        writeFileSync(outside, "{}");
        writeFileSync(evidence.reportPath, reportWithAttachments([outside]));
      },
      (evidence) => {
        writeFileSync(join(evidence.resultsRoot, "unreferenced.json"), "{}");
      },
      (evidence) => {
        const image = join(evidence.resultsRoot, "evidence.png");
        writeFileSync(image, pngEvidence([pngChunk("tEXt", Buffer.from("note\0private"))]));
      },
    ];

    for (const mutate of cases) {
      const evidence = createEvidenceRoot();
      try {
        mutate(evidence);
        await expect(verifyBrowserEvidenceArtifacts(evidence.root)).rejects.toThrow();
      } finally {
        evidence.remove();
      }
    }
  });

  test("routes repository scripts through deterministic path-backed evidence", () => {
    expect(packageJson.scripts["browser:mcp"]).toBe("bun scripts/run-playwright-mcp.ts");
    expect(packageJson.scripts["test:browser"]).toBe("playwright test");
    expect(launcher).toContain("validatePlaywrightMcpArgs");
    expect(launcher).toContain('["bunx", "playwright", "mcp", ...args]');
    expect(verifier).not.toContain("testDurations");
    expect(verifier).toContain('keys.join(",") !== "failedTests,status"');
    expect(verifier).toContain("uninspectable compressed archive");
    expect(verifier).toContain("opaque in-memory payload");
    expect(verifier).toContain("disallowed PNG metadata chunk");
    expect(browserSuite).toContain("testInfo.attach(name, { path: sourcePath, contentType:");
    expect(browserSuite).toContain("maximumAttachmentStemLength");
    expect(browserSuite).not.toContain("testInfo.attach(name, { body:");
    expect(serviceWorkerSuite).toContain("navigator.serviceWorker.register");
    expect(serviceWorkerSuite).toContain("context.serviceWorkers()");
    expect(fixtureServer).toContain("worker-src 'none'");
    expect(playwrightConfig).toContain("retries: 0");
    expect(playwrightConfig).toContain('["json", { outputFile: "artifacts/playwright-report/report.json" }]');
    expect(playwrightConfig).not.toContain('serviceWorkers: "block"');
    expect(playwrightConfig).not.toContain('["html"');
  });
});

function replaceValue(args: readonly string[], flag: string, value: string): string[] {
  const copy = [...args];
  const index = copy.indexOf(flag);
  if (index < 0) throw new Error(`Missing test flag ${flag}`);
  copy[index + 1] = value;
  return copy;
}

function createEvidenceRoot(lastRun: unknown = {
  status: "passed",
  failedTests: [],
}) {
  const root = mkdtempSync(join(tmpdir(), "stensibly-browser-artifacts-"));
  const reportRoot = join(root, "artifacts", "playwright-report");
  const resultsRoot = join(root, "artifacts", "playwright-results");
  const reportPath = join(reportRoot, "report.json");
  const receiptPath = join(resultsRoot, "receipt.json");
  const imagePath = join(resultsRoot, "evidence.png");
  const outputPath = join(root, "browser-test-output.txt");
  mkdirSync(reportRoot, { recursive: true });
  mkdirSync(resultsRoot, { recursive: true });

  const report = reportWithAttachments([receiptPath, imagePath]);
  const receipt = JSON.stringify({ fixture: "paper-lantern" });
  const image = pngEvidence();
  const lastRunJson = JSON.stringify(lastRun);
  const output = "browser run completed";
  writeFileSync(reportPath, report);
  writeFileSync(receiptPath, receipt);
  writeFileSync(imagePath, image);
  writeFileSync(join(resultsRoot, ".last-run.json"), lastRunJson);
  writeFileSync(outputPath, output);

  return {
    root,
    reportRoot,
    reportPath,
    resultsRoot,
    receiptPath,
    outputPath,
    totalBytes: Buffer.byteLength(report) + Buffer.byteLength(receipt) + image.length + Buffer.byteLength(lastRunJson) + Buffer.byteLength(output),
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function reportWithAttachments(paths: readonly string[]): string {
  return JSON.stringify({
    suites: [{ specs: [{ tests: [{ results: [{ attachments: paths.map((path) => ({
      name: path.endsWith(".png") ? "evidence.png" : "receipt.json",
      contentType: path.endsWith(".png") ? "image/png" : "application/json",
      path,
    })) }] }] }] }],
  });
}

function pngEvidence(extraChunks: readonly Buffer[] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...extraChunks,
    pngChunk("IDAT", Buffer.from([0])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}
