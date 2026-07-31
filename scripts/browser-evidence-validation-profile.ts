export const browserEvidenceValidationProfileVersion = 1;

export const browserEvidenceValidationProfile = Object.freeze({
  id: "browser-evidence/v1",
  commands: Object.freeze([
    "browser-typecheck",
    "browser-tests",
    "browser-artifacts",
  ] as const),
  fullParallelJob: "browser-evidence",
  serialFullJob: "serial-full",
});
