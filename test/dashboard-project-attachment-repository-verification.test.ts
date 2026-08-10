import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  readRepositoryVerification,
} from "../site/project-attachment-repository-verification-entry.js";

const project = "scrapbook";
const repositoryFullName = "teamleaderleo/scrapbook";
const commitSha = "a".repeat(40);
const sourceContentSha256 = `sha256:${"b".repeat(64)}`;
const attachmentSnapshotSha256 = `sha256:${"c".repeat(64)}`;

describe("System repository verification continuation", () => {
  test("installs after attachment review and calls only the bounded verification endpoint", async () => {
    const [bridge, verification, assets] = await Promise.all([
      readFile("site/hosted-session-bridge.js", "utf8"),
      readFile("site/project-attachment-repository-verification-entry.js", "utf8"),
      readFile("src/dashboard-assets.ts", "utf8"),
    ]);
    const reviewInstall = bridge.indexOf("installProjectAttachmentReviewAction();");
    const verifyInstall = bridge.indexOf("installProjectAttachmentRepositoryVerification();");
    expect(reviewInstall).toBeGreaterThanOrEqual(0);
    expect(verifyInstall).toBeGreaterThan(reviewInstall);
    expect(verification).toContain("accepted · verification pending");
    expect(verification).toContain("accepted · verifying repository");
    expect(verification).toContain("accepted · repository verified");
    expect(verification).toContain("/attachment/verify-repository");
    expect(verification).toContain("repositoryFullName: proposal.repositoryFullName");
    expect(verification).toContain("expectedDefaultBranch: proposal.defaultBranch");
    expect(verification).toContain("repositoryMetadata !== 'get_repo'");
    expect(verification).toContain("immutableFileRead !== 'fetch_file'");
    expect(verification).toContain("immutableReadRef !== 'exact_commit_sha'");
    expect(verification).not.toContain("github.com/");
    expect(assets).toContain('path: "/project-attachment-repository-verification-entry.js"');
  });

  test("admits only a complete server-owned exact-commit verification receipt", () => {
    expect(readRepositoryVerification({
      verification: {
        version: 1,
        project,
        repositoryFullName,
        defaultBranch: "main",
        commitSha,
        sourcePath: ".stensibly/STENSIBLY.md",
        sourceContentSha256,
        attachment: {
          id: "attach_repository_verify01",
          snapshotSha256: attachmentSnapshotSha256,
        },
        steps: {
          repositoryMetadata: "get_repo",
          immutableFileRead: "fetch_file",
          immutableReadRef: "exact_commit_sha",
        },
        verified: true,
        authorizesMutation: false,
        containsSecrets: false,
      },
    }, {
      project,
      repositoryFullName,
      defaultBranch: "main",
    })).toEqual({
      repositoryFullName,
      defaultBranch: "main",
      sourcePath: ".stensibly/STENSIBLY.md",
      commitSha,
      sourceContentSha256,
      attachmentId: "attach_repository_verify01",
      attachmentSnapshotSha256,
    });

    expect(() => readRepositoryVerification({
      verification: {
        version: 1,
        project,
        repositoryFullName,
        defaultBranch: "develop",
        commitSha,
        sourcePath: "STENSIBLY.md",
        sourceContentSha256,
        attachment: {
          id: "attach_repository_verify01",
          snapshotSha256: attachmentSnapshotSha256,
        },
        steps: {
          repositoryMetadata: "get_repo",
          immutableFileRead: "fetch_file",
          immutableReadRef: "exact_commit_sha",
        },
        verified: true,
        authorizesMutation: false,
        containsSecrets: false,
      },
    }, {
      project,
      repositoryFullName,
      defaultBranch: "main",
    })).toThrow("repository verification mismatch");

    expect(() => readRepositoryVerification({
      verification: {
        version: 1,
        project,
        repositoryFullName,
        defaultBranch: "main",
        commitSha,
        sourcePath: "../STENSIBLY.md",
        sourceContentSha256,
        attachment: {
          id: "attach_repository_verify01",
          snapshotSha256: attachmentSnapshotSha256,
        },
        steps: {
          repositoryMetadata: "get_repo",
          immutableFileRead: "fetch_file",
          immutableReadRef: "exact_commit_sha",
        },
        verified: true,
        authorizesMutation: false,
        containsSecrets: false,
      },
    }, {
      project,
      repositoryFullName,
      defaultBranch: "main",
    })).toThrow("repository verification identity mismatch");
  });
});
