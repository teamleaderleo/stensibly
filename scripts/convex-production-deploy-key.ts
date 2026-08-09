export const STENSIBLY_PRODUCTION_CONVEX_DEPLOYMENT = "resilient-donkey-323";

const productionDeploymentKeyPattern = new RegExp(
  `^prod:${STENSIBLY_PRODUCTION_CONVEX_DEPLOYMENT}\\|[^\\r\\n]{1,8192}$`,
  "u",
);

export function assertConvexProductionDeployKey(value: unknown): void {
  if (typeof value !== "string" || !productionDeploymentKeyPattern.test(value)) {
    throw new RangeError(
      "CONVEX_DEPLOY_KEY must target the Stensibly production deployment",
    );
  }
}

if (import.meta.main) {
  try {
    assertConvexProductionDeployKey(process.env.CONVEX_DEPLOY_KEY);
    console.log("Convex production deployment key class accepted");
  } catch {
    console.error("CONVEX_DEPLOY_KEY must target the Stensibly production deployment");
    process.exitCode = 1;
  }
}
