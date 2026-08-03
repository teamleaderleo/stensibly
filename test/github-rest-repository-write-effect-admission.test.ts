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
      writeResponse(contentObject(createContent), 201),
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
      writeResponse(contentObject(updateContent), 200),
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
      writeResponse(null, 200),
    );
    expect(deleted).toEqual({
      commitSha,
      providerRequestId: requestId,
      targetRef,
      parentSha,
    });
  });

  test("rejects successful statuses from another file operation", async () => {
    const createPayload = {
      operation: "create_file" as const,
      content: "created\n",
      message: "Create file",
    };
    await expect(dispatch(
      "create_file",
      createPayload,
      writeResponse(contentObject(createPayload.content), 200),
    )).rejects.toThrow(fixedEffectError);

    const updatePayload = {
      operation: "update_file" as const,
      content: "updated\n",
      contentSha: previousContentSha,
      message: "Update file",
    };
    await expect(dispatch(
      "update_file",
      updatePayload,
      writeResponse(contentObject(updatePayload.content), 201),
    )).rejects.toThrow(fixedEffectError);

    const deletePayload = {
      operation: "delete_file" as const,
      contentSha: previousContentSha,
      message: "Delete file",
    };
    await expect(dispatch(
      "delete_file",
      deletePayload,
      writeResponse(null, 201),
    )).rejects.toThrow(fixedEffectError);
  });

  test("rejects null create and update content", async () => {
    for (const [operation, payload, status] of [
      [
        "create_file",
        { operation: "create_file", content: "created\n", message: "Create file" },
        201,
      ],
      [
        "update_file",
        {
          operation: "update_file",
          content: "updated\n",
          contentSha: previousContentSha,
          message: "Update file",
        },
        200,
      ],
    ] as const) {
      await expect(dispatch(operation, payload, writeResponse(null, status)))
        .rejects.toThrow(fixedEffectError);
    }
  });

  test("rejects response name, path, or size that does not describe requested bytes", async () => {
    const content = "created\n";
    const exact = contentObject(content);
    for (const changed of [
      { ...exact, name: "other.md" },
      { ...exact, path: "docs/other.md" },
      { ...exact, size: exact.size + 1 },
    ]) {
      await expect(dispatch(
        "create_file",
        { operation: "create_file", content, message: "Create file" },
        writeResponse(changed, 201),
      )).rejects.toThrow(fixedEffectError);
    }
  });

  test("rejects a response whose blob identity does not match requested UTF-8 bytes", async () => {
    const content = "created\n";
    await expect(dispatch(
      "create_file",
      { operation: "create_file", content, message: "Create file" },
      writeResponse({ ...contentObject(content), sha: "4".repeat(40) }, 201),
    )).rejects.toThrow(fixedEffectError);
  });

  test("rejects content or blob URLs outside the exact repository and identity", async () => {
    const content = "created\n";
    const exact = contentObject(content);
    for (const changed of [
      {
        ...exact,
        url: `https://api.github.com/repos/teamleaderleo/other/contents/${encodedPath()}`,
      },
      {
        ...exact,
        git_url: `https://api.github.com/repos/teamleaderleo/other/git/blobs/${exact.sha}`,
      },
      {
        ...exact,
        git_url: `https://api.github.com/repos/${repositoryFullName}/git/blobs/${"4".repeat(40)}`,
      },
    ]) {
      await expect(dispatch(
        "create_file",
        { operation: "create_file", content, message: "Create file" },
        writeResponse(changed, 201),
      )).rejects.toThrow(fixedEffectError);
    }
  });

  test("rejects directory, symlink, and submodule response types", async () => {
    const content = "created\n";
    for (const type of ["dir", "symlink", "submodule"] as const) {
      await expect(dispatch(
        "create_file",
        { operation: "create_file", content, message: "Create file" },
        writeResponse({ ...contentObject(content), type }, 201),
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
      writeResponse(contentObject("replacement\n"), 200),
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

function writeResponse(content: unknown, status: number): Response {
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
    status,
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
