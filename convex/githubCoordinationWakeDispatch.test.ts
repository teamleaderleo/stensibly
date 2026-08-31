/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { stableJson } from "../src/canonical-json";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation";
import { compileProjectContract } from "../src/project-contract";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const dispatchRef = makeFunctionReference<"mutation">(
  "githubCoordinationWakeDispatch:dispatch",
);
const ingestRef = makeFunctionReference<"mutation">(
  "githubRepositoryObservations:ingest",
);
const secret = "test-service-secret";
const workspace = "test";
const project = "github-wake";
const repository = "teamleaderleo/stensibly";
const receivedAt = "2026-08-31T13:00:00.000Z";
const dispatcher = {
  id: "service:github-wake-dispatch",
  name: "GitHub Wake Dispatch",
  kind: "service" as const,
};
const executionEnvelope = {
  schemaVersion: 1 as const,
  objective: "Run the exact work generation selected by an admitted GitHub event",
  scopeClass: "atomic" as const,
  estimate: { lowMinutes: 2, likelyMinutes: 5, highMinutes: 10, confidence: 0.8 },
  budget: { expectedMessages: 1, expectedToolCalls: 4, expectedReviewMinutes: 1 },
  boundaries: { softCheckpointMinutes: 5, forcedHandoffMinutes: 10, hardRecoveryMinutes: 15 },
  completion: {
    requiredOutputs: ["bounded receipt"],
    verificationRequired: true,
    continuationStateRequired: false,
    acceptanceChecks: ["exact generation consumed once"],
  },
  durableState: {
    accessClass: "project" as const,
    retentionClass: "standard" as const,
    redactionRequired: true,
    deleteAfter: null,
  },
};

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("GitHub coordination wake dispatch", () => {
  test("turns one explicit admitted relation into one replayable existing run", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seed(t, repository);
    const args = dispatchArgs(fixture.itemId, fixture.observationId);

    const first = await t.mutation(dispatchRef, args) as any;
    expect(first).toMatchObject({
      status: "dispatched",
      replay: false,
      sourceObservationId: fixture.observationId,
      sourceIdentity: "github:teamleaderleo/stensibly#issue/1762",
      expectedClaimGeneration: 0,
      claimedGeneration: 1,
    });

    const second = await t.mutation(dispatchRef, args) as any;
    expect(second).toEqual({ ...first, replay: true });
    expect(await runCount(t)).toBe(1);
    expect(await queuedEventCount(t)).toBe(1);
  });

  test("leaves mismatched explicit relations as a no-op", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seed(t, repository);
    const args = dispatchArgs(fixture.itemId, fixture.observationId);
    const subscription = JSON.parse(args.subscriptionJson);
    subscription.sourceItemId = "github:teamleaderleo/stensibly#issue/9999";
    subscription.sourceCorrelationId = subscription.sourceItemId;

    expect(await t.mutation(dispatchRef, {
      ...args,
      subscriptionJson: stableJson(subscription),
    })).toMatchObject({
      status: "not_matched",
      reason: "source_item_mismatch",
    });
    expect(await runCount(t)).toBe(0);
  });

  test("refuses an observation outside the current accepted attachment", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seed(t, "teamleaderleo/another-repository");
    await expect(t.mutation(
      dispatchRef,
      dispatchArgs(fixture.itemId, fixture.observationId),
    )).rejects.toThrow("GITHUB_COORDINATION_WAKE_REPOSITORY_NOT_ATTACHED");
    expect(await runCount(t)).toBe(0);
  });
});

async function seed(
  t: ReturnType<typeof convexTest>,
  attachedRepository: string,
) {
  const item = await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project,
    kind: "task",
    title: "Exact owned-workstation query",
    nextAction: "Run the named repository query on one admitted node.",
    priority: 80,
    actor: dispatcher,
  }) as any;
  const attachment = compileProjectContract(projectMarkdown(attachedRepository));
  await t.mutation(convexApi.projectAttachments.accept, {
    serviceSecret: secret,
    workspace,
    project,
    externalId: `attachment-${attachedRepository.replaceAll("/", "-")}`,
    snapshotJson: JSON.stringify(attachment),
    snapshotSha256: attachment.snapshotSha256,
    contentSha256: attachment.source.contentSha256,
    sourcePath: attachment.source.path,
    sourceRevision: "a".repeat(40),
    acceptedBy: dispatcher.id,
    authorityWidening: false,
    expectedCurrentSnapshotSha256: null,
  });

  const payload = {
    action: "created",
    repository: { full_name: repository },
    sender: { login: "teamleaderleo" },
    issue: {
      number: 1762,
      id: 1762,
      updated_at: receivedAt,
      user: { login: "teamleaderleo" },
    },
    comment: {
      id: 4242,
      body: "Run the exact bounded workstation query.",
      created_at: receivedAt,
      updated_at: receivedAt,
      user: { login: "teamleaderleo" },
    },
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const observation = mapGitHubRepositoryWebhook({
    eventType: "issue_comment",
    deliveryId: "delivery-github-wake-1",
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt,
  });
  if (!observation) throw new Error("GitHub wake fixture did not map");
  await t.mutation(ingestRef, {
    serviceSecret: secret,
    workspace,
    deliveryId: observation.deliveryId,
    eventType: observation.eventType,
    payloadDigest: observation.payloadDigest,
    receivedAt: Date.parse(receivedAt),
    observationJson: stableJson(observation),
  });
  return { itemId: item.id as string, observationId: observation.observationId };
}

function dispatchArgs(itemId: string, observationId: string) {
  const sourceIdentity = "github:teamleaderleo/stensibly#issue/1762";
  return {
    serviceSecret: secret,
    workspace,
    project,
    observationId,
    subscriptionJson: stableJson({
      version: 1,
      id: "subscription:github:owned-workstation",
      generation: 1,
      project,
      sourceItemId: sourceIdentity,
      sourceCorrelationId: sourceIdentity,
      eventTypes: ["github.issue_comment.created"],
      targetItemId: itemId,
      targetGeneration: 0,
      minimumRoutingLevel: "attention",
      createdAt: "2026-08-31T12:00:00.000Z",
      expiresAt: null,
    }),
    routingLevel: "attention" as const,
    actor: dispatcher,
    runnerType: "glaeda-workstation",
    runnerProfile: "repo-query/v1",
    runnerProfileVersion: "sha256:" + "a".repeat(64),
    executionEnvelope,
    leaseSeconds: 900,
    maxAttempts: 3,
    retryBackoffSeconds: 60,
  };
}

function projectMarkdown(attachedRepository: string): string {
  return `# Stensibly project contract

\`\`\`stensibly
${JSON.stringify({
    version: 1,
    project,
    repositories: [attachedRepository],
    runnerProfiles: ["codex-default"],
    concurrency: { project: 2, global: 4 },
    autonomousActions: ["inspect"],
    approvalRequired: [],
    checks: ["bun test"],
    tags: ["github"],
    relatedProjects: [],
  }, null, 2)}
\`\`\`

## Goal

Execute one exact bounded task.

## Boundaries

Use only the accepted repository and named runner profile.

## Evidence and handoff expectations

Keep one bounded immutable receipt.

## Escalation

Stop when exact dispatch is unavailable.
`;
}

async function runCount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => (await ctx.db.query("queuedRuns").take(10)).length);
}

async function queuedEventCount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("events").take(20)).filter((event) =>
      event.type === "run.queued"
      && event.idempotencyKey?.startsWith("coordination-wake:")
    ).length
  );
}
