/**
 * Current Glaeda-facing receipt intake API.
 *
 * Glaeda's successor execution-receipt generation is owned upstream by
 * teamleaderleo/smolrunner#751. Until that contract lands, Stensibly admits the
 * exact historical SmolRunner v1 wire identity through the legacy decoder and
 * exposes Glaeda-named product integration operations around it.
 *
 * Legacy wire schemas stay explicitly SmolRunner-v1-labelled here. A future
 * Glaeda wire identity belongs in a distinct version/generation instead of
 * being folded into v1.
 */
export {
  smolRunnerReceiptStates as glaedaReceiptStates,
  smolRunnerTransitionKinds as glaedaTransitionKinds,
  parseSmolRunnerReceiptIntake as parseGlaedaReceiptIntake,
  compareSmolRunnerReceiptTransitions as compareGlaedaReceiptTransitions,
  projectSmolRunnerReceiptLiveness as projectGlaedaReceiptLiveness,
} from "./smolrunner-receipt-intake.ts";

export {
  SMOLRUNNER_RECEIPT_INTAKE_SCHEMA_VERSION as LEGACY_SMOLRUNNER_V1_RECEIPT_INTAKE_SCHEMA_VERSION,
  smolRunnerAttemptBindingSchema as legacySmolRunnerV1AttemptBindingSchema,
  smolRunnerPublicReceiptSchema as legacySmolRunnerV1PublicReceiptSchema,
  smolRunnerReceiptIntakeSchema as legacySmolRunnerV1ReceiptIntakeSchema,
} from "./smolrunner-receipt-intake.ts";

export type {
  SmolRunnerReceiptState as GlaedaReceiptState,
  SmolRunnerTransitionKind as GlaedaTransitionKind,
  SmolRunnerReceiptIntake as GlaedaReceiptIntake,
  SmolRunnerReceiptTransition as GlaedaReceiptTransition,
  SmolRunnerReceiptReplayDecision as GlaedaReceiptReplayDecision,
  SmolRunnerReceiptLiveness as GlaedaReceiptLiveness,
  SmolRunnerAttemptBinding as LegacySmolRunnerV1AttemptBinding,
  SmolRunnerPublicReceipt as LegacySmolRunnerV1PublicReceipt,
  SmolRunnerReceiptIntake as LegacySmolRunnerV1ReceiptIntake,
} from "./smolrunner-receipt-intake.ts";
