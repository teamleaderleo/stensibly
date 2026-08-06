import { describe, expect, test } from "bun:test";
import {
  GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
  composeGitHubProviderContextAcceptanceV1,
} from "../src/github-provider-context-acceptance-composer.ts";

describe("GitHub context acceptance proposal enum admission", () => {
  test("rejects a coercive outcome before conversion or binding access", () => {
    const coercionCalls = { primitive: 0, string: 0 };
    const bindingReads = { value: 0 };
    const proposal = baseProposal();
    proposal.outcome = hostileEnum(coercionCalls, "await_provider_result");

    expect(() => compose(proposal, hostileBinding(bindingReads))).toThrow(
      "GitHub reconciliation proposal outcome is invalid",
    );
    expect(coercionCalls).toEqual({ primitive: 0, string: 0 });
    expect(bindingReads.value).toBe(0);
  });

  test("rejects a coercive next action before conversion or binding access", () => {
    const coercionCalls = { primitive: 0, string: 0 };
    const bindingReads = { value: 0 };
    const proposal = baseProposal();
    proposal.nextAction = hostileEnum(coercionCalls, "await_provider_result");

    expect(() => compose(proposal, hostileBinding(bindingReads))).toThrow(
      "GitHub reconciliation proposal next action is invalid",
    );
    expect(coercionCalls).toEqual({ primitive: 0, string: 0 });
    expect(bindingReads.value).toBe(0);
  });
});

function compose(
  proposal: Record<string, unknown>,
  binding: Record<string, unknown>,
) {
  return composeGitHubProviderContextAcceptanceV1({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
    workspace: "default",
    proposal,
    binding,
  });
}

function baseProposal(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    receiptId: "ghop_acceptance_enum_coercion",
    operation: "github_update_issue",
    actorId: "actor_ember",
    attachmentId: "attachment_acceptance_enum_coercion",
    attachmentSnapshotSha256: hash("a"),
    verificationCheckedAt: null,
    externalId: null,
    currentSourceRevision: null,
    providerSourceRevision: null,
    outcome: "await_provider_result",
    nextAction: "await_provider_result",
    providerSnapshot: null,
    inputFingerprint: hash("b"),
    proposalFingerprint: hash("c"),
    authorizesProviderMutation: false,
    authorizesContextAcceptance: false,
    authorizesAuthority: false,
  };
}

function hostileEnum(
  calls: { primitive: number; string: number },
  admittedText: string,
): Record<PropertyKey, unknown> {
  return {
    [Symbol.toPrimitive]() {
      calls.primitive += 1;
      return admittedText;
    },
    toString() {
      calls.string += 1;
      return admittedText;
    },
  };
}

function hostileBinding(reads: { value: number }): Record<string, unknown> {
  const binding: Record<string, unknown> = {};
  Object.defineProperty(binding, "version", {
    enumerable: true,
    get() {
      reads.value += 1;
      return 1;
    },
  });
  return binding;
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
