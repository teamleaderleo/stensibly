export interface ActivityThreadPayloadEntry {
  key: string;
  value: string;
}

export interface ActivityThreadEntry {
  key: string;
  id: string;
  anchorId: string;
  type: string;
  createdAt: string;
  actorId: string;
  actorName: string;
  callsign: string;
  actorKey: string;
  actorLabel: string;
  runId: string;
  generation: number | null;
  summary: string;
  payloadEntries: ActivityThreadPayloadEntry[];
  position: number;
}

export interface ActivityThreadFilter {
  actor?: string;
  run?: string;
  type?: string;
}

export interface ActivityThreadFilterOption {
  value: string;
  label: string;
}

export function activityEventAnchorId(eventId: unknown, position?: number): string;
export function projectActivityThread(events: unknown): ActivityThreadEntry[];
export function activityThreadFilterOptions(entries: ActivityThreadEntry[]): {
  actors: ActivityThreadFilterOption[];
  runs: ActivityThreadFilterOption[];
  types: ActivityThreadFilterOption[];
};
export function filterActivityThread(
  entries: ActivityThreadEntry[],
  filters?: ActivityThreadFilter,
): ActivityThreadEntry[];
export function activityThreadSection(
  events: unknown,
  options?: { eventsTruncated?: boolean | null },
): HTMLElement;
