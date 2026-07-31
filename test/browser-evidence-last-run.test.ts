import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyBrowserEvidenceArtifacts } from "../scripts/verify-browser-evidence-artifacts.ts";

describe("Playwright last-run browser evidence control", () => {
  test("accepts the exact passed Playwright 1.62 control envelope", async () => {
    const fixture = createEvidenceFixture({
      status: "passed",
      failedTests: [],
    });
    try {
      const summary = await verifyBrowserEvidenceArtifacts(fixture.root);
      expect(summary.fileCount).toBe(5);
      expect(summary.totalBytes).toBe(fixture.totalBytes);
      expect(summary.containsCredentials).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects unknown control fields", async () => {
    const fixture = createEvidenceFixture({
      status: "passed",
      failedTests: [],
      testDurations: { "chromium::frontend-labs::catalogue": 147 },
    });
    try {
      await expect(verifyBrowserEvidenceArtifacts(fixture.root)).rejects.toThrow(
        "must use exact Playwright 1.62 control fields",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects failed status and failed test identities", async () => {
    for (const lastRun of [
      { status: "failed", failedTests: ["fixture failure"] },
      { status: "passed", failedTests: ["fixture failure"] },
    ]) {
      const fixture = createEvidenceFixture(lastRun);
      try {
        await expect(verifyBrowserEvidenceArtifacts(fixture.root)).rejects.toThrow();
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });
});

function createEvidenceFixture(lastRun: unknown) {
  const root = mkdtempSync(join(tmpdir(), "stensibly-browser-last-run-"));
  const reportDirectory = join(root, "artifacts", "playwright-report");
  const resultsDirectory = join(root, "artifacts", "playwright-results");
  const receiptPath = join(resultsDirectory, "receipt.json");
  const imagePath = join(resultsDirectory, "evidence.png");
  const lastRunPath = join(resultsDirectory, ".last-run.json");
  const outputPath = join(root, "browser-test-output.txt");
  mkdirSync(reportDirectory, { recursive: true });
  mkdirSync(resultsDirectory, { recursive: true });

  const report = JSON.stringify({
    suites: [{
      specs: [{
        tests: [{
          results: [{
            attachments: [
              { name: "receipt.json", contentType: "application/json", path: receiptPath },
              { name: "evidence.png", contentType: "image/png", path: imagePath },
            ],
          }],
        }],
      }],
    }],
  });
  const receipt = JSON.stringify({ fixture: "paper-lantern" });
  const image = pngEvidence();
  const lastRunJson = JSON.stringify(lastRun);
  const output = "browser run completed";

  writeFileSync(join(reportDirectory, "report.json"), report);
  writeFileSync(receiptPath, receipt);
  writeFileSync(imagePath, image);
  writeFileSync(lastRunPath, lastRunJson);
  writeFileSync(outputPath, output);

  return {
    root,
    totalBytes: Buffer.byteLength(report)
      + Buffer.byteLength(receipt)
      + image.length
      + Buffer.byteLength(lastRunJson)
      + Buffer.byteLength(output),
  };
}

function pngEvidence(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
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
