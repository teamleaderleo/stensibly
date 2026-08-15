import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  createMailThreadHandle,
  createMailThreadRecord,
  parseMailThreadHandle,
} from "../src/mail-thread-contract.ts";
import {
  renderMailOutboundEnvelope,
} from "../src/mail-outbound-envelope.ts";

function thread() {
  return createMailThreadRecord({
    threadId: "mail_thread_contract_1",
    handle: "STN-HANDOFF:7K3Q",
    workspace: "workspace_main",
    project: "stensibly",
    threadClass: "handoff",
    canonicalSubject: "Continue outbound mail threads",
    sourceIdentity: "attention:stensibly:1492",
    resolutionCondition: "Exact candidate is accepted or one repair is recorded.",
    createdAt: "2026-08-15T06:00:00.000Z",
  });
}

describe("mail thread contract", () => {
  test("normalizes short human-copyable STN handles and excludes confusing characters", () => {
    expect(createMailThreadHandle("handoff", "7k3q")).toBe("STN-HANDOFF:7K3Q");
    expect(parseMailThreadHandle("stn-handoff:7k3q")).toBe("STN-HANDOFF:7K3Q");
    expect(() => createMailThreadHandle("review", "O0I1")).toThrow(TypeError);
    expect(() => createMailThreadHandle("handoff", "ABC")).toThrow(TypeError);
  });

  test("renders the bounded #1489 dogfood handoff deterministically", () => {
    const input = {
      thread: thread(),
      sourceFingerprint: sha256("attention-v1"),
      whatChanged: "The outbound mail primitive has a candidate implementation.",
      attentionReason: "A fresh-worker continuation is ready for review.",
      nextAction: "Review exact candidate abcdef0123456789 and record one verdict.",
      sourceObject: "github:teamleaderleo/stensibly#1492",
      sourceRevision: "abcdef0123456789",
      blocker: null,
      resolutionCondition: "Exact candidate is accepted or one repair is recorded.",
      threadState: "open" as const,
      continuationRoute: "Gmail + GitHub only",
      references: [
        {
          label: "Issue",
          reference: "https://github.com/teamleaderleo/stensibly/issues/1492",
        },
      ],
    };

    const first = renderMailOutboundEnvelope(input);
    const second = renderMailOutboundEnvelope(input);

    expect(first).toEqual(second);
    expect(first.subject).toBe("[STN-HANDOFF:7K3Q] Continue outbound mail threads");
    expect(first.launchLine).toBe(
      "Continue STN-HANDOFF:7K3Q via Gmail + GitHub only.",
    );
    expect(first.body).toStartWith(`${first.launchLine}\n\nHandle: STN-HANDOFF:7K3Q\n`);
    expect(first.body).toContain("Subject: github:teamleaderleo/stensibly#1492");
    expect(first.body).toContain(
      "Read: github:teamleaderleo/stensibly#1492; Issue: https://github.com/teamleaderleo/stensibly/issues/1492",
    );
    expect(first.body).toContain(
      "Observed: The outbound mail primitive has a candidate implementation. Revision observed: abcdef0123456789; refresh before action.",
    );
    expect(first.body).toContain(
      "Reason: A fresh-worker continuation is ready for review.",
    );
    expect(first.body).toContain(
      "Action: Review exact candidate abcdef0123456789 and record one verdict.",
    );
    expect(first.body).toEndWith("--- STENSIBLY CURRENT HANDOFF END ---");
    expect(first.body).not.toContain("Current:");
    expect(first.containsSecrets).toBe(false);
    expect(first.materialFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  test("keeps the canonical handle independent from the continuation route", () => {
    const base = {
      thread: thread(),
      sourceFingerprint: sha256("attention-v1"),
      whatChanged: "Candidate is ready.",
      attentionReason: "Review is the current attention action.",
      nextAction: "Review revision aaaa.",
      sourceObject: "github:teamleaderleo/stensibly#1492",
      sourceRevision: "aaaa",
      resolutionCondition: "Review verdict recorded.",
      threadState: "open" as const,
    };
    const providerNeutral = renderMailOutboundEnvelope(base);
    const gmail = renderMailOutboundEnvelope({
      ...base,
      continuationRoute: "Gmail + GitHub only",
    });
    const alternate = renderMailOutboundEnvelope({
      ...base,
      continuationRoute: "mail provider + source system",
    });

    expect(providerNeutral.handle).toBe("STN-HANDOFF:7K3Q");
    expect(gmail.handle).toBe(providerNeutral.handle);
    expect(alternate.handle).toBe(providerNeutral.handle);
    expect(providerNeutral.launchLine).toBe("Continue STN-HANDOFF:7K3Q.");
    expect(gmail.launchLine).toBe(
      "Continue STN-HANDOFF:7K3Q via Gmail + GitHub only.",
    );
    expect(alternate.launchLine).toBe(
      "Continue STN-HANDOFF:7K3Q via mail provider + source system.",
    );
    expect(providerNeutral.materialFingerprint).not.toBe(gmail.materialFingerprint);
  });

  test("material fingerprint changes only when admitted outbound semantics change", () => {
    const base = {
      thread: thread(),
      sourceFingerprint: sha256("attention-v1"),
      whatChanged: "Candidate is ready.",
      attentionReason: "Review is the current attention action.",
      nextAction: "Review revision aaaa.",
      sourceObject: "github:teamleaderleo/stensibly#1492",
      sourceRevision: "aaaa",
      resolutionCondition: "Review verdict recorded.",
      threadState: "open" as const,
    };
    const first = renderMailOutboundEnvelope(base);
    const replay = renderMailOutboundEnvelope({ ...base });
    const changed = renderMailOutboundEnvelope({
      ...base,
      sourceRevision: "bbbb",
      nextAction: "Review revision bbbb.",
    });
    expect(replay.materialFingerprint).toBe(first.materialFingerprint);
    expect(changed.materialFingerprint).not.toBe(first.materialFingerprint);
  });

  test("rejects credential-shaped content from visible prose and references", () => {
    const base = {
      thread: thread(),
      sourceFingerprint: sha256("attention-v1"),
      whatChanged: "Candidate is ready.",
      attentionReason: "Review is ready.",
      nextAction: "Review current candidate.",
      sourceObject: "github:teamleaderleo/stensibly#1492",
      resolutionCondition: "Review recorded.",
      threadState: "open" as const,
    };
    expect(() => renderMailOutboundEnvelope({
      ...base,
      nextAction: "Use bearer abcdefghijklmnopqrstuvwxyz123456 to continue.",
    })).toThrow(TypeError);
    expect(() => renderMailOutboundEnvelope({
      ...base,
      references: [{
        label: "Secret",
        reference: "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      }],
    })).toThrow(TypeError);
  });
});
