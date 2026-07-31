export interface FrontendLabEvidenceProfile {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly zoomPercent: number;
  readonly requiredSupport: "wide" | "medium" | "narrow";
  readonly taskEligible: boolean;
}
export interface FrontendLabEvidenceScenario {
  readonly id: string;
  readonly requiredSupport: "empty" | "loading" | "degraded" | "error" | null;
}
export interface FrontendLabEvidenceCase {
  readonly id: string;
  readonly kind: "route" | "task";
  readonly variantId: string;
  readonly variantStatus: "planned" | "prototype";
  readonly variantRevision: string | null;
  readonly fixtureRevision: string;
  readonly planRevision: string;
  readonly route: string;
  readonly profileId: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly zoomPercent: number;
  readonly colorScheme: "light" | "dark";
  readonly motion: "no-preference" | "reduce";
  readonly scenarioId: string;
  readonly taskId: string | null;
  readonly expectedIdentity: string;
  readonly artifactStem: string;
}
export interface FrontendLabEvidenceInput {
  readonly variantIds?: readonly string[];
  readonly profileIds?: readonly string[];
  readonly taskIds?: readonly string[];
}
export interface FrontendLabEvidencePlanRevisionInput {
  readonly version: number;
  readonly profiles: readonly unknown[];
  readonly scenarios: readonly unknown[];
  readonly manifest: readonly unknown[];
  readonly fixtureRevision: string;
}
export const frontendLabEvidencePlanVersion: 2;
export const frontendLabEvidenceIdentityLimits: Readonly<{
  maximumDepth: 32;
  maximumNodes: 512;
  maximumStringBytes: 4096;
  maximumCanonicalBytes: 16384;
}>;
export const frontendLabEvidenceProfiles: readonly FrontendLabEvidenceProfile[];
export const frontendLabEvidenceScenarios: readonly FrontendLabEvidenceScenario[];
export function createFrontendLabFixtureRevision(fixture: unknown, tasks: unknown): string;
export function createFrontendLabEvidencePlanRevision(input: FrontendLabEvidencePlanRevisionInput): string;
export function validateFrontendLabEvidenceVariant(
  variant: unknown,
  profiles?: readonly FrontendLabEvidenceProfile[],
): void;
export function createFrontendLabEvidencePlan(input?: FrontendLabEvidenceInput): Readonly<{
  version: 2;
  fixtureId: string;
  fixtureRevision: string;
  planRevision: string;
  cases: readonly FrontendLabEvidenceCase[];
}>;
