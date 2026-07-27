import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  buildExternalEffectProposal,
  type ExternalEffectProposalInput,
} from "../src/external-effect-proposal.ts";

function input(overrides: Partial<ExternalEffectProposalInput> = {}): ExternalEffectProposalInput {
  return {
    proposalId: "effect_demo_001",
    requester: {
      workspace: "default",
      project: "stensibly",
      itemId: "item_352",
      runId: "run_keystone_352",
      actorId: "actor_keystone",
    },
    authorityFence: {
      resource: "run:run_keystone_352",
      holderId: "actor_keystone",
      generation: 4,
      expiresAt: "2026-07-27T18:00:00Z",
    },
    effectClass: "github.issue.create",
    provider: "github",
    accountBoundary: "teamleaderleo",
    target: {
      resource: "teamleaderleo/stensibly",
      subresource: "issue:new",
      environment: "production",
    },
    payload: {
      title: "Add an exact external-effect proposal",
      body: "Bind one proposed provider write before approval.",
      labels: ["proposal", "risk:tier-3"],
      tokenId: "oauth-signing-key-ref",
    },
    sensitivity: "public",
    reversibility: "reversible",
    consequence: "external_write",
    compensation: "provider_rollback",
    prerequisiteRefs: ["policy:stensibly-agent-ops-0.1.1", "issue:352"],
    evidenceRefs: ["run:run_keystone_352", "review:pending"],
    createdAt: "2026-07-27T13:00:00Z",
    expiresAt: "2026-07-27T14:00:00Z",
    correlationId: "corr_352",
    causationId: "issue_352",
    ...overrides,
  };
}

describe("external effect proposal", () => {
  test("builds one exact non-authoritative proposal and derived preview", () => {
    const proposal = buildExternalEffectProposal(input());

    expect(proposal).toMatchObject({
      version: 1,
      proposalId: "effect_demo_001",
      requester: {
        workspace: "default",
        project: "stensibly",
        itemId: "item_352",
        runId: "run_keystone_352",
        actorId: "actor_keystone",
      },
      authorityFence: {
        resource: "run:run_keystone_352",
        holderId: "actor_keystone",
        generation: 4,
        expiresAt: "2026-07-27T18:00:00.000Z",
      },
      effectClass: "github.issue.create",
      provider: "github",
      accountBoundary: "teamleaderleo",
      target: {
        resource: "teamleaderleo/stensibly",
        subresource: "issue:new",
        environment: "production",
      },
      sensitivity: "public",
      reversibility: "reversible",
      consequence: "external_write",
      compensation: "provider_rollback",
      createdAt: "2026-07-27T13:00:00.000Z",
      expiresAt: "2026-07-27T14:00:00.000Z",
      requestedUseCount: 1,
      supersedesProposalId: null,
      correlationId: "corr_352",
      causationId: "issue_352",
      requiresHumanApproval: true,
      grantsApproval: false,
      authorizesExecution: false,
      secretsPermitted: false,
    });
    expect(proposal.payload).toEqual({
      body: "Bind one proposed provider write before approval.",
      labels: ["proposal", "risk:tier-3"],
      title: "Add an exact external-effect proposal",
      tokenId: "oauth-signing-key-ref",
    });
    expect(proposal.prerequisiteRefs).toEqual([
      "issue:352",
      "policy:stensibly-agent-ops-0.1.1",
    ]);
    expect(proposal.evidenceRefs).toEqual([
      "review:pending",
      "run:run_keystone_352",
    ]);
    expect(proposal.payloadFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(proposal.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(proposal.preview).toBe(
      `github.issue.create via github/teamleaderleo -> teamleaderleo/stensibly / issue:new / production; ${proposal.payloadFingerprint}; expires 2026-07-27T14:00:00.000Z`,
    );
  });

  test("canonicalizes payload keys and set-like references for replay", () => {
    const first = buildExternalEffectProposal(input());
    const second = buildExternalEffectProposal(input({
      payload: {
        tokenId: "oauth-signing-key-ref",
        labels: ["proposal", "risk:tier-3"],
        body: "Bind one proposed provider write before approval.",
        title: "Add an exact external-effect proposal",
      },
      prerequisiteRefs: ["issue:352", "policy:stensibly-agent-ops-0.1.1"],
      evidenceRefs: ["review:pending", "run:run_keystone_352"],
    }));

    expect(second).toEqual(first);
    const { fingerprint: _fingerprint, ...canonical } = first;
    expect(first.fingerprint).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`,
    );
  });

  test("preserves exact provider payload strings instead of normalizing them", () => {
    const exact = buildExternalEffectProposal(input({
      payload: { body: "  exact provider body  ", title: "Title" },
    }));
    const trimmed = buildExternalEffectProposal(input({
      payload: { body: "exact provider body", title: "Title" },
    }));

    expect(exact.payload).toEqual({ body: "  exact provider body  ", title: "Title" });
    expect(exact.payloadFingerprint).not.toBe(trimmed.payloadFingerprint);
    expect(exact.fingerprint).not.toBe(trimmed.fingerprint);
  });

  test("changes the proposal fingerprint for every material execution boundary", () => {
    const baseline = buildExternalEffectProposal(input());
    const variants = [
      buildExternalEffectProposal(input({ proposalId: "effect_demo_002" })),
      buildExternalEffectProposal(input({
        authorityFence: { ...input().authorityFence, generation: 5 },
      })),
      buildExternalEffectProposal(input({ effectClass: "github.comment.create" })),
      buildExternalEffectProposal(input({ accountBoundary: "another-account" })),
      buildExternalEffectProposal(input({
        target: { ...input().target, subresource: "issue:353" },
      })),
      buildExternalEffectProposal(input({
        payload: { ...input().payload as Record<string, unknown>, title: "Different title" },
      })),
      buildExternalEffectProposal(input({ expiresAt: "2026-07-27T14:30:00Z" })),
    ];

    for (const variant of variants) {
      expect(variant.fingerprint).not.toBe(baseline.fingerprint);
    }
  });

  test("binds the request to the exact current run authority fence", () => {
    expect(() => buildExternalEffectProposal(input({
      authorityFence: { ...input().authorityFence, resource: "run:run_other" },
    }))).toThrow("must bind the requesting run");
    expect(() => buildExternalEffectProposal(input({
      authorityFence: { ...input().authorityFence, holderId: "actor_other" },
    }))).toThrow("must be the requesting actor");
    expect(() => buildExternalEffectProposal(input({
      authorityFence: { ...input().authorityFence, generation: 0 },
    }))).toThrow("positive safe integer");
    expect(() => buildExternalEffectProposal(input({
      authorityFence: { ...input().authorityFence, expiresAt: "2026-07-27T13:30:00Z" },
    }))).toThrow("must not outlive its authority fence");
  });

  test("enforces a bounded one-time proposal lifetime and explicit supersession", () => {
    const superseding = buildExternalEffectProposal(input({
      proposalId: "effect_demo_002",
      supersedesProposalId: "effect_demo_001",
    }));
    expect(superseding.requestedUseCount).toBe(1);
    expect(superseding.supersedesProposalId).toBe("effect_demo_001");

    expect(() => buildExternalEffectProposal(input({
      supersedesProposalId: "effect_demo_001",
    }))).toThrow("cannot supersede itself");
    expect(() => buildExternalEffectProposal(input({
      expiresAt: "2026-08-04T13:00:00Z",
      authorityFence: { ...input().authorityFence, expiresAt: "2026-08-05T13:00:00Z" },
    }))).toThrow("must not exceed seven days");
    expect(() => buildExternalEffectProposal(input({
      expiresAt: "2026-07-27T13:00:00Z",
    }))).toThrow("must be later than creation time");
  });

  test("enforces provider, consequence, deployment, and compensation consistency", () => {
    expect(() => buildExternalEffectProposal(input({ provider: "gitlab" }))).toThrow(
      "GitHub effects require the github provider",
    );
    expect(() => buildExternalEffectProposal(input({ consequence: "financial" }))).toThrow(
      "requires consequence external_write",
    );
    expect(() => buildExternalEffectProposal(input({
      effectClass: "deployment.start",
      provider: "cloudflare",
      consequence: "privileged_change",
      target: { resource: "worker:stensibly-api" },
    }))).toThrow("require an exact target environment");
    expect(() => buildExternalEffectProposal(input({
      reversibility: "irreversible",
      compensation: "manual_reconciliation",
    }))).toThrow("cannot claim a compensation path");
    expect(() => buildExternalEffectProposal(input({
      reversibility: "compensatable",
      compensation: "none",
    }))).toThrow("require a compensation path");
  });

  test("rejects secret-shaped payload fields and values", () => {
    expect(() => buildExternalEffectProposal(input({
      payload: { authorizationHeader: "redacted" },
    }))).toThrow("may not contain secret-bearing data");
    expect(() => buildExternalEffectProposal(input({
      payload: { body: "  Bearer private-token" },
    }))).toThrow("appears to contain a secret value");
    expect(() => buildExternalEffectProposal(input({
      payload: { privateKey: "not-even-a-real-key" },
    }))).toThrow("may not contain secret-bearing data");

    expect(buildExternalEffectProposal(input({
      payload: { credentialReference: "vault-ref-42", tokenId: "token-record-7" },
    })).payload).toEqual({
      credentialReference: "vault-ref-42",
      tokenId: "token-record-7",
    });
  });

  test("rejects non-JSON, ambiguous, cyclic, and oversized payloads", () => {
    expect(() => buildExternalEffectProposal(input({ payload: ["not-an-object"] }))).toThrow(
      "must be a JSON object",
    );
    expect(() => buildExternalEffectProposal(input({ payload: { amount: 1.5 } }))).toThrow(
      "safe integers",
    );
    expect(() => buildExternalEffectProposal(input({ payload: { when: new Date() } }))).toThrow(
      "plain JSON objects",
    );
    expect(() => buildExternalEffectProposal(input({ payload: { missing: undefined } }))).toThrow(
      "only JSON values",
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => buildExternalEffectProposal(input({ payload: cyclic }))).toThrow(
      "must not contain cycles",
    );

    expect(() => buildExternalEffectProposal(input({
      payload: { body: "x".repeat(2_049) },
    }))).toThrow("at most 2048 characters");
    expect(() => buildExternalEffectProposal(input({
      payload: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, index])),
    }))).toThrow("at most 64 keys");
  });

  test("rejects getters, symbols, sparse arrays, extra array fields, and reserved keys", () => {
    const getterPayload: Record<string, unknown> = {};
    Object.defineProperty(getterPayload, "body", {
      enumerable: true,
      get: () => "side effect",
    });
    expect(() => buildExternalEffectProposal(input({ payload: getterPayload }))).toThrow(
      "enumerable data properties",
    );

    const symbolPayload: Record<string, unknown> = { body: "safe" };
    Object.defineProperty(symbolPayload, Symbol("hidden"), { enumerable: true, value: "hidden" });
    expect(() => buildExternalEffectProposal(input({ payload: symbolPayload }))).toThrow(
      "must not contain symbol properties",
    );

    const sparse = new Array(2);
    sparse[1] = "present";
    expect(() => buildExternalEffectProposal(input({ payload: { values: sparse } }))).toThrow(
      "must be dense",
    );

    const withExtra = ["one"] as string[] & { extra?: string };
    withExtra.extra = "two";
    expect(() => buildExternalEffectProposal(input({ payload: { values: withExtra } }))).toThrow(
      "no extra properties",
    );

    expect(() => buildExternalEffectProposal(input({
      payload: JSON.parse('{"constructor":"unsafe"}'),
    }))).toThrow("non-reserved identifiers");
  });

  test("requires bounded prerequisite and evidence references", () => {
    expect(() => buildExternalEffectProposal(input({ prerequisiteRefs: [] }))).toThrow(
      "must contain 1 to 32 entries",
    );
    expect(() => buildExternalEffectProposal(input({ evidenceRefs: [] }))).toThrow(
      "must contain 1 to 32 entries",
    );
    expect(() => buildExternalEffectProposal(input({
      evidenceRefs: ["review:1", "review:1"],
    }))).toThrow("duplicate entries");
  });

  test("rejects unsafe or ambiguous identity input", () => {
    expect(() => buildExternalEffectProposal(input({ proposalId: "proposal_1" }))).toThrow(
      "must start with effect_",
    );
    expect(() => buildExternalEffectProposal(input({
      requester: { ...input().requester, itemId: "352" },
    }))).toThrow("Item ID has an invalid format");
    expect(() => buildExternalEffectProposal(input({
      target: { ...input().target, resource: "repo\nother" },
    }))).toThrow("unsupported control characters");
  });
});
