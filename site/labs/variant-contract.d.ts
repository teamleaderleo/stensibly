export const frontendVariantContractVersion: 1;

export const frontendVariantStatuses: readonly [
  "ready",
  "active",
  "blocked",
  "done",
];

export const requiredFrontendVariantStates: readonly FrontendVariantState[];
export const requiredFrontendVariantCapabilities: readonly FrontendVariantCapability[];

export type FrontendVariantState =
  | "loading"
  | "empty"
  | "ready"
  | "active"
  | "blocked"
  | "done"
  | "degraded"
  | "error"
  | "disconnected"
  | "unauthorized";

export type FrontendVariantCapability =
  | "connection.read"
  | "connection.edit"
  | "project.filter"
  | "item.create"
  | "item.read"
  | "item.claim"
  | "item.progress"
  | "item.block"
  | "item.complete"
  | "item.handoff"
  | "evidence.read"
  | "worker.read"
  | "recovery.read"
  | "refresh";

export interface FrontendVariantTheme {
  readonly border: string;
  readonly danger: string;
  readonly focus: string;
  readonly statusActive: string;
  readonly statusBlocked: string;
  readonly statusDone: string;
  readonly statusReady: string;
  readonly success: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly text: string;
  readonly textMuted: string;
}

export interface FrontendVariantPresentation {
  readonly fontFamily: "system" | "serif" | "mono" | "rounded";
  readonly iconTreatment: "line" | "solid" | "mixed";
  readonly illustration: "none" | "diagram" | "companion" | "editorial";
  readonly panelArrangement: "rows" | "cards" | "split" | "canvas" | "map";
  readonly radius: "none" | "small" | "medium" | "large" | "pill";
  readonly texture: "none" | "paper" | "grid" | "noise";
}

export interface FrontendVariantInvariants {
  readonly density: number;
  readonly focusContrast: number;
  readonly focusWidth: number;
  readonly minimumTargetSize: number;
  readonly motionDuration: number;
  readonly nonColorCues: true;
  readonly textContrast: number;
}

export interface FrontendVariantExperiment {
  readonly issue: number;
  readonly owner: string;
  readonly promotionStatus: "draft" | "candidate" | "promoted" | "retired";
  readonly revision: string | null;
  readonly stateCoverage: readonly FrontendVariantState[];
  readonly thesis: string;
}

export interface FrontendVariantContract {
  readonly version: 1;
  readonly id: string;
  readonly themes: {
    readonly light: FrontendVariantTheme | null;
    readonly dark: FrontendVariantTheme | null;
  };
  readonly presentation: FrontendVariantPresentation;
  readonly invariants: FrontendVariantInvariants;
  readonly capabilities: readonly FrontendVariantCapability[];
  readonly experiment: FrontendVariantExperiment;
}

export const frontendVariantProductSemantics: Readonly<{
  statuses: readonly ["ready", "active", "blocked", "done"];
  authority: "server-issued";
  actionMeaning: "shared";
  confirmation: "required-for-destructive-or-authority-expanding-actions";
  evidence: "source-linked";
  recovery: "explicit";
  connectionBehavior: "shared";
}>;

export const frontendVariantProductReviewFields: readonly string[];

export function parseFrontendVariantContract(value: unknown): FrontendVariantContract;
export function frontendVariantCapabilityGaps(value: unknown): readonly FrontendVariantCapability[];
export function frontendVariantStateGaps(value: unknown): readonly FrontendVariantState[];
export function assertFrontendVariantParity(value: unknown): FrontendVariantContract;
export function compileFrontendVariantCss(value: unknown): string;
