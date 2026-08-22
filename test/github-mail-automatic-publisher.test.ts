import { describe, expect, test } from "bun:test";
import type { GitHubMailAttentionDecision } from "../src/github-mail-bridge-core.ts";
import {
  GitHubMailAutomaticPublisher,
  type GitHubMailAutomaticOutboundPublisher,
} from "../src/github-mail-automatic-publisher.ts";
import type { HostedGmailOutboundMaterial } from "../src/hosted-gmail-outbound-service.ts";
import { createMailThreadRecord } from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

const fingerprint = (character: string) => `sha256:${character.repeat(64)}`;
const revision = "a".repeat(40);

function decision(
  overrides: Partial<GitHubMailAttentionDecision> = {},
): GitHubMailAttentionDecision {
  return {
    version: 1,
    threadId: "mail_thread_quarry_q7r4",
    handle: "STN-REVIEW:Q7R4",
    repository: "Coreys-Quarry/quarry",
    pullRequestNumber: 604,
    currentHeadRevision: revision,
    sourceObservationId: "github_observation_quarry_604_1",
    sourceSemanticFingerprint: fingerprint("b"),
    repositorySemantic: "pr_lifecycle",
    attentionClass: "review",
    mailAction: "update",
    reason: "pr_review_ready",
    requiresMaterialityDecision: false,
    returningEffectId: null,
    loopSuppressed: false,
    deduped: false,
    materialFingerprint: fingerprint("c"),
    ...overrides,
  };
}

class CapturePublisher implements GitHubMailAutomaticOutboundPublisher<{ call: number }> {
  readonly materials: HostedGmailOutboundMaterial[] = [];

  async publish(material: HostedGmailOutboundMaterial) {
    this.materials.push(structuredClone(material));
    return { call: this.materials.length };
  }
}

function fixture() {
  const store = new SqliteMailThreadStore({ path: ":memory:" });
  const publisher = new CapturePublisher();
  const automatic = new GitHubMailAutomaticPublisher({
    store,
    publisher,
    workspace: "workspace_main",
    project: "quarry",
    publicProjectCode: "QRY",
    now: () => "2026-08-23T03:40:00.000Z",
  });
  return { store, publisher, automatic };
}

describe("automatic GitHub attention mail publishing", () => {
  test("binds the exact canonical thread and publishes one routine project-owned checkpoint", async () => {
    const f = fixture();

    const result = await f.automatic.publish(decision());

    expect(result).toMatchObject({
      status: "published",
      threadId: "mail_thread_quarry_q7r4",
      handle: "STN-REVIEW:Q7R4",
      materialFingerprint: fingerprint("c"),
      result: { call: 1 },
    });
    expect(f.publisher.materials).toHaveLength(1);
    expect(f.publisher.materials[0]).toMatchObject({
      threadClass: "review",
      sourceIdentity: "github:Coreys-Quarry/quarry#604",
      sourceFingerprint: fingerprint("c"),
      publicProjectCode: "QRY",
      currentMailboxState: {
        revision: fingerprint("c"),
        state: "active",
        operatorAttentionRequired: false,
      },
    });

    const thread = await f.store.getThreadByHandle("STN-REVIEW:Q7R4");
    expect(thread).toMatchObject({
      threadId: "mail_thread_quarry_q7r4",
      project: "quarry",
      sourceIdentity: "github:Coreys-Quarry/quarry#604",
    });
    f.store.close();
  });

  test("keeps deduped and loop-suppressed decisions completely quiet", async () => {
    const f = fixture();

    const duplicate = await f.automatic.publish(decision({
      deduped: true,
      sourceObservationId: "github_observation_quarry_604_duplicate",
    }));
    const loop = await f.automatic.publish(decision({
      loopSuppressed: true,
      sourceObservationId: "github_observation_quarry_604_loop",
    }));

    expect(duplicate.status).toBe("quiet");
    expect(loop.status).toBe("quiet");
    expect(f.publisher.materials).toHaveLength(0);
    expect(await f.store.getThreadByHandle("STN-REVIEW:Q7R4")).toBeNull();
    f.store.close();
  });

  test("uses the same exact thread for a later terminal resolution", async () => {
    const f = fixture();
    await f.automatic.publish(decision());

    const resolved = await f.automatic.publish(decision({
      sourceObservationId: "github_observation_quarry_604_merged",
      sourceSemanticFingerprint: fingerprint("d"),
      materialFingerprint: fingerprint("e"),
      attentionClass: "none",
      mailAction: "resolve",
      reason: "pr_merged",
    }));

    expect(resolved).toMatchObject({
      status: "published",
      threadId: "mail_thread_quarry_q7r4",
      handle: "STN-REVIEW:Q7R4",
    });
    expect(f.publisher.materials).toHaveLength(2);
    expect(f.publisher.materials[1]).toMatchObject({
      threadState: "resolved",
      publicProjectCode: "QRY",
      currentMailboxState: {
        revision: fingerprint("e"),
        state: "resolved",
        operatorAttentionRequired: false,
      },
    });
    f.store.close();
  });

  test("fails closed instead of forking when the source already belongs to another mail thread", async () => {
    const f = fixture();
    await f.store.reserveThread(createMailThreadRecord({
      threadId: "mail_thread_other",
      handle: "STN-REVIEW:7K3Q",
      workspace: "workspace_main",
      project: "quarry",
      threadClass: "review",
      canonicalSubject: "Coreys-Quarry/quarry PR #604",
      sourceIdentity: "github:Coreys-Quarry/quarry#604",
      resolutionCondition: "Older checkpoint remains current.",
      createdAt: "2026-08-23T03:30:00.000Z",
    }));

    await expect(f.automatic.publish(decision())).rejects.toThrow(
      "conflicts with the canonical mail thread binding",
    );
    expect(f.publisher.materials).toHaveLength(0);
    expect(await f.store.getThreadByHandle("STN-REVIEW:Q7R4")).toBeNull();
    f.store.close();
  });

  test("rejects an invalid project code before any thread or provider work", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const publisher = new CapturePublisher();

    expect(() => new GitHubMailAutomaticPublisher({
      store,
      publisher,
      workspace: "workspace_main",
      project: "quarry",
      publicProjectCode: "Q0I",
    })).toThrow("Mail project code is invalid");
    expect(publisher.materials).toHaveLength(0);
    store.close();
  });
});
