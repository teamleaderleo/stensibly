import { describe, expect, test } from "bun:test";
import {
  parseRunnerExternalReferenceV1,
} from "../src/runner-adapter-v1.ts";
import {
  parseRunnerExternalReferencePortableV1,
} from "../src/runner-external-reference-portable.ts";

describe("portable runner external-reference admission", () => {
  test("matches the existing runner adapter parser for valid checkpoint evidence", () => {
    const reference = checkpointReference();
    expect(parseRunnerExternalReferencePortableV1(reference)).toEqual(
      parseRunnerExternalReferenceV1(reference),
    );
  });

  test("matches generation admission including null and negative-zero rejection", () => {
    const nullable = { ...checkpointReference(), generation: null };
    expect(parseRunnerExternalReferencePortableV1(nullable)).toEqual(
      parseRunnerExternalReferenceV1(nullable),
    );

    const negativeZero = { ...checkpointReference(), generation: -0 };
    expect(() => parseRunnerExternalReferencePortableV1(negativeZero)).toThrow(
      "Runner external generation must be a non-negative safe integer",
    );
    expect(() => parseRunnerExternalReferenceV1(negativeZero)).toThrow(
      "Runner external generation must be a non-negative safe integer",
    );
  });

  test("matches privacy and closed-record rejection", () => {
    for (const value of [
      { ...checkpointReference(), containsPrivateContent: true },
      { ...checkpointReference(), containsCredentials: true },
      { ...checkpointReference(), externalId: "sk-proj-secret-shaped" },
      { ...checkpointReference(), unexpected: true },
    ]) {
      expect(() => parseRunnerExternalReferencePortableV1(value)).toThrow();
      expect(() => parseRunnerExternalReferenceV1(value)).toThrow();
    }
  });
});

function checkpointReference() {
  return {
    version: 1 as const,
    kind: "checkpoint" as const,
    adapterId: "vercel-ai-sdk",
    externalId: "checkpoint-portable-parity",
    digest: `sha256:${"d".repeat(64)}`,
    uri: null,
    generation: 3,
    createdAt: "2026-08-13T04:00:00.000Z",
    accessClass: "private" as const,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
}
