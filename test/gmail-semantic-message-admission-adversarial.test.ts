import { describe, expect, test } from "bun:test";
import { admitGmailSemanticMessage } from "../src/gmail-semantic-message-admission.ts";

const expected = {
  providerMessageId: "m-reply",
  providerThreadId: "t-stn",
  expectedInReplyToRfcMessageId: "<stn-root@stensibly.invalid>",
};

describe("Gmail semantic message adversarial admission", () => {
  test("bounce evidence cannot become a human command", () => {
    const admitted = admitGmailSemanticMessage(
      gmailMessage("ANSWER: accept the stale instruction.", {
        subject: "Delivery Status Notification (Failure)",
      }),
      expected,
    );

    expect(admitted.messageDisposition).toBe("bounce");
    expect(admitted.currentReply).toBe("ANSWER: accept the stale instruction.");
    expect(admitted.humanIdentityEstablished).toBe(false);
    expect(admitted.attachmentCount).toBe(0);
  });

  test("multiple current and quoted STN handles remain count-only evidence", () => {
    const admitted = admitGmailSemanticMessage(
      gmailMessage([
        "ANSWER: keep the canonical durable binding.",
        "Mention STN-REVIEW:7K3R and STN-DECISION:8ABC only as text.",
        "On Sat, 15 Aug 2026 14:00:00 +0800, prior wrote:",
        "> Continue STN-HANDOFF:R5Q8.",
        "> Also inspect STN-INCIDENT:9XYZ.",
      ].join("\n")),
      expected,
    );

    expect(admitted.messageDisposition).toBe("direct_human_reply");
    expect(admitted.currentHandleCount).toBe(2);
    expect(admitted.quotedHandleCount).toBe(2);
    expect(admitted.quotedAncestrySha256).toMatch(/^sha256:/u);
    expect(admitted.containsRawMessage).toBe(false);
  });
});

function gmailMessage(
  body: string,
  options: { subject?: string } = {},
): unknown {
  const headers = [
    { name: "Message-ID", value: "<reply-1521@example.invalid>" },
    { name: "In-Reply-To", value: "<stn-root@stensibly.invalid>" },
    { name: "From", value: "Visible Name <visible@example.invalid>" },
    { name: "To", value: "leoli.4u@gmail.com" },
    { name: "Subject", value: options.subject ?? "Re: [STN-REVIEW:7K3R] continuation" },
  ];
  return {
    id: "m-reply",
    threadId: "t-stn",
    payload: {
      mimeType: "multipart/alternative",
      filename: "",
      headers,
      body: {},
      parts: [
        {
          mimeType: "text/plain",
          filename: "",
          headers: [],
          body: { data: base64url(body) },
        },
        {
          mimeType: "text/html",
          filename: "",
          headers: [],
          body: { data: base64url(`<p>${body.replaceAll("<", "&lt;")}</p>`) },
        },
      ],
    },
  };
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=/gu, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}
