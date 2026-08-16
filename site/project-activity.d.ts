export interface ProjectActivityEntry {
  entryId: string;
  entryFingerprint: string;
  workspace: string;
  project: string;
  sourceClass: 'correspondence' | 'orchestrator_activity';
  sourceId: string;
  sourceFingerprint: string;
  happenedAt: string;
  activityClass:
    | 'correspondence_changed'
    | 'work_started'
    | 'progress_evidence'
    | 'provider_effect'
    | 'verification'
    | 'blocked'
    | 'handoff'
    | 'completed'
    | 'reconciliation_required'
    | 'attention_required';
  activityState:
    | 'active'
    | 'waiting'
    | 'resolved'
    | 'observed'
    | 'in_progress'
    | 'succeeded'
    | 'failed'
    | 'blocked'
    | 'ambiguous'
    | 'stale'
    | 'conflicted';
  currentness: 'current' | 'partial' | 'stale' | 'unknown';
  actorId: string | null;
  callsign: string | null;
  workItemId: string | null;
  attemptId: string | null;
  runId: string | null;
  provider: string | null;
  summary: string | null;
  nextOrResolution: string | null;
  causalPredecessorSourceId: string | null;
  relatedEvidenceIds: string[];
}

export interface ProjectActivity {
  version: 'project-activity/v1';
  projectionFingerprint: string;
  project: string;
  asOf: string;
  entries: ProjectActivityEntry[];
  completeness: {
    correspondenceTruncated: boolean;
    orchestratorTruncated: boolean;
    omittedEntryCount: number;
  };
  sourceCompleteness: {
    correspondence: {
      truncated: boolean;
      threadsWithoutProviderProjection: number;
      providerViewsWithoutMailboxState: number;
      rejectedCandidates: number;
    };
    orchestrator: { truncated: boolean };
  };
}

export function readProjectActivity(payload: unknown, expectedProject?: string): ProjectActivity;
export function normalizeActivityProjects(values: unknown): string[];
