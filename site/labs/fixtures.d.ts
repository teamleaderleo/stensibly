export type FrontendLabState = "healthy" | "unhealthy" | "ready" | "blocked" | "stale" | "failed" | "degraded" | "ambiguous" | "recovered" | "offline" | "reconnecting" | "denied" | "incompatible";
export interface FrontendLabTask { readonly id: string; readonly prompt: string; readonly start: string; readonly success: string; }
export interface FrontendLabReportTask { readonly taskId: string; readonly elapsedMs: number | null; readonly wrongTurns: number; readonly scrollDistance: number; readonly targetMisses: number; readonly terminologyConfusion: string; readonly comfort: string; readonly delight: string; }
export interface FrontendLabFixture { readonly project: Readonly<Record<string, string>>; readonly decision: Readonly<Record<string, string>>; readonly workers: readonly Readonly<Record<string, string>>[]; readonly readyWork: readonly Readonly<Record<string, string | number>>[]; readonly operations: readonly Readonly<Record<string, string>>[]; readonly connections: readonly Readonly<Record<string, string>>[]; readonly references: readonly Readonly<Record<string, string>>[]; }
export const frontendLabFixture: FrontendLabFixture;
export const frontendLabTasks: readonly FrontendLabTask[];
export function parseFrontendLabFixture(value: unknown): FrontendLabFixture;
export function parseFrontendLabTasks(value: unknown): readonly FrontendLabTask[];
export function createFrontendLabReport(taskIds?: readonly string[]): Readonly<{ version: 1; tasks: readonly FrontendLabReportTask[] }>;
