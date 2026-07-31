import { v } from "convex/values";
import {
  admitGitHubRepositoryObservationEnvelope,
  type AdmittedGitHubRepositoryObservation,
} from "../src/github-repository-observation-admission";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const maximumRecent = 100;
const repositoryPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u;

export const ingest = mutation({
  args: {
    ...serviceArgs,
    deliveryId: v.string(),
    eventType: v.string(),
    payloadDigest: v.string(),
    receivedAt: v.number(),
    observationJson: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) {
      throw new Error("GITHUB_REPOSITORY_OBSERVATION_WORKSPACE_NOT_FOUND");
    }
    const input = admitGitHubRepositoryObservationEnvelope({
      deliveryId: args.deliveryId,
      eventType: args.eventType,
      payloadDigest: args.payloadDigest,
      receivedAt: args.receivedAt,
      observationJson: args.observationJson,
    });

    const existingDelivery = await ctx.db
      .query("githubRepositoryObservations")
      .withIndex("by_workspace_delivery", (q) =>
        q.eq("workspaceId", workspace._id).eq("deliveryId", input.deliveryId),
      )
      .unique();
    if (existingDelivery) {
      if (!isExactReplay(existingDelivery, input)) {
        throw new Error("GITHUB_REPOSITORY_DELIVERY_CONFLICT");
      }
      return { duplicate: true, record: publicRecord(existingDelivery) };
    }

    const existingObservation = await ctx.db
      .query("githubRepositoryObservations")
      .withIndex("by_workspace_observation", (q) =>
        q.eq("workspaceId", workspace._id).eq("observationId", input.observationId),
      )
      .unique();
    if (existingObservation) {
      throw new Error("GITHUB_REPOSITORY_OBSERVATION_CONFLICT");
    }

    const id = await ctx.db.insert("githubRepositoryObservations", {
      workspaceId: workspace._id,
      observationId: input.observationId,
      deliveryId: input.deliveryId,
      payloadDigest: input.payloadDigest,
      semanticFingerprint: input.semanticFingerprint,
      eventType: input.eventType,
      action: input.action,
      repository: input.repository,
      actor: input.actor,
      subjectKind: input.subjectKind,
      subjectExternalId: input.subjectExternalId,
      sourceTime: input.sourceTime,
      sourceTimeSource: input.sourceTimeSource,
      receivedAt: input.receivedAt,
      observationJson: input.observationJson,
      createdAt: Date.now(),
    });
    const inserted = await ctx.db.get("githubRepositoryObservations", id);
    if (!inserted) {
      throw new Error("GITHUB_REPOSITORY_OBSERVATION_MISSING");
    }
    return { duplicate: false, record: publicRecord(inserted) };
  },
});

export const listRecent = query({
  args: {
    ...serviceArgs,
    repository: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const repository = exactRepository(args.repository);
    const limit = boundedLimit(args.limit);
    const rows = await ctx.db
      .query("githubRepositoryObservations")
      .withIndex("by_workspace_repository_received", (q) =>
        q.eq("workspaceId", workspace._id).eq("repository", repository),
      )
      .order("desc")
      .take(limit);
    return rows.map(publicRecord);
  },
});

function isExactReplay(
  row: {
    observationId: string;
    payloadDigest: string;
    semanticFingerprint: string;
    eventType: string;
    action: string;
    repository: string;
    actor?: string | null;
    subjectKind: string;
    subjectExternalId: string;
    sourceTime: number;
    sourceTimeSource: string;
    receivedAt: number;
    observationJson: string;
  },
  input: AdmittedGitHubRepositoryObservation,
): boolean {
  return row.observationId === input.observationId
    && row.payloadDigest === input.payloadDigest
    && row.semanticFingerprint === input.semanticFingerprint
    && row.eventType === input.eventType
    && row.action === input.action
    && row.repository === input.repository
    && (row.actor ?? null) === input.actor
    && row.subjectKind === input.subjectKind
    && row.subjectExternalId === input.subjectExternalId
    && row.sourceTime === input.sourceTime
    && row.sourceTimeSource === input.sourceTimeSource
    && row.receivedAt === input.receivedAt
    && row.observationJson === input.observationJson;
}

function publicRecord(row: {
  _id: unknown;
  observationId: string;
  deliveryId: string;
  payloadDigest: string;
  semanticFingerprint: string;
  eventType: string;
  action: string;
  repository: string;
  actor?: string | null;
  subjectKind: string;
  subjectExternalId: string;
  sourceTime: number;
  sourceTimeSource: string;
  receivedAt: number;
  observationJson: string;
  createdAt: number;
}) {
  return {
    id: String(row._id),
    observationId: row.observationId,
    deliveryId: row.deliveryId,
    payloadDigest: row.payloadDigest,
    semanticFingerprint: row.semanticFingerprint,
    eventType: row.eventType,
    action: row.action,
    repository: row.repository,
    actor: row.actor ?? null,
    subjectKind: row.subjectKind,
    subjectExternalId: row.subjectExternalId,
    sourceTime: row.sourceTime,
    sourceTimeSource: row.sourceTimeSource,
    receivedAt: row.receivedAt,
    observationJson: row.observationJson,
    createdAt: row.createdAt,
  };
}

function exactRepository(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 200
    || value !== value.trim()
    || !repositoryPattern.test(value)
  ) {
    throw new RangeError("GitHub repository is invalid");
  }
  return value;
}

function boundedLimit(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximumRecent
  ) {
    throw new RangeError("GitHub repository observation limit is invalid");
  }
  return value;
}
