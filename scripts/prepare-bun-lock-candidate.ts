import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface BunLockCandidateOptions {
  cwd: string;
  lockfilePath?: string;
  artifactDirectory?: string;
  generate?: () => void;
}

export interface BunLockCandidateResult {
  changed: boolean;
  committedSha256: string;
  candidateSha256: string;
  artifactDirectory: string | null;
  candidatePath: string | null;
  committedPath: string | null;
  summaryPath: string | null;
}

export function prepareBunLockCandidate(
  options: BunLockCandidateOptions,
): BunLockCandidateResult {
  const cwd = resolve(options.cwd);
  const lockfilePath = resolve(
    cwd,
    options.lockfilePath ?? "bun.lock",
  );
  const artifactDirectory = resolve(
    cwd,
    options.artifactDirectory ?? "artifacts/bun-lock-candidate",
  );
  const committed = readFileSync(lockfilePath);
  const committedSha256 = sha256(committed);

  rmSync(artifactDirectory, { recursive: true, force: true });

  try {
    (options.generate ?? (() => generateLockfile(cwd)))();
    const candidate = readFileSync(lockfilePath);
    const candidateSha256 = sha256(candidate);
    const changed = !candidate.equals(committed);

    if (!changed) {
      return {
        changed: false,
        committedSha256,
        candidateSha256,
        artifactDirectory: null,
        candidatePath: null,
        committedPath: null,
        summaryPath: null,
      };
    }

    mkdirSync(artifactDirectory, { recursive: true });
    const candidatePath = join(artifactDirectory, "bun.lock");
    const committedPath = join(artifactDirectory, "bun.lock.committed");
    const summaryPath = join(artifactDirectory, "summary.json");
    writeFileSync(candidatePath, candidate);
    writeFileSync(committedPath, committed);
    writeFileSync(
      summaryPath,
      `${JSON.stringify({
        version: 1,
        changed: true,
        committedSha256,
        candidateSha256,
        candidateFile: "bun.lock",
        committedFile: "bun.lock.committed",
        generatedBy: "bun install --lockfile-only",
      }, null, 2)}\n`,
    );

    return {
      changed: true,
      committedSha256,
      candidateSha256,
      artifactDirectory,
      candidatePath,
      committedPath,
      summaryPath,
    };
  } finally {
    writeFileSync(lockfilePath, committed);
  }
}

function generateLockfile(cwd: string): void {
  const result = spawnSync(
    process.execPath,
    ["install", "--lockfile-only"],
    {
      cwd,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter((value) => value?.trim())
      .join("\n")
      .trim();
    throw new Error(
      detail
        ? `bun install --lockfile-only failed:\n${detail}`
        : `bun install --lockfile-only exited with status ${result.status}`,
    );
  }
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function appendGithubOutput(result: BunLockCandidateResult): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    [
      `changed=${result.changed}`,
      `committed_sha256=${result.committedSha256}`,
      `candidate_sha256=${result.candidateSha256}`,
      `artifact_directory=${result.artifactDirectory ?? ""}`,
      "",
    ].join("\n"),
    { flag: "a" },
  );
}

function isDirectExecution(): boolean {
  const current = process.argv[1];
  if (!current) return false;
  return resolve(current) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  try {
    const result = prepareBunLockCandidate({ cwd: process.cwd() });
    appendGithubOutput(result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
