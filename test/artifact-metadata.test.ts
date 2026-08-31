import { describe, expect, test } from "bun:test";
import { artifactMetadataSchema } from "../src/artifact-metadata.ts";

describe("artifact metadata admission", () => {
  test("accepts bounded nested workstation receipt references", () => {
    const metadata = {
      schema: "glaeda-owned-workstation-capability-artifact/v1",
      snapshot: {
        node: { id: "air-blue", osClass: "macos", architectureClass: "arm64" },
        source: { commitOid: "a".repeat(40), treeOid: "b".repeat(40) },
        profiles: [{ id: "repo-query/v1", versionSha256: `sha256:${"c".repeat(64)}` }],
      },
      receiptDigest: `sha256:${"d".repeat(64)}`,
    };

    expect(artifactMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  test("rejects credential fields and credential-shaped values at any depth", () => {
    expect(() => artifactMetadataSchema.parse({ nested: { token: "not-even-a-token" } }))
      .toThrow("credential fields");
    expect(() => artifactMetadataSchema.parse({ nested: [
      { note: "Bearer abcdefghijklmnopqrstuvwxyz" },
    ] })).toThrow("credential-shaped values");
    expect(() => artifactMetadataSchema.parse({ reference: "ghp_abcdefghijklmnopqrstuvwxyz" }))
      .toThrow("credential-shaped values");
  });

  test("rejects excessive depth, value count, and encoded size", () => {
    let deep: Record<string, unknown> = { leaf: "too deep" };
    for (let index = 0; index < 9; index += 1) deep = { nested: deep };
    expect(() => artifactMetadataSchema.parse(deep)).toThrow("depth");
    expect(() => artifactMetadataSchema.parse(Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [`field_${index}`, index]),
    ))).toThrow();
    expect(() => artifactMetadataSchema.parse({
      chunks: Array.from({ length: 10 }, () => "x".repeat(2_000)),
    })).toThrow("characters");
  });
});
