import { describe, expect, test } from "bun:test";
import {
  boundedIdentity,
  boundedText,
} from "../src/work-stack-projection-validation.ts";

describe("work-stack shared retained credential policy", () => {
  test("rejects realistic Stensibly identities at the shared threshold", () => {
    const serviceIdentity = `stn.svc_${"a".repeat(12)}`;
    const tokenIdentity = `stn.tok_${"b".repeat(12)}`;

    expect(() => boundedIdentity(serviceIdentity, "Work identity"))
      .toThrow("Work identity contains credential-shaped text");
    expect(() => boundedIdentity(tokenIdentity, "Work identity"))
      .toThrow("Work identity contains credential-shaped text");

    expect(() => boundedText(
      `evidence ${serviceIdentity}`,
      1,
      200,
      "Work evidence",
    )).toThrow("Work evidence contains credential-shaped text");
    expect(() => boundedText(
      `evidence ${tokenIdentity}`,
      1,
      200,
      "Work evidence",
    )).toThrow("Work evidence contains credential-shaped text");
  });

  test("retains benign Stensibly-like aliases below the shared threshold", () => {
    const benignToken = `stn.tok_${"a".repeat(11)}`;
    const benignService = `stn.svc_${"b".repeat(11)}`;

    expect(boundedIdentity(benignToken, "Work identity")).toBe(benignToken);
    expect(boundedText(
      `evidence ${benignService}`,
      1,
      200,
      "Work evidence",
    )).toBe(`evidence ${benignService}`);
  });

  test("inherits broader shared-policy credential families", () => {
    const authorization = "authorization:abcdefgh";
    expect(() => boundedIdentity(authorization, "Work identity"))
      .toThrow("Work identity contains credential-shaped text");

    expect(() => boundedText(
      "-----BEGIN PRIVATE KEY-----",
      1,
      200,
      "Work evidence",
    )).toThrow("Work evidence contains credential-shaped text");
  });
});
