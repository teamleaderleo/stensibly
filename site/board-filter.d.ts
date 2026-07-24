export interface BoardFilterState {
  query: string;
  kind: string;
  status: string;
}

export interface BoardFilterCard {
  kind: string;
  status: string;
  project: string;
  text: string;
}

export function normalizeBoardQuery(value: unknown): string;
export function normalizeBoardKind(value: unknown): string;
export function normalizeBoardStatus(value: unknown): string;
export function normalizeBoardProject(value: unknown): string;
export function matchesBoardCard(card: unknown, filters: unknown): boolean;
export function boardResultLabel(visible: unknown, total: unknown, filters: unknown): string;
export function boardEmptyMessage(visible: unknown, total: unknown, filters: unknown): string;
export function boardFilterKinds(): string[];
export function boardFilterStatuses(): string[];
