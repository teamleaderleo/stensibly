/**
 * Current Glaeda-facing receipt intake API.
 *
 * Glaeda's successor execution-receipt generation is owned upstream by
 * teamleaderleo/smolrunner#751. Until that contract lands, Stensibly admits the
 * exact historical SmolRunner v1 wire identity through the legacy decoder and
 * exposes Glaeda-named integration aliases around it.
 *
 * Keep the legacy decoder's producer names, reference prefixes, fixtures, and
 * replay fingerprints exact. A future Glaeda wire identity belongs in an
 * explicit new version/generation instead of being folded into v1.
 */
export {
  SMOLRUNNER_RECEIPT_INTAKE_SCHEMA_VERSION as GLAEDA_RECEIPT_INTAKE_SCHEMA_VERSION,
  smolRunnerReceiptStates as glaedaReceiptStates,
  smolRunnerTransitionKinds as glaedaTransitionKinds,
  smolRunnerAttemptBindingSchema as glaedaAttemptBindingSchema,
  smolRunnerPublicReceiptSchema as glaedaPublicReceiptSchema,
  smolRunnerReceiptIntakeSchema as glaedaReceiptIntakeSchema,
  parseSmolRunnerReceiptIntake as parseGlaedaReceiptIntake,
  compareSmolRunnerReceiptTransitions as compareGlaedaReceiptTransitions,
  projectSmolRunnerReceiptLiveness as projectGlaedaReceiptLiveness,
} from "./smolrunner-receipt-intake.ts";

export type {
  SmolRunnerReceiptState as GlaedaReceiptState,
  SmolRunnerTransitionKind as GlaedaTransitionKind,
  SmolRunnerAttemptBinding as GlaedaAttemptBinding,
  SmolRunnerPublicReceipt as GlaedaPublicReceipt,
  SmolRunnerReceiptIntake as GlaedaReceiptIntake,
  SmolRunnerReceiptTransition as GlaedaReceiptTransition,
  SmolRunnerReceiptReplayDecision as GlaedaReceiptReplayDecision,
  SmolRunnerReceiptLiveness as GlaedaReceiptLiveness,
} from "./smolrunner-receipt-intake.ts";
