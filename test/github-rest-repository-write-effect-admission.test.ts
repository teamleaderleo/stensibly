import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
} from "../src/github-rest-repository-write-adapter.ts";
import type {
  GitHubRepositoryWritePayload,
} from "../src/github-repository-write-provider-service.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const path = "docs/provider-sync.md";
const targetRef = "main";
const parentSha = "1".repeat(40);
const commitSha = "2".repeat(40);
const previousContentSha = "3".repeat(40);
const requestId = "REQ-REPOSITORY-EFFECT";
const fixedEffectError =
  "GitHub repository write response file effect was invalid";

describe("GitHub repository write file-effect admission", () => {
  test("admits exact create, update, and delete response effects", async () => {
    const createContent = "created\n";
    const updateContent = "updated\n";

    const created = await dispatch(
      "create_file",
      { operation: "create_file", content: createContent, message: "Create file" },
      writeResponse(contentObject(createContent)),
    );
    expect(created).toEqual({
      commitSha,
      providerRequestId: requestId,
      targetRef,
      parentSha,
    });

    const updated = await dispatch(
      "update_file",
      {
        operation: "update_file",
        content: updateContent,
        contentSha: previousContentSha,
        message: "Update file",
      },
      writeResponse(contentObject(updateContent)),
    );
    expect(updated).toEqual({
      commitSha,
      providerRequestId: requestId,
      targetRef,
      parentSha,
    });

    const deleted = await dispatch(
      "delete_file",
      {
        operation: "delete_file",
        contentSha: previousContentSha,
        message: "Delete file",
      },
      writeResponse(null),
    );
    expect(deleted).toEqual({
      commitSha,
      providerRequestId: requestId,
      targetRef,
      parentSha,
    });
  });

  test("rejects null create and update content", async () => {
    for (const [operation, payload] of [
      [
        "create_file",
        { operation: "create_file", content: "created\n", message: "Create file" },
      ],
      [
        "update_file",
        {
          operation: "update_file",
          content: "updated\n",
          contentSha: previousContentSha,
          message: "Update file",
        },
      ],
    ] as const) {
      await expect(dispatch(operation, payload, writeResponse(null)))
        .rejects.toThrow(fixedEffectError);
    }
  });

  test("rejects a response for another path", async () => {
    const content = "created\n";
    await expect(dispatch(
      "create_file",
      { operation: "create_file", content, message: "Create file" },
      writeResponse({ ...contentObject(content), path: "docs/other.md" }),
    )).rejects.toThrow(fixedEffectError);
  });

  test("rejects a response whose blob identity does not match requested UTF-8 bytes", async () => {
    const content = "created\n";
    await expect(dispatch(
      "create_file",
      { operation: "create_file", content, message: "Create file" },
      writeResponse({ ...contentObject(content), sha: "4".repeat(40) }),
    )).rejects.toThrow(fixedEffectError);
  });

  test("rejects a response whose content URL leaves the exact repository", async () => {
    const content = "created\n";
    await expect(dispatch(
      "create_file",
      { operation: "create_file", content, message: "Create file" },
      writeResponse({
        ...contentObject(content),
        url: `https://api.github.com/repos/teamleaderleo/other/contents/${encodedPath()}`,
      }),
    )).rejects.toThrow(fixedEffectError);
  });

  test("rejects directory, symlink, and submodule response types", async () => {
    const content = "created\n";
    for (const type of ["dir", "symlink", "submodule"] as const) {
      await expect(dispatch(
        "create_file",
        { operation: "create_file", content, message: "Create file" },
        writeResponse({ ...contentObject(content), type }),
      )).rejects.toThrow(fixedEffectError);
    }
  });

  test("rejects a delete response that still returns content", async () => {
    await expect(dispatch(
      "delete_file",
      {
        operation: "delete_file",
        contentSha: previousContentSha,
        message: "Delete file",
      },
      writeResponse(contentObject("replacement\n")),
    )).rejects.toThrow(fixedEffectError);
  });
});

async function dispatch(
  operation: "create_file" | "update_file" | "delete_file",
  payload: GitHubRepositoryWritePayload,
  response: Response,
) {
  const adapter = new GitHubRestRepositoryWriteAdapter({
    tokenProvider: {
      async getRepositoryContentsToken() {
        return {
          token: "installation-token",
          expiresAt: "2026-08-03T11:00:00.000Z",
        };
      },
    },
    fetch: (async () => response) as typeof fetch,
  });
  return await adapter.dispatchRepositoryWrite({
    repositoryFullName,
    path,
    operation,
    targetRef,
    expectedParentSha: parentSha,
    payload,
    idempotencyKey: `repository-effect-${operation}`,
  });
}

function writeResponse(content: unknown): Response {
  return Response.json({
    content,
    commit: {
      sha: commitSha,
      url: `https://api.github.com/repos/${repositoryFullName}/git/commits/${commitSha}`,
      parents: [{
        sha: parentSha,
        url: `https://api.github.com/repos/${repositoryFullName}/git/commits/${parentSha}`,
      }],
    },
  }, {
    status: 200,
    headers: { "x-github-request-id": requestId },
  });
}

function contentObject(content: string) {
  const bytes = Buffer.from(content, "utf8");
  const sha = gitBlobSha(bytes);
  const url = `https://api.github.com/repos/${repositoryFullName}/contents/${encodedPath()}`;
  const gitUrl = `https://api.github.com/repos/${repositoryFullName}/git/blobs/${sha}`;
  const htmlUrl = `https://github.com/${repositoryFullName}/blob/${commitSha}/${path}`;
  return {
    name: "provider-sync.md",
    path,
    sha,
    size: bytes.byteLength,
    url,
    html_url: htmlUrl,
    git_url: gitUrl,
    download_url:
      `https://raw.githubusercontent.com/${repositoryFullName}/${commitSha}/${path}`,
    type: "file",
    _links: {
      self: url,
      git: gitUrl,
      html: htmlUrl,
    },
  };
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function encodedPath(): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
