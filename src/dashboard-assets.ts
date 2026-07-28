export type DashboardAssetKind = "css" | "javascript" | "svg";

export interface DashboardAssetExpectation {
  path: string;
  kind: DashboardAssetKind;
  contentTypes: readonly [string, ...string[]];
  marker: string;
}

const cssContentTypes = ["text/css"] as const;
const javascriptContentTypes = ["text/javascript", "application/javascript"] as const;
const svgContentTypes = ["image/svg+xml"] as const;

export const dashboardAssets: readonly DashboardAssetExpectation[] = [
  { path: "/styles.css", kind: "css", contentTypes: cssContentTypes, marker: ".detail-activity-thread" },
  { path: "/hosted-session.css", kind: "css", contentTypes: cssContentTypes, marker: ".hosted-sign-in" },
  { path: "/login-scrapbook.css", kind: "css", contentTypes: cssContentTypes, marker: ".workroom-preview" },
  { path: "/app.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "DEFAULT_ENDPOINT" },
  { path: "/hosted-session.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "hostedSessionSentinel" },
  { path: "/hosted-session-bridge.js", kind: "javascript", contentTypes: javascriptContentTypes, marker: "installHostedSessionFetchBridge" },
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
