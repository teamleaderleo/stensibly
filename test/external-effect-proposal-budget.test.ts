import { describe, expect, test } from "bun:test";
import {
  buildExternalEffectProposal,
  type ExternalEffectProposalInput,
} from "../src/external-effect-proposal.ts";

function input(payload: unknown): ExternalEffectProposalInput {
  return {
    proposalId: "effect_budget_001",
    requester: {
      workspace: "default",
      project: "stensibly",
      itemId: "item_352",
      runId: "run_teacup_354",
      actorId: "actor_teacup",
    },
    authorityFence: {
      resource: "run:run_teacup_354",
      holderId: "actor_teacup",
      generation: 5,
      expiresAt: "2026-07-27T20:00:00Z",
    },
    effectClass: "github.issue.create",
    provider: "github",
    accountBoundary: "teamleaderleo",
    target: {
      resource: "teamleaderleo/stensibly",
      subresource: "issue:new",
      environment: "production",
    },
    payload,
    sensitivity: "public",
    reversibility: "reversible",
    consequence: "external_write",
    compensation: "provider_rollback",
    prerequisiteRefs: ["issue:352"],
    evidenceRefs: ["review:pending"],
    createdAt: "2026-07-27T18:00:00Z",
    expiresAt: "2026-07-27T19:00:00Z",
  };
}

describe("external effect proposal payload budget", () => {
  test("stops before a late valid data-property branch after the byte budget is exhausted", () => {
    let lateBranchVisits = 0;
    const lateBranch = new Proxy(
      { value: "valid" },
      {
        getPrototypeOf(target) {
          lateBranchVisits += 1;
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    const wideBranch = Object.fromEntries(
      Array.from(
        { length: 64 },
        (_, index) => [`field${String(index).padStart(3, "0")}`, "x".repeat(2_048)],
      ),
    );

    expect(() => buildExternalEffectProposal(input({
      bulk: wideBranch,
      tail: lateBranch,
    }))).toThrow("maximum validation byte budget");
    expect(lateBranchVisits).toBe(0);
  });

  test("keeps exact canonical output below the global budget", () => {
    const proposal = buildExternalEffectProposal(input({
      alpha: [0, true, null, "snowman: ☃"],
      beta: { nested: "value" },
    }));

    expect(proposal.payload).toEqual({
      alpha: [0, true, null, "snowman: ☃"],
      beta: { nested: "value" },
    });
    expect(Buffer.byteLength(JSON.stringify(proposal.payload), "utf8")).toBeLessThanOrEqual(
      16 * 1_024,
    );
  });
});
