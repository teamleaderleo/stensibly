export type DashboardAssetKind = "css" | "javascript" | "svg";

export interface DashboardAssetExpectation {
  path: string;
  kind: DashboardAssetKind;
  marker: string;
}

export const dashboardAssets: readonly DashboardAssetExpectation[] = [
  { path: "/styles.css", kind: "css", marker: ":root" },
  { path: "/app.js", kind: "javascript", marker: "DEFAULT_ENDPOINT" },
  { path: "/item-claim.css", kind: "css", marker: ".detail-claim" },
  { path: "/item-claim.js", kind: "javascript", marker: "validateClaimInput" },
  { path: "/item-progress-controller.js", kind: "javascript", marker: "installProgressController" },
  { path: "/item-block-controller.js", kind: "javascript", marker: "installBlockController" },
  { path: "/item-complete-controller.js", kind: "javascript", marker: "installCompleteController" },
  { path: "/board-filter-controller.js", kind: "javascript", marker: "installBoardFilterController" },
  { path: "/board-filter.css", kind: "css", marker: ".board-filter-panel" },
  { path: "/project-brief-controller.js", kind: "javascript", marker: "installProjectBriefController" },
  { path: "/project-brief.css", kind: "css", marker: ".project-brief-dialog" },
  { path: "/actor-activity-controller.js", kind: "javascript", marker: "installActorActivityController" },
  { path: "/actor-activity.css", kind: "css", marker: ".actor-activity-dialog" },
  { path: "/favicon.svg", kind: "svg", marker: "<svg" },
];

export function dashboardAssetContentType(kind: DashboardAssetKind): RegExp {
  switch (kind) {
    case "css":
      return /text\/css/i;
    case "javascript":
      return /(text|application)\/javascript/i;
    case "svg":
      return /image\/svg\+xml/i;
  }
}

export function serializeDashboardAssets(): string {
  return JSON.stringify(dashboardAssets);
}

if (import.meta.main) {
  console.log(serializeDashboardAssets());
}
