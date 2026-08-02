import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { convexApi } from "../convex/refs.js";
import {
  ConvexWorkLedger,
  type ConvexWorkLedgerOptions,
} from "./convex-ledger.js";
import type {
  GitHubIssueProviderReadService,
  GitHubIssueProviderWriteService,
} from "./github-issue-provider-mcp.js";
import {
  withConvexGitHubProviderReceiptStore,
} from "./github-provider-receipt-convex-ledger.js";
import {
  mountHostedGitHubDelegatedReadProviderFromEnv,
  type HostedGitHubDelegatedReadProvider,
} from "./hosted-github-delegated-read-provider.js";
import { mountHostedGitHubIssueProviderFromEnv } from "./hosted-github-issue-provider.js";
import {
  prepareProjectAttachmentAcceptance,
  type AcceptProjectAttachmentInput,
  type ProjectAttachmentLedger,
  type ProjectAttachmentRecord,
} from "./project-attachment-ledger.js";
import { parseProjectAttachmentSnapshot } from "./project-contract.js";

const rawRecordSchema = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  snapshotJson: z.string().min(1),
  snapshotSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  contentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourcePath: z.string().min(1),
  sourceRevision: z.string().min(1),
  acceptedBy: z.string().min(1),
  authorityWidening: z.boolean(),
  acceptedAt: z.string().datetime(),
}).strict();

export class ConvexProjectAttachmentLedger extends ConvexWorkLedger implements ProjectAttachmentLedger {
  constructor(options: ConvexWorkLedgerOptions) {
    super(options);
  }

  async getProjectAttachment(project: string): Promise<ProjectAttachmentRecord | null> {
    const raw = await this.client.query(
      convexApi.projectAttachments.getCurrent,
      this.attachmentArgs({ project }),
    );
    return raw === null ? null : mapRecord(raw);
  }

  async acceptProjectAttachment(input: AcceptProjectAttachmentInput) {
    const current = await this.getProjectAttachment(input.project);
    const prepared = prepareProjectAttachmentAcceptance(current, input);
    if (prepared.replay) {
      return { attachment: prepared.replay, diff: null, replayed: true };
    }

    const externalId = `attach_${randomUUID()}`;
    const raw = await this.client.mutation(
      convexApi.projectAttachments.accept,
      this.attachmentArgs({
        project: input.project,
        expectedCurrentSnapshotSha256: prepared.expectedCurrentSnapshotSha256,
        externalId,
        snapshotJson: JSON.stringify(prepared.snapshot),
        snapshotSha256: prepared.snapshot.snapshotSha256,
        contentSha256: prepared.snapshot.source.contentSha256,
        sourcePath: prepared.snapshot.source.path,
        sourceRevision: prepared.sourceRevision,
        acceptedBy: prepared.acceptedBy,
        authorityWidening: prepared.authorityWidening,
      }),
    );
    const attachment = mapRecord(raw);
    if (
      attachment.project !== input.project
      || attachment.snapshot.snapshotSha256 !== prepared.snapshot.snapshotSha256
      || attachment.sourceRevision !== prepared.sourceRevision
    ) {
      throw new Error("Hosted project attachment response does not match the accepted snapshot");
    }
    return {
      attachment,
      diff: prepared.diff,
      replayed: attachment.id !== externalId,
    };
  }

  private attachmentArgs(input: object): Record<string, unknown> {
    return {
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
      ...input,
    };
  }
}

export function createConvexProjectAttachmentLedgerFromEnv(
  env: Record<string, string | undefined> = Bun.env,
): ConvexProjectAttachmentLedger
  & Partial<GitHubIssueProviderReadService>
  & Partial<GitHubIssueProviderWriteService>
  & Partial<HostedGitHubDelegatedReadProvider> {
  const url = required(env.CONVEX_URL, "CONVEX_URL");
  const serviceSecret = required(
    env.STENSIBLY_SERVICE_SECRET,
    "STENSIBLY_SERVICE_SECRET",
  );
  const ledger = new ConvexProjectAttachmentLedger({
    client: new ConvexHttpClient(url),
    serviceSecret,
    workspace: env.STENSIBLY_WORKSPACE ?? "default",
  });
  const withReceipts = withConvexGitHubProviderReceiptStore(ledger, {
    client: ledger.client,
    serviceSecret: ledger.serviceSecret,
    workspace: ledger.workspace,
  });
  const issueProvider = mountHostedGitHubIssueProviderFromEnv(
    withReceipts,
    env,
  );
  return mountHostedGitHubDelegatedReadProviderFromEnv(issueProvider, env);
}

function mapRecord(value: unknown): ProjectAttachmentRecord {
  const raw = rawRecordSchema.parse(value);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.snapshotJson);
  } catch {
    throw new Error(`Hosted project attachment ${raw.id} is not valid JSON`);
  }
  const snapshot = parseProjectAttachmentSnapshot(decoded);
  if (
    snapshot.contract.project !== raw.project
    || snapshot.snapshotSha256 !== raw.snapshotSha256
    || snapshot.source.contentSha256 !== raw.contentSha256
    || snapshot.source.path !== raw.sourcePath
  ) {
    throw new Error(`Hosted project attachment ${raw.id} metadata does not match its snapshot`);
  }
  return {
    id: raw.id,
    project: raw.project,
    snapshot,
    sourceRevision: raw.sourceRevision,
    acceptedBy: raw.acceptedBy,
    authorityWidening: raw.authorityWidening,
    acceptedAt: raw.acceptedAt,
  };
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
