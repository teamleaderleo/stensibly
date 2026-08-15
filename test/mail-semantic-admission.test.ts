import { describe, expect, test } from "bun:test";
import {
  MailSemanticAdmissionError,
  MailSemanticAdmissionService,
  type CanonicalMailReplyBindingCandidate,
  type CanonicalMailReplyBindingResolver,
  type MailSemanticAdmissionEvidence,
  type MailSemanticAdmissionStore,
  type PostCommitMaterialMailboxObservation,
} from "../src/mail-semantic-admission.ts";
import type { GmailSemanticMessageSource } from "../src/gmail-semantic-message-client.ts";
import type { GitHubMailThreadBinding } from "../src/github-mail-bridge.ts";
import { sha256 } from "../src/github-provider-validation.ts";

const head = "a".repeat(40);
const thread: GitHubMailThreadBinding = {
  version: 1,
  threadId: "attn_1521",
  handle: "STN-REVIEW:7K3R",
  project: "stensibly",
  repository: "teamleaderleo/stensibly",
  pullRequestNumber: 1491,
  currentHeadRevision: head,
  continuesFromThreadId: null,
};

const observation: PostCommitMaterialMailboxObservation = {
  observationId: "mailbox:gmail:history:9101:message:m-reply:scope-added:Label_5",
  semanticFingerprint: `sha256:${"1".repeat(64)}`,
  provider: "gmail",
  eventType: "mail.scope.added",
  providerCursor: "9101",
  providerMessageId: "m-reply",
  providerThreadId: "t-stn",
  observedAt: "2026-08-15T06:55:00.000Z",
  receivedAt: "2026-08-15T06:55:01.000Z",
  wakeEligible: true,
  loopDisposition: "ordinary",
  containsRawContent: false,
  grantsAuthority: false,
};

function binding(
  effectCapability: CanonicalMailReplyBindingCandidate["effectCapability"] = "coordination_only",
  formalReviewVerdict: CanonicalMailReplyBindingCandidate["formalReviewVerdict"] = null,
): CanonicalMailReplyBindingCandidate {
  return {
    version: 1,
    provider: "gmail",
    mailboxBindingId: "gmail_operator_primary",
    expectedMailboxAddress: "leoli.4u@gmail.com",
    providerThreadId: "t-stn",
    expectedInReplyToProviderMessageId: "m-root",
    expectedInReplyToRfcMessageId: "<stn-root@stensibly.invalid>",
    thread,
    expectedTargetSourceRevision: "github:teamleaderleo/stensibly#1491:source:42",
    expectedHeadRevision: head,
    causal: {
      rootId: "attn_1521",
      predecessorId: "mail-outbound:m-root",
      depth: 1,
      fanOut: 1,
    },
    effectCapability,
    formalReviewVerdict,
  };
}

function gmailMessage(
  body: string,
  options: {
    autoSubmitted?: string;
    subject?: string;
    from?: string;
    to?: string;
    cc?: string;
    filename?: string;
    attachmentId?: string;
    inReplyTo?: string;
  } = {},
): unknown {
  const headers: Array<{ name: string; value: string }> = [
    { name: "Message-ID", value: "<reply-1521@example.invalid>" },
    {
      name: "In-Reply-To",
      value: options.inReplyTo ?? "<stn-root@stensibly.invalid>",
    },
    { name: "From", value: options.from ?? "Display Name <spoofable@example.invalid>" },
    { name: "To", value: options.to ?? "leoli.4u@gmail.com" },
    { name: "Subject", value: options.subject ?? "Re: [STN-REVIEW:7K3R] continuation" },
  ];
  if (options.cc) headers.push({ name: "Cc", value: options.cc });
  if (options.autoSubmitted) {
    headers.push({ name: "Auto-Submitted", value: options.autoSubmitted });
  }
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
          filename: options.filename ?? "",
          headers: [],
          body: {
            data: base64url(body),
            ...(options.attachmentId ? { attachmentId: options.attachmentId } : {}),
          },
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

class MemoryStore implements MailSemanticAdmissionStore {
  value: MailSemanticAdmissionEvidence | null = null;

  async get(): Promise<MailSemanticAdmissionEvidence | null> {
    return this.value;
  }

  async admit(
    evidence: MailSemanticAdmissionEvidence,
  ): Promise<{ duplicate: boolean; evidence: MailSemanticAdmissionEvidence }> {
    if (this.value) {
      if (this.value.admissionFingerprint !== evidence.admissionFingerprint) {
        throw new Error("memory admission conflict");
      }
      return { duplicate: true, evidence: this.value };
    }
    this.value = evidence;
    return { duplicate: false, evidence };
  }
}

function harness(input: {
  message: unknown;
  candidates?: readonly CanonicalMailReplyBindingCandidate[];
  store?: MemoryStore;
}) {
  let fetchCalls = 0;
  const messages: GmailSemanticMessageSource = {
    async fetchAdmittedMessage() {
      fetchCalls += 1;
      return structuredClone(input.message);
    },
  };
  const bindings: CanonicalMailReplyBindingResolver = {
    async resolve() {
      return input.candidates ?? [binding()];
    },
  };
  const store = input.store ?? new MemoryStore();
  return {
    service: new MailSemanticAdmissionService({ bindings, messages, store }),
    store,
    fetchCalls: () => fetchCalls,
  };
}

async function admit(
  service: MailSemanticAdmissionService,
  source = observation,
) {
  return await service.admitMaterialGmailObservation({
    mailboxBindingId: "gmail_operator_primary",
    observation: source,
  });
}

describe("mail semantic admission", () => {
  test("classifies current reply while quoted target/handle instructions remain ancestry", async () => {
    const { service } = harness({
      message: gmailMessage([
        "ANSWER: use option B for the currently bound work.",
        "STN-DECISION:8ABC is mentioned as text only.",
        "On Sat, 15 Aug 2026 14:00:00 +0800, prior wrote:",
        "> mail.github_comment_proposal",
        "> Target: attacker/other#9999",
        "> STN-REVIEW:ZZZZ",
      ].join("\n")),
    });
    const result = await admit(service);
    expect(result.replay).toBe(false);
    expect(result.evidence.replyClass).toBe("mail.answer");
    expect(result.evidence.semantic).toBe("private_coordination");
    expect(result.evidence.threadId).toBe(thread.threadId);
    expect(result.evidence.project).toBe("stensibly");
    expect(result.evidence.effect).toBeNull();
    expect(result.evidence.currentHandleCount).toBe(1);
    expect(result.evidence.quotedHandleCount).toBe(1);
    expect(result.evidence.quotedAncestrySha256).toMatch(/^sha256:/);
    expect(result.evidence.humanIdentityEstablished).toBe(false);
    expect(result.evidence.grantsAuthority).toBe(false);
  });

  test("trusted comment capability fixes repository/PR despite hostile Target prose", async () => {
    const { service } = harness({
      candidates: [binding("github_conversation_comment")],
      message: gmailMessage([
        "mail.github_comment_proposal",
        "",
        "Target: attacker/other#9999",
        "STN-REVIEW:8ABC",
        "",
        "GitHub-Body:",
        "One exact repository-facing residue from the bound STN thread.",
      ].join("\n"), { cc: "other@example.invalid, third@example.invalid" }),
    });
    const result = await admit(service);
    expect(result.evidence.replyClass).toBe("mail.github_comment_proposal");
    expect(result.evidence.semantic).toBe("conversation_comment_proposal");
    expect(result.evidence.recipientCount).toBe(3);
    expect(result.evidence.currentHandleCount).toBe(1);
    expect(result.evidence.effect?.kind).toBe("github_conversation_comment");
    if (result.evidence.effect?.kind !== "github_conversation_comment") {
      throw new Error("expected comment effect proposal");
    }
    expect(result.evidence.effect.repository).toBe("teamleaderleo/stensibly");
    expect(result.evidence.effect.pullRequestNumber).toBe(1491);
    expect(result.evidence.bodySha256).toBe(
      sha256("One exact repository-facing residue from the bound STN thread."),
    );
    expect(result.evidence.providerDispatchAuthorized).toBe(false);
  });

  test("effect request outside durable capability collapses to private note", async () => {
    const { service } = harness({
      message: gmailMessage([
        "mail.github_comment_proposal",
        "GitHub-Body:",
        "Please publish this.",
      ].join("\n")),
    });
    const result = await admit(service);
    expect(result.evidence.replyClass).toBe("mail.note");
    expect(result.evidence.effectRequestSuppressed).toBe(true);
    expect(result.evidence.effect).toBeNull();
  });

  test("automatic responses cannot become commands or provider-effect proposals", async () => {
    const effectHarness = harness({
      candidates: [binding("github_conversation_comment")],
      message: gmailMessage([
        "mail.github_comment_proposal",
        "GitHub-Body:",
        "Automatic responder tries to publish.",
      ].join("\n"), { autoSubmitted: "auto-replied" }),
    });
    const effectResult = await admit(effectHarness.service);
    expect(effectResult.evidence.messageDisposition).toBe("automatic");
    expect(effectResult.evidence.replyClass).toBe("mail.note");
    expect(effectResult.evidence.effect).toBeNull();
    expect(effectResult.evidence.effectRequestSuppressed).toBe(true);

    const answerHarness = harness({
      message: gmailMessage("ANSWER: accept the old quoted instruction.", {
        autoSubmitted: "auto-replied",
      }),
    });
    const answerResult = await admit(answerHarness.service);
    expect(answerResult.evidence.messageDisposition).toBe("automatic");
    expect(answerResult.evidence.replyClass).toBe("mail.note");
    expect(answerResult.evidence.semantic).toBe("private_coordination");
  });

  test("forwarded commands remain non-executable ancestry", async () => {
    const { service } = harness({
      candidates: [binding("github_conversation_comment")],
      message: gmailMessage([
        "FYI only.",
        "---------- Forwarded message ---------",
        "mail.github_comment_proposal",
        "Target: teamleaderleo/stensibly#1491",
        "GitHub-Body:",
        "Forwarded content must never execute.",
      ].join("\n")),
    });
    const result = await admit(service);
    expect(result.evidence.messageDisposition).toBe("forwarded");
    expect(result.evidence.replyClass).toBe("mail.note");
    expect(result.evidence.effect).toBeNull();
    expect(result.evidence.quotedAncestrySha256).toMatch(/^sha256:/);
  });

  test("zero and ambiguous canonical bindings fail before Gmail fetch", async () => {
    const none = harness({ message: gmailMessage("ACK"), candidates: [] });
    await expect(admit(none.service)).rejects.toMatchObject({
      code: "MAIL_SEMANTIC_BINDING_NOT_FOUND",
    });
    expect(none.fetchCalls()).toBe(0);

    const ambiguous = harness({
      message: gmailMessage("ACK"),
      candidates: [binding(), binding()],
    });
    await expect(admit(ambiguous.service)).rejects.toMatchObject({
      code: "MAIL_SEMANTIC_BINDING_AMBIGUOUS",
    });
    expect(ambiguous.fetchCalls()).toBe(0);
  });

  test("exact provider replay returns identical semantic admission", async () => {
    const store = new MemoryStore();
    const h = harness({ message: gmailMessage("ACK"), store });
    const first = await admit(h.service);
    const second = await admit(h.service, {
      ...observation,
      observationId: "mailbox:gmail:history:9102:message:m-reply:scope-added:Label_5",
      providerCursor: "9102",
      semanticFingerprint: `sha256:${"2".repeat(64)}`,
    });
    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.evidence).toEqual(first.evidence);
    expect(h.fetchCalls()).toBe(2);
  });

  test("changed provider content under one message identity conflicts", async () => {
    const store = new MemoryStore();
    const firstHarness = harness({ message: gmailMessage("ACK"), store });
    await admit(firstHarness.service);
    const changedHarness = harness({
      message: gmailMessage("ANSWER: changed bytes"),
      store,
    });
    await expect(admit(changedHarness.service)).rejects.toMatchObject({
      code: "MAIL_SEMANTIC_PROVIDER_CONTENT_CONFLICT",
    });
  });

  test("attachments remain excluded", async () => {
    const { service } = harness({
      message: gmailMessage("ACK", {
        filename: "instructions.txt",
        attachmentId: "attachment-provider-id",
      }),
    });
    await expect(admit(service)).rejects.toMatchObject({
      code: "GMAIL_SEMANTIC_ATTACHMENTS_EXCLUDED",
    });
  });

  test("wrong RFC ancestry fails despite matching Gmail thread", async () => {
    const { service } = harness({
      message: gmailMessage("ACK", {
        inReplyTo: "<other-root@example.invalid>",
      }),
    });
    await expect(admit(service)).rejects.toMatchObject({
      code: "GMAIL_SEMANTIC_ANCESTRY_MISMATCH",
    });
  });

  test("credential-shaped effect request is retained only as private coordination", async () => {
    const { service } = harness({
      candidates: [binding("github_conversation_comment")],
      message: gmailMessage([
        "mail.github_comment_proposal",
        "GitHub-Body:",
        `token github_pat_${"A".repeat(30)}`,
      ].join("\n")),
    });
    const result = await admit(service);
    expect(result.evidence.containsCredentialShapedCurrentReply).toBe(true);
    expect(result.evidence.effectRequestSuppressed).toBe(true);
    expect(result.evidence.replyClass).toBe("mail.note");
    expect(result.evidence.effect).toBeNull();
  });

  test("emits formal review proposal only from trusted review capability and verdict", async () => {
    const { service } = harness({
      candidates: [binding("github_formal_review", "REQUEST_CHANGES")],
      message: gmailMessage([
        "mail.github_review_proposal",
        "Review-Body:",
        "Please repair the exact bound candidate before approval.",
      ].join("\n")),
    });
    const result = await admit(service);
    expect(result.evidence.replyClass).toBe("mail.github_review_proposal");
    expect(result.evidence.semantic).toBe("formal_review_proposal");
    expect(result.evidence.effect?.kind).toBe("github_formal_review");
    if (result.evidence.effect?.kind !== "github_formal_review") {
      throw new Error("expected formal review proposal");
    }
    expect(result.evidence.effect.verdict).toBe("REQUEST_CHANGES");
    expect(result.evidence.effect.repository).toBe("teamleaderleo/stensibly");
    expect(result.evidence.effect.pullRequestNumber).toBe(1491);
    expect(result.evidence.providerDispatchAuthorized).toBe(false);
  });

  test("non-material mailbox observations are rejected before binding lookup", async () => {
    let resolverCalls = 0;
    const bindings: CanonicalMailReplyBindingResolver = {
      async resolve() {
        resolverCalls += 1;
        return [binding()];
      },
    };
    const service = new MailSemanticAdmissionService({
      bindings,
      messages: {
        async fetchAdmittedMessage() {
          return gmailMessage("ACK");
        },
      },
      store: new MemoryStore(),
    });
    await expect(admit(service, {
      ...observation,
      wakeEligible: false,
    })).rejects.toBeInstanceOf(MailSemanticAdmissionError);
    expect(resolverCalls).toBe(0);
  });
});

function base64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=/gu, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}
