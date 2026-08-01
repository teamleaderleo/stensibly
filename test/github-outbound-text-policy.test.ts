import { describe, expect, test } from "bun:test";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";
import {
  evaluateGitHubOutboundText,
  parseGitHubOutboundTextReceipt,
  type GitHubOutboundTextInput,
} from "../src/github-outbound-text-policy.ts";

function hash(seed: number): string {
  return `sha256:${(seed % 16).toString(16).repeat(64)}`;
}

function authorityFingerprint(
  generation: number,
  repositories: readonly string[],
): string {
  return fingerprintCanonicalRequest({
    policy: "github-external-contact-authority/v1",
    generation,
    repositories,
  });
}

function input(overrides: Partial<GitHubOutboundTextInput> = {}): GitHubOutboundTextInput {
  return {
    workspace: "default",
    project: "github-provider",
    destination: { owner: "teamleaderleo", repository: "stensibly" },
    surface: "comment",
    operationRef: "github-comment-operation-1",
    authorityGeneration: 3,
    fields: [{ name: "body", text: "Local coordination remains quiet." }],
    policy: {
      version: 1,
      controlledOwners: ["teamleaderleo"],
      controlledRepositories: [],
    },
    externalContactAuthority: null,
    ...overrides,
  };
}

describe("GitHub outbound text policy", () => {
  test("allows destination and controlled-repository references", () => {
    const receipt = evaluateGitHubOutboundText(input({
      fields: [{
        name: "body",
        text: [
          "See teamleaderleo/stensibly#573.",
          "See https://github.com/teamleaderleo/stensibly/issues/572.",
          "See teamleaderleo/fieldwork@abcdef1.",
        ].join("\n"),
      }],
    }));
    expect(receipt.decision).toBe("allow");
    expect(receipt.referenceCounts).toEqual({
      total: 3,
      controlled: 3,
      authorized: 0,
      rejected: 0,
      omittedDiagnostics: 0,
    });
    expect(receipt.diagnostics).toEqual([]);
    expect(receipt.providerDispatchAuthorized).toBe(false);
  });

  test("rejects direct item URLs, shorthand, commit shorthand, and closing references to external repositories", () => {
    const receipt = evaluateGitHubOutboundText(input({
      fields: [{
        name: "body",
        text: [
          "See https://github.com/external/project/issues/12.",
          "Compare external/project#13.",
          "Source external/project@abcdef1234567.",
          "Fixes external/project#14.",
          "Review https://github.com/external/project/commit/abcdef1234567890.",
        ].join("\n"),
      }],
    }));
    expect(receipt.decision).toBe("reject");
    expect(receipt.referenceCounts.rejected).toBe(5);
    expect(receipt.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      "direct_item_url",
      "cross_repository_item_shorthand",
      "cross_repository_commit_shorthand",
      "closing_reference",
      "direct_item_url",
    ]);
    expect(receipt.diagnostics.map((diagnostic) => diagnostic.itemIdentity)).toEqual([
      "12",
      "13",
      "abcdef123456",
      "14",
      "abcdef123456",
    ]);
  });

  test("allows redirect wrappers and ordinary repository or documentation links", () => {
    const receipt = evaluateGitHubOutboundText(input({
      fields: [{
        name: "body",
        text: [
          "Wrapped https://redirect.github.com/external/project/issues/12.",
          "Repository https://github.com/external/project.",
          "Documentation https://example.com/design.",
        ].join("\n"),
      }],
    }));
    expect(receipt.decision).toBe("allow");
    expect(receipt.referenceCounts.total).toBe(0);
  });

  test("uses exact repository-bound authority without authorizing provider dispatch", () => {
    const receipt = evaluateGitHubOutboundText(input({
      fields: [{ name: "body", text: "See external/project#12." }],
      externalContactAuthority: {
        fingerprint: authorityFingerprint(3, ["external/project"]),
        generation: 3,
        repositories: ["external/project"],
      },
    }));
    expect(receipt.decision).toBe("allow");
    expect(receipt.referenceCounts).toMatchObject({ authorized: 1, rejected: 0 });
    expect(receipt.providerDispatchAuthorized).toBe(false);

    expect(() => evaluateGitHubOutboundText(input({
      fields: [{ name: "body", text: "See external/project#12." }],
      externalContactAuthority: {
        fingerprint: authorityFingerprint(2, ["external/project"]),
        generation: 2,
        repositories: ["external/project"],
      },
    }))).toThrow("authority generation");

    const wrongRepository = evaluateGitHubOutboundText(input({
      fields: [{ name: "body", text: "See external/project#12." }],
      externalContactAuthority: {
        fingerprint: authorityFingerprint(3, ["other/project"]),
        generation: 3,
        repositories: ["other/project"],
      },
    }));
    expect(wrongRepository.decision).toBe("reject");
  });

  test("binds the exact final line endings and destination into the payload fingerprint", () => {
    const lf = evaluateGitHubOutboundText(input({
      fields: [{ name: "body", text: "line one\nline two" }],
    }));
    const crlf = evaluateGitHubOutboundText(input({
      fields: [{ name: "body", text: "line one\r\nline two" }],
    }));
    const otherDestination = evaluateGitHubOutboundText(input({
      destination: { owner: "teamleaderleo", repository: "fieldwork" },
      fields: [{ name: "body", text: "line one\nline two" }],
    }));
    expect(lf.payloadFingerprint).not.toBe(crlf.payloadFingerprint);
    expect(lf.payloadFingerprint).not.toBe(otherDestination.payloadFingerprint);
  });

  test("retains only bounded structured diagnostics and text digests", () => {
    const raw = "Fixes external/project#123 with private prose that must not be retained.";
    const receipt = evaluateGitHubOutboundText(input({ fields: [{ name: "body", text: raw }] }));
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain("github.com");
    expect(serialized).not.toContain("external/project#123");
    expect(receipt.diagnostics[0]).toEqual({
      field: "body",
      line: 1,
      column: 7,
      kind: "closing_reference",
      owner: "external",
      repository: "project",
      itemKind: "issue",
      itemIdentity: "123",
      rule: "external_reference_requires_authority",
      authorityRequired: true,
    });
    expect(receipt.fields[0]?.textSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("bounds diagnostics while preserving the complete rejection count", () => {
    const text = Array.from({ length: 105 }, (_, index) => `external/project#${index + 1}`).join("\n");
    const receipt = evaluateGitHubOutboundText(input({ fields: [{ name: "body", text }] }));
    expect(receipt.diagnostics).toHaveLength(100);
    expect(receipt.referenceCounts).toMatchObject({
      total: 105,
      rejected: 105,
      omittedDiagnostics: 5,
    });
  });

  test("enforces exact provider interaction surfaces and fields", () => {
    expect(() => evaluateGitHubOutboundText(input({ surface: "repository_file" as never })))
      .toThrow("surface");
    expect(() => evaluateGitHubOutboundText(input({
      surface: "issue",
      fields: [{ name: "body", text: "body" }, { name: "title", text: "title" }],
    }))).toThrow("canonical order");
    expect(() => evaluateGitHubOutboundText(input({
      surface: "issue",
      fields: [{ name: "title", text: "title" }],
    }))).toThrow("incomplete");
    expect(() => evaluateGitHubOutboundText({ ...input(), rawProviderBody: "secret" }))
      .toThrow("unknown field rawProviderBody");
    expect(() => evaluateGitHubOutboundText(input({
      policy: {
        version: 1,
        controlledOwners: ["teamleaderleo", "teamleaderleo"],
        controlledRepositories: [],
      },
    }))).toThrow("unique");
  });

  test("parses exact receipts and rejects derived-field tampering", () => {
    const receipt = evaluateGitHubOutboundText(input({
      fields: [{ name: "body", text: "external/project#12" }],
    }));
    expect(parseGitHubOutboundTextReceipt(receipt)).toEqual(receipt);
    expect(() => parseGitHubOutboundTextReceipt({
      ...receipt,
      decision: "allow",
    })).toThrow("decision does not match");
    expect(() => parseGitHubOutboundTextReceipt({
      ...receipt,
      referenceCounts: { ...receipt.referenceCounts, total: 999 },
      receiptFingerprint: hash(15),
    })).toThrow("reference counts");
    expect(() => parseGitHubOutboundTextReceipt({
      ...receipt,
      fields: [{ ...receipt.fields[0], name: "title" }],
      receiptFingerprint: hash(15),
    })).toThrow("fields do not match");
    expect(() => parseGitHubOutboundTextReceipt({
      ...receipt,
      providerDispatchAuthorized: true,
    })).toThrow("cannot authorize provider dispatch");
    expect(() => parseGitHubOutboundTextReceipt({
      ...receipt,
      receiptFingerprint: hash(15),
    })).toThrow("fingerprint does not match");
  });
});
