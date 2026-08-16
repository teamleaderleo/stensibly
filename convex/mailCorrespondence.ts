import { v } from "convex/values";
import { admitMailboxObservationJson } from "../src/mailbox-intake-admission";
import {
  exactMailThreadIdentifier,
  freezeMailThreadRecord,
} from "../src/mail-thread-contract";
import { freezeMailProviderProjection } from "../src/mail-provider";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const maximumRequestedThreads = 50;
const maximumProviderViewsPerThread = 4;
const maximumEffectsPerProviderView = 16;
const maximumObservationScan = 64;
const maximumObservationsPerProviderView = 16;

export const listProjectSources = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) {
      return {
        rows: [],
        threadsWithoutProviderProjection: 0,
        providerViewsWithoutMailboxState: 0,
        truncated: false,
      };
    }
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > maximumRequestedThreads) {
      throw new RangeError("Project correspondence limit is invalid");
    }
    const project = exactMailThreadIdentifier(args.project, "Correspondence project", 120);
    const threadRows = await ctx.db
      .query("mailOutboundThreads")
      .withIndex("by_workspace_project_updated_at", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("project", project))
      .order("desc")
      .take(args.limit + 1);
    const threadTruncated = threadRows.length > args.limit;
    const rows: Array<{
      threadJson: string;
      projectionJson: string;
      mailboxStateJson: string;
      effects: Array<{
        outboundEffectId: string;
        state: string;
        reservedAt: number;
        settledAt: number | null;
      }>;
      observations: Array<{
        observationId: string;
        eventType: string;
        providerMessageId: string | null;
        providerThreadId: string | null;
        observedAt: string;
      }>;
      truncated: boolean;
    }> = [];
    let threadsWithoutProviderProjection = 0;
    let providerViewsWithoutMailboxState = 0;
    let sourceTruncated = threadTruncated;

    for (const threadRow of threadRows.slice(0, args.limit)) {
      const thread = freezeMailThreadRecord(JSON.parse(threadRow.threadJson));
      if (thread.workspace !== workspaceSlug || thread.project !== project) {
        throw new Error("MAIL_CORRESPONDENCE_THREAD_SCOPE_CONFLICT");
      }
      const projectionRows = await ctx.db
        .query("mailOutboundProviderProjections")
        .withIndex("by_workspace_thread_provider_account", (q) => q
          .eq("workspaceId", workspace._id)
          .eq("threadId", thread.threadId))
        .take(maximumProviderViewsPerThread + 1);
      if (projectionRows.length === 0) {
        threadsWithoutProviderProjection += 1;
        continue;
      }
      const projectionTruncated = projectionRows.length > maximumProviderViewsPerThread;
      sourceTruncated ||= projectionTruncated;

      for (const projectionRow of projectionRows.slice(0, maximumProviderViewsPerThread)) {
        const projection = freezeMailProviderProjection(JSON.parse(projectionRow.projectionJson));
        if (
          projection.threadId !== thread.threadId
          || projection.provider !== projectionRow.provider
          || projection.accountBinding !== projectionRow.accountBinding
        ) {
          throw new Error("MAIL_CORRESPONDENCE_PROVIDER_PROJECTION_CONFLICT");
        }
        const mailboxBinding = await ctx.db
          .query("mailboxIntakeBindings")
          .withIndex("by_workspace_id_and_mailbox_binding_id", (q) => q
            .eq("workspaceId", workspace._id)
            .eq("mailboxBindingId", projection.accountBinding))
          .unique();
        if (!mailboxBinding) {
          providerViewsWithoutMailboxState += 1;
          continue;
        }
        if (mailboxBinding.provider !== projection.provider) {
          throw new Error("MAIL_CORRESPONDENCE_MAILBOX_PROVIDER_CONFLICT");
        }

        const effectRows = await ctx.db
          .query("mailOutboundEffects")
          .withIndex("by_workspace_thread_provider_account_created", (q) => q
            .eq("workspaceId", workspace._id)
            .eq("threadId", thread.threadId)
            .eq("provider", projection.provider)
            .eq("accountBinding", projection.accountBinding))
          .order("desc")
          .take(maximumEffectsPerProviderView + 1);
        const effectsTruncated = effectRows.length > maximumEffectsPerProviderView;
        sourceTruncated ||= effectsTruncated;
        const effects = effectRows.slice(0, maximumEffectsPerProviderView).map((effect) => ({
          outboundEffectId: effect.outboundEffectId,
          state: effect.state,
          reservedAt: effect.createdAt,
          settledAt: effect.state === "reserved" ? null : effect.updatedAt,
        }));

        const observationRows = await ctx.db
          .query("mailboxIntakeObservations")
          .withIndex(
            "by_workspace_id_and_mailbox_binding_id_and_received_at",
            (q) => q.eq("workspaceId", workspace._id)
              .eq("mailboxBindingId", projection.accountBinding),
          )
          .order("desc")
          .take(maximumObservationScan + 1);
        const observationScanTruncated = observationRows.length > maximumObservationScan;
        sourceTruncated ||= observationScanTruncated;
        const matchingObservations = observationRows
          .slice(0, maximumObservationScan)
          .map((row) => admitMailboxObservationJson(row.observationJson))
          .filter((observation) =>
            observation.provider === projection.provider
            && (
              observation.providerThreadId === projection.providerThreadId
              || observation.eventType === "mail.subscription.degraded"
              || observation.eventType === "mail.subscription.recovered"
            ));
        const observationsTruncated = matchingObservations.length > maximumObservationsPerProviderView;
        sourceTruncated ||= observationsTruncated;
        const observations = matchingObservations
          .slice(0, maximumObservationsPerProviderView)
          .map((observation) => ({
            observationId: observation.observationId,
            eventType: observation.eventType,
            providerMessageId: observation.providerMessageId,
            providerThreadId: observation.providerThreadId,
            observedAt: observation.observedAt,
          }));

        rows.push({
          threadJson: threadRow.threadJson,
          projectionJson: projectionRow.projectionJson,
          mailboxStateJson: mailboxBinding.stateJson,
          effects,
          observations,
          truncated: projectionTruncated
            || effectsTruncated
            || observationScanTruncated
            || observationsTruncated,
        });
      }
    }

    return {
      rows,
      threadsWithoutProviderProjection,
      providerViewsWithoutMailboxState,
      truncated: sourceTruncated,
    };
  },
});
