import { describe, expect, test } from "bun:test";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
} from "../src/github-provider-instruction-observation-request.ts";

describe("GitHub provider instruction observation proposal enum admission", () => {
  test("rejects a coercive outcome without executing conversion hooks", () => {
    const calls = { primitive: 0, string: 0 };
    const proposal = baseProposal();
    proposal.outcome = hostileEnum(calls, "await_provider_result");

    expect(() => compile(proposal)).toThrow(
      "GitHub reconciliation proposal outcome is invalid",
    );
    expect(calls).toEqual({ primitive: 0, string: 0 });
  });

  test("rejects a coercive next action without executing conversion hooks", () => {
    const calls = { primitive: 0, string: 0 };
    const proposal = baseProposal();
    proposal.nextAction = hostileEnum(calls, "await_provider_result");

    expect(() => compile(proposal)).toThrow(
      "GitHub reconciliation proposal next action is invalid",
    );
    expect(calls).toEqual({ primitive: 0, string: 0 });
  });
});

function compile(proposal: Record<string, unknown>) {
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace: "default",
    proposal,
  });
}

function baseProposal(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    receiptId: "ghop_enum_coercion",
    operation: "github_update_issue",
    actorId: "actor_ember",
    attachmentId: "attachment_enum_coercion",
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

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
