import { describe, expect, test } from "bun:test";
import {
  buildGitReceivePackCasRequest,
} from "../src/github-receive-pack-cas.ts";

type RequestInput = Parameters<typeof buildGitReceivePackCasRequest>[0];

const expectedHeadSha = "a".repeat(40);
const newHeadSha = "b".repeat(40);
const targetRef = "feature/exact-cas";

describe("Git receive-pack CAS caller input inspection", () => {
  test("builds from data descriptors without ordinary reads or array iteration", () => {
    let envelopeGets = 0;
    let capabilityGets = 0;
    let iteratorGets = 0;

    const capabilities = new Proxy([
      "report-status",
      "agent=git/2.50.1",
    ], {
      get(_target, key) {
        capabilityGets += 1;
        if (key === Symbol.iterator) iteratorGets += 1;
        throw new Error("caller capability get must not execute");
      },
    });
    const input = new Proxy({
      objectFormat: "sha1" as const,
      advertisedCapabilities: capabilities,
      targetRef,
      expectedHeadSha,
      newHeadSha,
    }, {
      get() {
        envelopeGets += 1;
        throw new Error("caller request get must not execute");
      },
    });

    const request = buildGitReceivePackCasRequest(input as RequestInput);

    expect(request).toBeInstanceOf(Uint8Array);
    expect(request.byteLength).toBeGreaterThan(0);
    expect(envelopeGets).toBe(0);
    expect(capabilityGets).toBe(0);
    expect(iteratorGets).toBe(0);
  });

  test("rejects accessor-backed request fields without invoking them", () => {
    let targetRefReads = 0;
    const input: Record<string, unknown> = {
      objectFormat: "sha1",
      advertisedCapabilities: ["report-status"],
      expectedHeadSha,
      newHeadSha,
    };
    Object.defineProperty(input, "targetRef", {
      enumerable: true,
      configurable: true,
      get() {
        targetRefReads += 1;
        return targetRef;
      },
    });

    expect(() => buildGitReceivePackCasRequest(
      input as unknown as RequestInput,
    )).toThrow("Git receive-pack CAS request is invalid");
    expect(targetRefReads).toBe(0);
  });

  test("normalizes a revoked request envelope", () => {
    const { proxy, revoke } = Proxy.revocable({
      objectFormat: "sha1" as const,
      advertisedCapabilities: ["report-status"],
      targetRef,
      expectedHeadSha,
      newHeadSha,
    }, {});
    revoke();

    expect(() => buildGitReceivePackCasRequest(
      proxy as RequestInput,
    )).toThrow("Git receive-pack CAS request is invalid");
  });

  test("normalizes a revoked capability array", () => {
    const revoked = Proxy.revocable(["report-status"], {});
    const input = {
      objectFormat: "sha1" as const,
      advertisedCapabilities: revoked.proxy,
      targetRef,
      expectedHeadSha,
      newHeadSha,
    };
    revoked.revoke();

    expect(() => buildGitReceivePackCasRequest(
      input as unknown as RequestInput,
    )).toThrow("Git receive-pack CAS request is invalid");
  });
});
