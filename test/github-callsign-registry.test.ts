import { describe, expect, test } from "bun:test";
import { callsignSigil } from "../src/callsign-sigils.ts";
import {
  decideGitHubCallsignCommand,
  formatGitHubCallsignReceipt,
  parseGitHubCallsignCommand,
  parseGitHubCallsignReceipt,
  projectGitHubCallsignRegistry,
  type GitHubCallsignReceiptDraft,
  type ParsedGitHubCallsignReceipt,
} from "../src/github-callsign-registry.ts";

describe("callsign sigils", () => {
  test("derives stable decoration without creating another lease system", () => {
    const first = callsignSigil(" Rook ");
    const second = callsignSigil("Rook");
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      callsign: "Rook",
      collisionKey: "rook",
      sigil: "🪶",
      source: "override",
      reservesSigil: false,
      grantsIdentityContinuity: false,
      grantsAuthority: false,
    });

    const derived = callsignSigil("Capybara");
    expect(derived.sigil).toBeTruthy();
    expect(derived.reservesSigil).toBe(false);
  });
});

describe("GitHub callsign command parsing", () => {
  test("parses a shared-account reservation and ignores the visible footer", () => {
    expect(parseGitHubCallsignCommand([
      "/callsign reserve Rook",
      "run: run_rook_01",
      "session: chatgpt.project.rook.01",
      "ttl: 24h",
      "",
      "— Rook 🪶 · Foundry",
    ].join("\n"))).toEqual({
      version: 0,
      kind: "reserve",
      callsign: "Rook",
      collisionKey: "rook",
      runId: "run_rook_01",
      sessionId: "chatgpt.project.rook.01",
      ttlHours: 24,
    });
  });

  test("parses release generations and rejects malformed commands", () => {
    expect(parseGitHubCallsignCommand([
      "/callsign release night-jar",
      "run: run_nightjar_01",
      "generation: 3",
    ].join("\n"))).toEqual({
      version: 0,
      kind: "release",
      callsign: "night-jar",
      collisionKey: "nightjar",
      runId: "run_nightjar_01",
      generation: 3,
    });

    expect(() => parseGitHubCallsignCommand([
      "/callsign reserve Rook",
      "run: run_rook_01",
      "session: chatgpt.rook.01",
      "ttl: forever",
    ].join("\n"))).toThrow("1h through 168h");
    expect(() => parseGitHubCallsignCommand([
      "/callsign reserve Rook",
      "run: run_rook_01",
      "session: chatgpt.rook.01",
      "ttl: 24h",
      "authority: admin",
    ].join("\n"))).toThrow("Unknown callsign command field");
  });
});

describe("GitHub callsign registry replay", () => {
  test("accepts one lease and rejects a separator-insensitive collision", () => {
    const requestOne = "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-1";
    const first = decideGitHubCallsignCommand({
      command: parseGitHubCallsignCommand([
        "/callsign reserve Rook",
        "run: run_rook_01",
        "session: chatgpt.rook.01",
        "ttl: 24h",
      ].join("\n")),
      requestComment: requestOne,
      receipts: [],
      evaluatedAt: "2026-07-29T00:00:00Z",
    });
    expect(first.outcome).toBe("accepted");
    expect(first.receipt).toMatchObject({
      status: "accepted",
      callsign: "Rook",
      sigil: "🪶",
      collisionKey: "rook",
      runId: "run_rook_01",
      sessionId: "chatgpt.rook.01",
      generation: 1,
      receiptAuthority: "github-actions[bot]",
    });

    const accepted = parseDraft(first.receipt!, 10, "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-10");
    const second = decideGitHubCallsignCommand({
      command: parseGitHubCallsignCommand([
        "/callsign reserve r-o_o k",
        "run: run_rook_02",
        "session: chatgpt.rook.02",
        "ttl: 24h",
      ].join("\n")),
      requestComment: "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-2",
      receipts: [accepted],
      evaluatedAt: "2026-07-29T01:00:00Z",
    });
    expect(second.outcome).toBe("rejected");
    expect(second.reaction).toBe("-1");
    expect(second.receipt?.reason).toBe("active_collision:run_rook_01");
  });

  test("releases the exact generation and preserves the history generation", () => {
    const accepted = acceptedReceipt({
      commentId: 10,
      requestComment: "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-1",
      callsign: "Lantern",
      runId: "run_lantern_01",
      sessionId: "chatgpt.lantern.01",
      generation: 2,
      acceptedAt: "2026-07-29T00:00:00Z",
      expiresAt: "2026-07-30T00:00:00Z",
    });
    const release = decideGitHubCallsignCommand({
      command: parseGitHubCallsignCommand([
        "/callsign release Lantern",
        "run: run_lantern_01",
        "generation: 2",
      ].join("\n")),
      requestComment: "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-3",
      receipts: [accepted],
      evaluatedAt: "2026-07-29T02:00:00Z",
    });
    expect(release.outcome).toBe("released");
    const released = parseDraft(
      release.receipt!,
      11,
      "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-11",
    );
    const projection = projectGitHubCallsignRegistry(
      [accepted, released],
      "2026-07-29T03:00:00Z",
    );
    expect(projection.activeLeases).toEqual([]);
    expect(projection.maximumGenerationByCollisionKey.get("lantern")).toBe(2);
  });

  test("allows a new generation after expiry and replays one request exactly", () => {
    const expired = acceptedReceipt({
      commentId: 10,
      requestComment: "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-1",
      callsign: "Teacup",
      runId: "run_teacup_01",
      sessionId: "chatgpt.teacup.01",
      generation: 1,
      acceptedAt: "2026-07-28T00:00:00Z",
      expiresAt: "2026-07-29T00:00:00Z",
    });
    const requestComment = "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-4";
    const command = parseGitHubCallsignCommand([
      "/callsign reserve Teacup",
      "run: run_teacup_02",
      "session: chatgpt.teacup.02",
      "ttl: 12h",
    ].join("\n"));
    const accepted = decideGitHubCallsignCommand({
      command,
      requestComment,
      receipts: [expired],
      evaluatedAt: "2026-07-29T00:00:00Z",
    });
    expect(accepted.receipt?.generation).toBe(2);

    const current = parseDraft(
      accepted.receipt!,
      12,
      "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-12",
    );
    const replay = decideGitHubCallsignCommand({
      command,
      requestComment,
      receipts: [expired, current],
      evaluatedAt: "2026-07-29T00:01:00Z",
    });
    expect(replay).toMatchObject({
      outcome: "replay",
      reaction: "+1",
      receipt: null,
      existingReceipt: { commentId: 12, status: "accepted" },
    });
  });

  test("requires bot authority in canonical receipts", () => {
    const body = formatGitHubCallsignReceipt({
      version: 0,
      status: "rejected",
      callsign: null,
      sigil: null,
      collisionKey: null,
      requestComment: "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-5",
      runId: null,
      sessionId: null,
      generation: null,
      acceptedAt: null,
      expiresAt: null,
      releasedAt: null,
      reason: "invalid_command",
      receiptAuthority: "github-actions[bot]",
    }).replace("receipt-authority: github-actions[bot]", "receipt-authority: teamleaderleo");
    expect(() => parseGitHubCallsignReceipt({
      body,
      commentId: 13,
      commentUrl: "https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-13",
    })).toThrow("github-actions[bot]");
  });
});

function acceptedReceipt(input: {
  commentId: number;
  requestComment: string;
  callsign: string;
  runId: string;
  sessionId: string;
  generation: number;
  acceptedAt: string;
  expiresAt: string;
}): ParsedGitHubCallsignReceipt {
  const sigil = callsignSigil(input.callsign);
  return parseDraft({
    version: 0,
    status: "accepted",
    callsign: input.callsign,
    sigil: sigil.sigil,
    collisionKey: sigil.collisionKey,
    requestComment: input.requestComment,
    runId: input.runId,
    sessionId: input.sessionId,
    generation: input.generation,
    acceptedAt: input.acceptedAt,
    expiresAt: input.expiresAt,
    releasedAt: null,
    reason: null,
    receiptAuthority: "github-actions[bot]",
  }, input.commentId, `https://github.com/teamleaderleo/stensibly/issues/454#issuecomment-${input.commentId}`);
}

function parseDraft(
  draft: GitHubCallsignReceiptDraft,
  commentId: number,
  commentUrl: string,
): ParsedGitHubCallsignReceipt {
  return parseGitHubCallsignReceipt({
    body: formatGitHubCallsignReceipt(draft),
    commentId,
    commentUrl,
  });
}
