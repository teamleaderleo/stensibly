import { z } from "zod";
import {
  compareProjectAttachments,
  parseProjectAttachmentSnapshot,
  projectAttachmentSnapshotSchema,
  type ProjectAttachmentDiff,
  type ProjectAttachmentSnapshot,
} from "./project-contract.js";
import type { WorkLedger } from "./ledger.js";

export const sourceRevisionSchema = z
  .string()
  .trim()
  .min(7)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/, "Use a stable repository revision");

export const acceptProjectAttachmentSchema = z.object({
  snapshot: projectAttachmentSnapshotSchema,
  sourceRevision: sourceRevisionSchema,
  acceptAuthorityWidening: z.boolean().default(false),
}).strict();

export interface ProjectAttachmentRecord {
  id: string;
  project: string;
  snapshot: ProjectAttachmentSnapshot;
  sourceRevision: string;
  acceptedBy: string;
  authorityWidening: boolean;
  acceptedAt: string;
}

export interface AcceptProjectAttachmentInput {
  project: string;
  snapshot: unknown;
  sourceRevision: string;
  acceptedBy: string;
  acceptAuthorityWidening: boolean;
}

export interface ProjectAttachmentAcceptance {
  attachment: ProjectAttachmentRecord;
  diff: ProjectAttachmentDiff | null;
  replayed: boolean;
}

export interface ProjectAttachmentLedger {
  getProjectAttachment(project: string): Promise<ProjectAttachmentRecord | null>;
  acceptProjectAttachment(input: AcceptProjectAttachmentInput): Promise<ProjectAttachmentAcceptance>;
}

export interface PreparedProjectAttachmentAcceptance {
  snapshot: ProjectAttachmentSnapshot;
  sourceRevision: string;
  acceptedBy: string;
  diff: ProjectAttachmentDiff | null;
  authorityWidening: boolean;
  expectedCurrentSnapshotSha256: string | null;
  replay: ProjectAttachmentRecord | null;
}

export class ProjectAttachmentWideningError extends Error {
  constructor() {
    super("Project attachment authority widening requires explicit acknowledgement");
    this.name = "ProjectAttachmentWideningError";
  }
}

export function projectAttachmentLedger(
  ledger: WorkLedger,
): ProjectAttachmentLedger | null {
  const candidate = ledger as WorkLedger & Partial<ProjectAttachmentLedger>;
  return typeof candidate.getProjectAttachment === "function"
    && typeof candidate.acceptProjectAttachment === "function"
    ? candidate as ProjectAttachmentLedger
    : null;
}

export function prepareProjectAttachmentAcceptance(
  current: ProjectAttachmentRecord | null,
  input: AcceptProjectAttachmentInput,
): PreparedProjectAttachmentAcceptance {
  const snapshot = parseProjectAttachmentSnapshot(input.snapshot);
  const project = input.project.trim();
  if (snapshot.contract.project !== project) {
    throw new Error(
      `Project attachment targets ${snapshot.contract.project}, not route project ${project}`,
    );
  }
  const sourceRevision = sourceRevisionSchema.parse(input.sourceRevision);
  const acceptedBy = z.string().trim().min(1).max(240).parse(input.acceptedBy);

  if (
    current
    && current.snapshot.snapshotSha256 === snapshot.snapshotSha256
    && current.sourceRevision === sourceRevision
  ) {
    return {
      snapshot,
      sourceRevision,
      acceptedBy,
      diff: null,
      authorityWidening: current.authorityWidening,
      expectedCurrentSnapshotSha256: current.snapshot.snapshotSha256,
      replay: current,
    };
  }

  const diff = current
    ? compareProjectAttachments(current.snapshot, snapshot)
    : null;
  const authorityWidening = current === null || diff?.widensAuthority === true;
  if (authorityWidening && !input.acceptAuthorityWidening) {
    throw new ProjectAttachmentWideningError();
  }

  return {
    snapshot,
    sourceRevision,
    acceptedBy,
    diff,
    authorityWidening,
    expectedCurrentSnapshotSha256: current?.snapshot.snapshotSha256 ?? null,
    replay: null,
  };
}
