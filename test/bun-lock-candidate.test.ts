import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareBunLockCandidate,
} from "../scripts/prepare-bun-lock-candidate.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Bun lockfile candidate preparation", () => {
  test("returns unchanged without retaining an artifact", () => {
    const directory = temporaryDirectory();
    const lockfile = join(directory, "bun.lock");
    writeFileSync(lockfile, "committed-lock\n");

    const result = prepareBunLockCandidate({
      cwd: directory,
      generate() {
        writeFileSync(lockfile, "committed-lock\n");
      },
    });

    expect(result.changed).toBe(false);
    expect(result.committedSha256).toBe(result.candidateSha256);
    expect(result.artifactDirectory).toBeNull();
    expect(readFileSync(lockfile, "utf8")).toBe("committed-lock\n");
  });

  test("writes an exact candidate artifact and restores the committed lock", () => {
    const directory = temporaryDirectory();
    const lockfile = join(directory, "bun.lock");
    writeFileSync(lockfile, "committed-lock\n");

    const result = prepareBunLockCandidate({
      cwd: directory,
      generate() {
        writeFileSync(lockfile, "generated-lock\n");
      },
    });

    expect(result.changed).toBe(true);
    expect(result.committedSha256).not.toBe(result.candidateSha256);
    expect(readFileSync(lockfile, "utf8")).toBe("committed-lock\n");
    expect(readFileSync(result.candidatePath!, "utf8")).toBe("generated-lock\n");
    expect(readFileSync(result.committedPath!, "utf8")).toBe("committed-lock\n");
    expect(JSON.parse(readFileSync(result.summaryPath!, "utf8"))).toEqual({
      version: 1,
      changed: true,
      committedSha256: result.committedSha256,
      candidateSha256: result.candidateSha256,
      candidateFile: "bun.lock",
      committedFile: "bun.lock.committed",
      generatedBy: "bun install --lockfile-only",
    });
  });

  test("restores the committed lock when generation fails", () => {
    const directory = temporaryDirectory();
    const lockfile = join(directory, "bun.lock");
    writeFileSync(lockfile, "committed-lock\n");

    expect(() => prepareBunLockCandidate({
      cwd: directory,
      generate() {
        writeFileSync(lockfile, "partial-generated-lock\n");
        throw new Error("simulated registry failure");
      },
    })).toThrow("simulated registry failure");

    expect(readFileSync(lockfile, "utf8")).toBe("committed-lock\n");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "stensibly-bun-lock-"));
  directories.push(directory);
  return directory;
}
