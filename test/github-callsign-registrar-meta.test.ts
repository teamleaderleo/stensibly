import { describe, expect, test } from "bun:test";
import {
  formatGitHubCallsignHelp,
  formatGitHubCallsignStatus,
  parseGitHubCallsignMetaCommand,
} from "../src/github-callsign-registrar.ts";
import type { ParsedGitHubCallsignReceipt } from "../src/github-callsign-registry.ts";

describe("GitHub callsign meta commands", () => {
  test("recognises exact help and status commands with a separate footer", () => {
    expect(parseGitHubCallsignMetaCommand(
      "/callsign help\n\n— Rook 🪶 · Foundry",
    )).toBe("help");
    expect(parseGitHubCallsignMetaCommand(
      "/callsign status\r\n\r\n— Lantern 🏮",
    )).toBe("status");
    expect(parseGitHubCallsignMetaCommand(
      "/callsign status\nextra: unsupported",
    )).toBeNull();
    expect(parseGitHubCallsignMetaCommand(
      "/callsign reserve Rook\nrun: run_rook\nsession: session\nttl: 1h",
    )).toBeNull();
  });

  test("formats bounded help for shared-account workers", () => {
    const help = formatGitHubCallsignHelp();
    expect(help).toStartWith("callsign-help/v0");
    expect(help).toContain("/callsign reserve <Callsign>");
    expect(help).toContain("/callsign release <Callsign>");
    expect(help).toContain("/callsign status");
    expect(help).toContain("docs/callsign-registry-dogfood.md");
    expect(help).toContain("shared transport principal");
  });

  test("projects active bot receipts and excludes released leases", () => {
    const status = formatGitHubCallsignStatus(
      [
        acceptedReceipt({
          commentId: 1,
          callsign: "Rook",
          sigil: "🪶",
          collisionKey: "rook",
          runId: "run_rook_1",
          sessionId: "chatgpt.rook.1",
          generation: 1,
          expiresAt: "2026-07-30T00:00:00.000Z",
        }),
        acceptedReceipt({
          commentId: 2,
          callsign: "Lantern",
          sigil: "🏮",
          collisionKey: "lantern",
          runId: "run_lantern_1",
          sessionId: "chatgpt.lantern.1",
          generation: 1,
          expiresAt: "2026-07-30T00:00:00.000Z",
        }),
        releasedReceipt({
          commentId: 3,
          callsign: "Lantern",
          sigil: "🏮",
          collisionKey: "lantern",
          runId: "run_lantern_1",
          generation: 1,
        }),
      ],
      "2026-07-29T00:00:00.000Z",
    );

    expect(status).toStartWith("callsign-status/v0");
    expect(status).toContain("active-count: 1");
    expect(status).toContain("shown-count: 1");
    expect(status).toContain("omitted-count: 0");
    expect(status).toContain("| Rook | 🪶 |");
    expect(status).toContain("run_rook_1");
    expect(status).not.toContain("run_lantern_1");
    expect(status).toContain("github-actions[bot]");
  });
});

function acceptedReceipt(input: {
  commentId: number;
  callsign: string;
  sigil: string;
  collisionKey: string;
  runId: string;
  sessionId: string;
  generation: number;
  expiresAt: string;
}): ParsedGitHubCallsignReceipt {
  return {
    version: 0,
    status: "accepted",
    commentId: input.commentId,
    commentUrl: `https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-${input.commentId}`,
    callsign: input.callsign,
    sigil: input.sigil,
    collisionKey: input.collisionKey,
    requestComment: `https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-request-${input.commentId}`,
    runId: input.runId,
    sessionId: input.sessionId,
    generation: input.generation,
    acceptedAt: "2026-07-28T00:00:00.000Z",
    expiresAt: input.expiresAt,
    releasedAt: null,
    reason: null,
    receiptAuthority: "github-actions[bot]",
  };
}

function releasedReceipt(input: {
  commentId: number;
  callsign: string;
  sigil: string;
  collisionKey: string;
  runId: string;
  generation: number;
}): ParsedGitHubCallsignReceipt {
  return {
    version: 0,
    status: "released",
    commentId: input.commentId,
    commentUrl: `https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-${input.commentId}`,
    callsign: input.callsign,
    sigil: input.sigil,
    collisionKey: input.collisionKey,
    requestComment: `https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-request-${input.commentId}`,
    runId: input.runId,
    sessionId: null,
    generation: input.generation,
    acceptedAt: null,
    expiresAt: null,
    releasedAt: "2026-07-28T12:00:00.000Z",
    reason: null,
    receiptAuthority: "github-actions[bot]",
  };
}
