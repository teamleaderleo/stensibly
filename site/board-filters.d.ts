export const BOARD_FILTER_KINDS: string[];
export const BOARD_FILTER_STATUSES: string[];

export interface BoardFilterRecord {
  kind: string;
  status: string;
  search: string;
}

export interface BoardFilterState {
  query: string;
  kind: string;
  status: string;
}

export function normalizeBoardQuery(value: unknown): string;
export function normalizeBoardFilter(
  value: unknown,
  allowed: string[],
  label: string,
): string;
export function buildBoardSearchText(values: unknown[]): string;
export function matchesBoardRecord(
  record: BoardFilterRecord,
  filters: BoardFilterState,
): boolean;
export function boardResultLabel(visible: number, total: number): string;
