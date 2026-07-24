export interface ProjectBriefItem {
  id: string;
  kind: string;
  title: string;
  status: string;
  priority: number;
  summary: string | null;
  nextAction: string | null;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  updatedAt: string;
}

export interface ProjectBriefArtifact {
  id: string;
  itemId: string;
  itemTitle: string;
  actorId: string;
  kind: string;
  label: string;
  uri: string;
  createdAt: string;
}

export interface ProjectBrief {
  project: string;
  generatedAt: string;
  counts: {
    total: number;
    byStatus: Record<string, number>;
    byKind: Record<string, number>;
  };
  ready: ProjectBriefItem[];
  active: ProjectBriefItem[];
  blocked: ProjectBriefItem[];
  knowledge: ProjectBriefItem[];
  recentlyCompleted: ProjectBriefItem[];
  recentArtifacts: ProjectBriefArtifact[];
}

export function readProjectBrief(payload: unknown, expectedProject?: string): ProjectBrief;
export function normalizeBriefProjects(values: unknown): string[];
export function safeBriefArtifactHref(value: unknown): string;
