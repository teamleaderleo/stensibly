export const CI_BROWSER_EVIDENCE_PROFILE_CONTRACT_V1 = 1 as const;

export const CI_BROWSER_EVIDENCE_COMMAND_IDS_V1 = Object.freeze([
  "browser-typecheck",
  "browser-tests",
  "browser-artifacts",
] as const);

export const CI_BROWSER_EVIDENCE_TOPOLOGIES_V1 = Object.freeze({
  full_parallel: Object.freeze({
    execution: "adjunct_runner",
    jobName: "browser-evidence",
    commandIds: CI_BROWSER_EVIDENCE_COMMAND_IDS_V1,
  }),
  serial_full: Object.freeze({
    execution: "same_runner",
    jobName: "serial-full",
    commandIds: CI_BROWSER_EVIDENCE_COMMAND_IDS_V1,
  }),
} as const);

export type CiBrowserEvidenceCommandId =
  typeof CI_BROWSER_EVIDENCE_COMMAND_IDS_V1[number];
export type CiBrowserEvidenceExecution =
  typeof CI_BROWSER_EVIDENCE_TOPOLOGIES_V1[keyof typeof CI_BROWSER_EVIDENCE_TOPOLOGIES_V1]["execution"];
