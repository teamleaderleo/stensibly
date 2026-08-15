import { describe, expect, test } from "bun:test";
import { renderMailDigestMessage } from "../src/mail-ux-digest-renderer.ts";
import {
  compileMailDigest,
  type MailThreadSnapshot,
} from "../src/mail-ux-projection.ts";

const asOf = "2026-08-15T06:30:00.000Z";

function thread(
  handle: string,
  overrides: Partial<MailThreadSnapshot> = {},
): MailThreadSnapshot {
  return {
    handle,
    attentionClass: "handoff",
    title: "Continue mail UX dogfood",
    changed: "Continuation changed materially.",
    current: "github:teamleaderleo/stensibly#1493",
    nextAction: "Inspect the exact current source and continue the lane.",
    resolution: "Record the next material result.",
    strongestSource: "github:teamleaderleo/stensibly#1493",
    state: "active",
    updatedAt: "2026-08-15T06:00:00.000Z",
    actionableAt: "2026-08-15T06:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

describe("mail UX digest renderer", () => {
  test("starts with one reusable boot line and keeps source expansion behind compact rows", () => {
    const digest = compileMailDigest([
      thread("STN-REVIEW:Q7MP", {
        attentionClass: "review",
        title: "Review compact continuation fixture",
        actionableAt: "2026-08-15T04:00:00.000Z",
      }),
      thread("STN-HANDOFF:K8RY", {
        title: "Continue relay dogfood",
      }),
    ], asOf);

    const message = renderMailDigestMessage(digest);
    expect(message.body.split("\n")[0]).toBe(message.launchLine);
    expect(message.launchLine).toBe(
      "Read the latest Stensibly digest and continue one useful lane.",
    );
    expect(message.body).toContain("HOT · STN-REVIEW:Q7MP · 2h");
    expect(message.body).toContain("ACTIVE · STN-HANDOFF:K8RY · 0h");
    expect(message.body).toContain("Source: github:teamleaderleo/stensibly#1493");
    expect(message.bodyBytes).toBeLessThan(700);
    expect(message.authorizesOperation).toBe(false);
    expect(message.authorizesMutation).toBe(false);
  });
});
