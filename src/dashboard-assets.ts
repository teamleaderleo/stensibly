export type DashboardAssetKind = "css" | "javascript" | "svg" | "png";

export interface DashboardAssetExpectation {
  path: string;
  kind: DashboardAssetKind;
  contentTypes: readonly [string, ...string[]];
  marker: string;
}

const cssContentTypes = ["text/css"] as const;
const javascriptContentTypes = ["text/javascript", "application/javascript"] as const;
const svgContentTypes = ["image/svg+xml"] as const;
const pngContentTypes = ["image/png"] as const;

export const dashboardAssets: readonly DashboardAssetExpectation[] = [
  { path: "/styles.css", kind: "css", contentTypes: cssContentTypes, marker: ".detail-activity-thread" },
  { path: "/hosted-session.css", kind: "css", contentTypes: cssContentTypes, marker: ".hosted-sign-in" },
  { path: "/root-mode-status.css", kind: "css", contentTypes: cssContentTypes, marker: ".root-connecting-status" },
  { path: "/studio-control.css", kind: "css", contentTypes: cssContentTypes, marker: ".overview-grid" },
  { path: "/provider-capacity.css", kind: "css", contentTypes: cssContentTypes, marker: ".provider-capacity" },
  { path: "/project-setup-status.css", kind: "css", contentTypes: cssContentTypes, marker: ".project-setup-status" },
  { path: "/app.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "DEFAULT_ENDPOINT" },
  { path: "/ui-preferences.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "stensiblyDashboardView" },
  { path: "/studio-control-social.png", kind: "png", contentTypes: pngContentTypes, marker: "PNG" },
  { path: "/dashboard-snapshot-cache.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "readDashboardSnapshot" },
  { path: "/hosted-session.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "hostedSessionSentinel" },
  { path: "/hosted-session-bridge.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installProjectSetupStatusCard" },
  { path: "/provider-capacity-entry.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installProviderCapacityCard" },
  { path: "/provider-capacity-controller.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "createProviderCapacityController" },
  { path: "/provider-capacity.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "readProviderCapacity" },
  { path: "/project-setup-status-entry.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installProjectSetupStatusCard" },
  { path: "/project-setup-status.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "readProjectSetupStatus" },
  { path: "/project-attachment-review.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "createRepositoryAttachmentDraft" },
  { path: "/item-claim.css", kind: "css", contentTypes: cssContentTypes, marker: ".detail-claim" },
  { path: "/item-claim.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "validateClaimInput" },
  { path: "/item-detail-controller.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "activityThreadSection" },
  { path: "/item-activity-thread.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "projectActivityThread" },
  { path: "/item-progress-controller.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installProgressController" },
  { path: "/item-block-controller.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installBlockController" },
  { path: "/item-complete-controller.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installCompleteController" },
  { path: "/board-filter-controller.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installBoardFilterController" },
  { path: "/board-filter.css", kind: "css", contentTypes: cssContentTypes, marker: ".board-filter-panel" },
  { path: "/project-brief-controller.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installProjectBriefController" },
  { path: "/project-brief.css", kind: "css", contentTypes: cssContentTypes, marker: ".project-brief-dialog" },
  { path: "/actor-activity-controller.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installActorActivityController" },
  { path: "/actor-activity.css", kind: "css", contentTypes: cssContentTypes, marker: ".actor-activity-dialog" },
  { path: "/favicon.svg", kind: "svg", contentTypes: svgContentTypes, marker: "<svg" },
];

export function dashboardAssetContentType(asset: DashboardAssetExpectation): RegExp {
  const allowed = asset.contentTypes.map(escapeRegExp).join("|");
  return new RegExp(`^(?:${allowed})(?:\\s*;.*)?$`, "i");
}

export function serializeDashboardAssets(): string {
  return JSON.stringify(dashboardAssets);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.main) {
  console.log(serializeDashboardAssets());
}
