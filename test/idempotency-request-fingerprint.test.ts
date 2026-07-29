import { describe, expect, test } from "bun:test";
import {
  attachArtifactRequestFingerprint,
  canonicalJsonString,
  createItemRequestFingerprint,
  fingerprintCanonicalRequest,
} from "../src/idempotency-request-fingerprint.ts";

describe("idempotency request fingerprints", () => {
  test("uses canonical JSON and a known SHA-256 vector", () => {
    expect(canonicalJsonString({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(fingerprintCanonicalRequest({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  test("treats metadata key order as equivalent", () => {
    const first = attachArtifactRequestFingerprint({
      itemId: "item_1",
      actorId: "agent_1",
      kind: "document",
      label: "Evidence",
      uri: "https://example.test/evidence",
      mimeType: "application/json",
      metadata: { nested: { z: 3, a: 1 }, alpha: true },
    });
    const reordered = attachArtifactRequestFingerprint({
      itemId: "item_1",
      actorId: "agent_1",
      kind: "document",
      label: "Evidence",
      uri: "https://example.test/evidence",
      mimeType: "application/json",
      metadata: { alpha: true, nested: { a: 1, z: 3 } },
    });

    expect(reordered).toBe(first);
  });

  test("binds every durable create field", () => {
    const base = {
      project: "alpha",
      kind: "task",
      title: "Ship it",
      summary: null,
      nextAction: null,
      priority: 50,
      actorId: "agent_1",
    };
    const fingerprint = createItemRequestFingerprint(base);

    expect(createItemRequestFingerprint({ ...base, summary: "Changed" })).not.toBe(fingerprint);
    expect(createItemRequestFingerprint({ ...base, nextAction: "Review" })).not.toBe(fingerprint);
    expect(createItemRequestFingerprint({ ...base, priority: 51 })).not.toBe(fingerprint);
    expect(createItemRequestFingerprint({ ...base, actorId: null })).not.toBe(fingerprint);
  });
});
