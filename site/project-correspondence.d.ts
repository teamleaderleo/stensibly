export interface ProjectCorrespondenceStage {
  stageId: string;
  kind: string;
  happenedAt: string;
  evidenceRef: string;
  causalPredecessorStageId: string | null;
}

export interface ProjectCorrespondenceThread {
  projectionFingerprint: string;
  threadId: string;
  handle: string;
  title: string;
  semanticClass: string;
  lifecycle: string;
  provider: "gmail" | "outlook";
  newestMaterialAt: string;
  freshness: {
    coverage: string;
    subscriptionHealth: string;
    currentness: "current" | "partial" | "stale" | "unknown";
    truncated: boolean;
    lastSuccessfulReconciliationAt: string | null;
  };
  attribution: {
    actor: string | null;
    callsign: string | null;
    runId: string | null;
  };
  materialPreview: {
    current: string;
    nextOrResolutionCondition: string;
  };
  stages: ProjectCorrespondenceStage[];
}

export interface ProjectCorrespondence {
  version: "project-correspondence/v1";
  project: string;
  asOf: string;
  rows: ProjectCorrespondenceThread[];
  completeness: {
    truncated: boolean;
    threadsWithoutProviderProjection: number;
    providerViewsWithoutMailboxState: number;
    rejectedCandidates: number;
  };
}

export function readProjectCorrespondence(
  payload: unknown,
  expectedProject?: string,
): ProjectCorrespondence;
export function normalizeCorrespondenceProjects(values: unknown): string[];
