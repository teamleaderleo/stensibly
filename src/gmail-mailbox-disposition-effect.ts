import {
  gmailMailboxDispositionForState,
  type GmailMailboxDisposition,
  type MailAttentionClass,
  type MailThreadState,
} from "./mail-ux-projection.js";

export const GMAIL_MAILBOX_DISPOSITION_EFFECT_VERSION =
  "gmail-mailbox-disposition-effect/v1" as const;

const INBOX_LABEL_ID = "INBOX";
const UNREAD_LABEL_ID = "UNREAD";
const encoder = new TextEncoder();

export interface SettledGmailMessageBinding {
  source: "settled_gmail_message_binding";
  provider: "gmail";
  stnThreadId: string;
  accountBinding: string;
  providerThreadId: string;
  providerMessageId: string;
  stensiblyLabelId: string;
}

export interface CurrentDurableStnMailboxState {
  source: "durable_stn_state";
  stnThreadId: string;
  revision: string;
  attentionClass: MailAttentionClass;
  operatorAttentionRequired: boolean;
  state: MailThreadState;
}

export interface CurrentDurableStnMailboxStateReader {
  readCurrentState(input: {
    stnThreadId: string;
  }): Promise<CurrentDurableStnMailboxState | null>;
}

export interface GmailMessageLabelSnapshot {
  source: "gmail_message_label_snapshot";
  provider: "gmail";
  accountBinding: string;
  providerThreadId: string;
  providerMessageId: string;
  labelIds: readonly string[];
  isDraft: boolean;
}

// Intentionally label-only. This consumer cannot send, retry, reply, or reconcile mail delivery.
export interface GmailMailboxLabelClient {
  readMessageLabels(input: {
    accountBinding: string;
    providerThreadId: string;
    providerMessageId: string;
  }): Promise<GmailMessageLabelSnapshot | null>;
  mutateMessageLabels(input: {
    accountBinding: string;
    providerThreadId: string;
    providerMessageId: string;
    dispositionEffectId: string;
    addLabelIds: readonly string[];
    removeLabelIds: readonly string[];
  }): Promise<void>;
}

export type GmailMailboxDispositionReconciliationPhase =
  | "interrupted"
  | "precondition_read"
  | "mutation_outcome"
  | "post_mutation_readback";

export type GmailMailboxDispositionSettledOutcome =
  | "applied"
  | "noop"
  | "ignored_draft"
  | "reconciled";

export interface GmailMailboxDispositionEffect {
  version: typeof GMAIL_MAILBOX_DISPOSITION_EFFECT_VERSION;
  effectId: string;
  binding: Readonly<SettledGmailMessageBinding>;
  stnStateRevision: string;
  disposition: Readonly<GmailMailboxDisposition>;
  requiredLabelIds: readonly string[];
  forbiddenLabelIds: readonly string[];
  authorizesMailSend: false;
}

export interface GmailMailboxDispositionEffectRecord {
  effect: GmailMailboxDispositionEffect;
  status: "reserved" | "reconciliation_required" | "settled";
  reconciliationPhase: GmailMailboxDispositionReconciliationPhase | null;
  settledOutcome: GmailMailboxDispositionSettledOutcome | null;
}

export type GmailMailboxDispositionReserveResult =
  | { status: "reserved" }
  | { status: "existing"; record: GmailMailboxDispositionEffectRecord };

// The store must reserve atomically and return any unsettled effect for the same exact
// provider target. An uncertain mutation therefore fences both exact replay and newer
// STN-state effects until read-only label reconciliation clears the old effect.
export interface GmailMailboxDispositionEffectStore {
  findOutstandingForTarget(
    binding: SettledGmailMessageBinding,
  ): Promise<GmailMailboxDispositionEffectRecord | null>;
  reserveEffect(
    effect: GmailMailboxDispositionEffect,
  ): Promise<GmailMailboxDispositionReserveResult>;
  markReconciliationRequired(
    effectId: string,
    phase: GmailMailboxDispositionReconciliationPhase,
  ): Promise<void>;
  markSettled(
    effectId: string,
    outcome: GmailMailboxDispositionSettledOutcome,
  ): Promise<void>;
  releasePreconditionRetry(effectId: string): Promise<void>;
}

export type GmailMailboxDispositionExecutionResult =
  | {
      status: "applied" | "noop" | "ignored_draft" | "replayed";
      effect: GmailMailboxDispositionEffect;
      outcome: GmailMailboxDispositionSettledOutcome;
    }
  | {
      status: "reconciliation_required";
      effect: GmailMailboxDispositionEffect;
      phase: GmailMailboxDispositionReconciliationPhase;
      recoveryAction: "reconcile_exact_gmail_message_labels";
    }
  | {
      status: "blocked_by_prior_reconciliation";
      effect: GmailMailboxDispositionEffect;
      outstandingEffectId: string;
      recoveryAction: "reconcile_prior_exact_gmail_message_labels";
    }
  | {
      status: "blocked";
      reason:
        | "current_state_unavailable"
        | "current_state_identity_conflict"
        | "provider_message_missing"
        | "provider_identity_conflict";
      effect: GmailMailboxDispositionEffect | null;
    };

export type GmailMailboxDispositionReconciliationResult =
  | {
      status: "reconciled";
      effect: GmailMailboxDispositionEffect;
    }
  | {
      status: "retry_safe";
      effect: GmailMailboxDispositionEffect;
      recoveryAction: "retry_same_effect_after_precondition_read";
    }
  | {
      status: "pending";
      effect: GmailMailboxDispositionEffect;
      recoveryAction: "reconcile_exact_gmail_message_labels";
    }
  | {
      status: "superseded";
      effect: GmailMailboxDispositionEffect;
      currentStateRevision: string;
      priorEffectCleared: boolean;
      recoveryAction:
        | "apply_current_state_effect"
        | "reconcile_old_effect_before_current_state_effect";
    }
  | {
      status: "blocked";
      reason:
        | "current_state_unavailable"
        | "current_state_identity_conflict"
        | "provider_message_missing"
        | "provider_identity_conflict";
      effect: GmailMailboxDispositionEffect;
    };

export async function executeGmailMailboxDispositionEffect(input: {
  binding: SettledGmailMessageBinding;
  stateReader: CurrentDurableStnMailboxStateReader;
  labelClient: GmailMailboxLabelClient;
  effectStore: GmailMailboxDispositionEffectStore;
}): Promise<GmailMailboxDispositionExecutionResult> {
  const binding = freezeBinding(input.binding);
  const stateRead = await readCurrentState(input.stateReader, binding.stnThreadId);
  if (stateRead.status === "unavailable") {
    return { status: "blocked", reason: "current_state_unavailable", effect: null };
  }
  if (stateRead.status === "conflict") {
    return { status: "blocked", reason: "current_state_identity_conflict", effect: null };
  }

  const effect = buildGmailMailboxDispositionEffect(binding, stateRead.state);
  const outstanding = await input.effectStore.findOutstandingForTarget(binding);
  if (outstanding !== null && outstanding.effect.effectId !== effect.effectId) {
    return {
      status: "blocked_by_prior_reconciliation",
      effect,
      outstandingEffectId: outstanding.effect.effectId,
      recoveryAction: "reconcile_prior_exact_gmail_message_labels",
    };
  }

  const reservation = await input.effectStore.reserveEffect(effect);
  if (reservation.status === "existing") {
    if (reservation.record.status === "settled") {
      return {
        status: "replayed",
        effect,
        outcome: reservation.record.settledOutcome ?? "noop",
      };
    }
    const phase = reservation.record.reconciliationPhase ?? "interrupted";
    if (reservation.record.status === "reserved") {
      await input.effectStore.markReconciliationRequired(effect.effectId, phase);
    }
    return {
      status: "reconciliation_required",
      effect,
      phase,
      recoveryAction: "reconcile_exact_gmail_message_labels",
    };
  }

  let snapshot: GmailMessageLabelSnapshot | null;
  try {
    snapshot = await input.labelClient.readMessageLabels(binding);
  } catch {
    await input.effectStore.markReconciliationRequired(effect.effectId, "precondition_read");
    return reconciliationRequired(effect, "precondition_read");
  }
  if (snapshot === null) {
    await input.effectStore.markReconciliationRequired(effect.effectId, "precondition_read");
    return {
      status: "blocked",
      reason: "provider_message_missing",
      effect,
    };
  }

  const admitted = freezeSnapshot(snapshot);
  if (!snapshotMatchesBinding(admitted, binding)) {
    await input.effectStore.markReconciliationRequired(effect.effectId, "precondition_read");
    return {
      status: "blocked",
      reason: "provider_identity_conflict",
      effect,
    };
  }
  if (admitted.isDraft) {
    await input.effectStore.markSettled(effect.effectId, "ignored_draft");
    return { status: "ignored_draft", effect, outcome: "ignored_draft" };
  }

  const delta = labelDelta(effect, admitted.labelIds);
  if (delta.addLabelIds.length === 0 && delta.removeLabelIds.length === 0) {
    await input.effectStore.markSettled(effect.effectId, "noop");
    return { status: "noop", effect, outcome: "noop" };
  }

  try {
    await input.labelClient.mutateMessageLabels({
      accountBinding: binding.accountBinding,
      providerThreadId: binding.providerThreadId,
      providerMessageId: binding.providerMessageId,
      dispositionEffectId: effect.effectId,
      addLabelIds: delta.addLabelIds,
      removeLabelIds: delta.removeLabelIds,
    });
  } catch {
    await input.effectStore.markReconciliationRequired(effect.effectId, "mutation_outcome");
    return reconciliationRequired(effect, "mutation_outcome");
  }

  let readback: GmailMessageLabelSnapshot | null;
  try {
    readback = await input.labelClient.readMessageLabels(binding);
  } catch {
    await input.effectStore.markReconciliationRequired(effect.effectId, "post_mutation_readback");
    return reconciliationRequired(effect, "post_mutation_readback");
  }
  if (readback === null) {
    await input.effectStore.markReconciliationRequired(effect.effectId, "post_mutation_readback");
    return reconciliationRequired(effect, "post_mutation_readback");
  }
  const admittedReadback = freezeSnapshot(readback);
  if (!snapshotMatchesBinding(admittedReadback, binding)) {
    await input.effectStore.markReconciliationRequired(effect.effectId, "post_mutation_readback");
    return {
      status: "blocked",
      reason: "provider_identity_conflict",
      effect,
    };
  }
  if (!labelsSatisfy(effect, admittedReadback.labelIds)) {
    await input.effectStore.markReconciliationRequired(effect.effectId, "post_mutation_readback");
    return reconciliationRequired(effect, "post_mutation_readback");
  }

  await input.effectStore.markSettled(effect.effectId, "applied");
  return { status: "applied", effect, outcome: "applied" };
}

export async function reconcileGmailMailboxDispositionEffect(input: {
  effect: GmailMailboxDispositionEffect;
  stateReader: CurrentDurableStnMailboxStateReader;
  labelClient: GmailMailboxLabelClient;
  effectStore: GmailMailboxDispositionEffectStore;
  phase: GmailMailboxDispositionReconciliationPhase;
}): Promise<GmailMailboxDispositionReconciliationResult> {
  const effect = freezeEffect(input.effect);
  const stateRead = await readCurrentState(
    input.stateReader,
    effect.binding.stnThreadId,
  );
  if (stateRead.status === "unavailable") {
    return { status: "blocked", reason: "current_state_unavailable", effect };
  }
  if (stateRead.status === "conflict") {
    return { status: "blocked", reason: "current_state_identity_conflict", effect };
  }
  const currentRevision = stateRead.state.revision;
  const superseded = currentRevision !== effect.stnStateRevision;

  let snapshot: GmailMessageLabelSnapshot | null;
  try {
    snapshot = await input.labelClient.readMessageLabels(effect.binding);
  } catch {
    return superseded
      ? {
          status: "superseded",
          effect,
          currentStateRevision: currentRevision,
          priorEffectCleared: false,
          recoveryAction: "reconcile_old_effect_before_current_state_effect",
        }
      : {
          status: "pending",
          effect,
          recoveryAction: "reconcile_exact_gmail_message_labels",
        };
  }
  if (snapshot === null) {
    return { status: "blocked", reason: "provider_message_missing", effect };
  }
  const admitted = freezeSnapshot(snapshot);
  if (!snapshotMatchesBinding(admitted, effect.binding)) {
    return { status: "blocked", reason: "provider_identity_conflict", effect };
  }
  if (admitted.isDraft) {
    await input.effectStore.markSettled(effect.effectId, "ignored_draft");
    return superseded
      ? {
          status: "superseded",
          effect,
          currentStateRevision: currentRevision,
          priorEffectCleared: true,
          recoveryAction: "apply_current_state_effect",
        }
      : { status: "reconciled", effect };
  }
  if (labelsSatisfy(effect, admitted.labelIds)) {
    await input.effectStore.markSettled(effect.effectId, "reconciled");
    return superseded
      ? {
          status: "superseded",
          effect,
          currentStateRevision: currentRevision,
          priorEffectCleared: true,
          recoveryAction: "apply_current_state_effect",
        }
      : { status: "reconciled", effect };
  }
  if (input.phase === "precondition_read") {
    if (superseded) {
      await input.effectStore.markSettled(effect.effectId, "noop");
      return {
        status: "superseded",
        effect,
        currentStateRevision: currentRevision,
        priorEffectCleared: true,
        recoveryAction: "apply_current_state_effect",
      };
    }
    await input.effectStore.releasePreconditionRetry(effect.effectId);
    return {
      status: "retry_safe",
      effect,
      recoveryAction: "retry_same_effect_after_precondition_read",
    };
  }
  if (superseded) {
    return {
      status: "superseded",
      effect,
      currentStateRevision: currentRevision,
      priorEffectCleared: false,
      recoveryAction: "reconcile_old_effect_before_current_state_effect",
    };
  }
  return {
    status: "pending",
    effect,
    recoveryAction: "reconcile_exact_gmail_message_labels",
  };
}

export function buildGmailMailboxDispositionEffect(
  bindingInput: SettledGmailMessageBinding,
  stateInput: CurrentDurableStnMailboxState,
): GmailMailboxDispositionEffect {
  const binding = freezeBinding(bindingInput);
  const state = freezeCurrentState(stateInput);
  if (state.stnThreadId !== binding.stnThreadId) {
    throw new TypeError("current STN state does not match the settled Gmail binding");
  }
  const disposition = gmailMailboxDispositionForState({
    state: state.state,
    operatorAttentionRequired: state.operatorAttentionRequired,
  });
  const requiredLabelIds = disposition.archive
    ? [binding.stensiblyLabelId]
    : [binding.stensiblyLabelId, INBOX_LABEL_ID, UNREAD_LABEL_ID];
  const forbiddenLabelIds = disposition.archive
    ? [INBOX_LABEL_ID, UNREAD_LABEL_ID]
    : [];
  const effectId = [
    GMAIL_MAILBOX_DISPOSITION_EFFECT_VERSION,
    binding.stnThreadId,
    binding.accountBinding,
    binding.providerThreadId,
    binding.providerMessageId,
    binding.stensiblyLabelId,
    state.revision,
    disposition.reason,
    disposition.archive ? "archive" : "inbox",
    disposition.markRead ? "read" : "unread",
  ].map(encodeEffectComponent).join("|");
  return freezeEffect({
    version: GMAIL_MAILBOX_DISPOSITION_EFFECT_VERSION,
    effectId,
    binding,
    stnStateRevision: state.revision,
    disposition,
    requiredLabelIds,
    forbiddenLabelIds,
    authorizesMailSend: false,
  });
}

function reconciliationRequired(
  effect: GmailMailboxDispositionEffect,
  phase: GmailMailboxDispositionReconciliationPhase,
): GmailMailboxDispositionExecutionResult {
  return {
    status: "reconciliation_required",
    effect,
    phase,
    recoveryAction: "reconcile_exact_gmail_message_labels",
  };
}

function labelDelta(
  effect: GmailMailboxDispositionEffect,
  currentLabelIds: readonly string[],
): { addLabelIds: readonly string[]; removeLabelIds: readonly string[] } {
  const current = new Set(currentLabelIds);
  return Object.freeze({
    addLabelIds: Object.freeze(effect.requiredLabelIds.filter((id) => !current.has(id))),
    removeLabelIds: Object.freeze(effect.forbiddenLabelIds.filter((id) => current.has(id))),
  });
}

function labelsSatisfy(
  effect: GmailMailboxDispositionEffect,
  currentLabelIds: readonly string[],
): boolean {
  const current = new Set(currentLabelIds);
  return effect.requiredLabelIds.every((id) => current.has(id))
    && effect.forbiddenLabelIds.every((id) => !current.has(id));
}

async function readCurrentState(
  reader: CurrentDurableStnMailboxStateReader,
  stnThreadId: string,
): Promise<
  | { status: "ok"; state: CurrentDurableStnMailboxState }
  | { status: "unavailable" }
  | { status: "conflict" }
> {
  let current: CurrentDurableStnMailboxState | null;
  try {
    current = await reader.readCurrentState({ stnThreadId });
  } catch {
    return { status: "unavailable" };
  }
  if (current === null) return { status: "unavailable" };
  let admitted: CurrentDurableStnMailboxState;
  try {
    admitted = freezeCurrentState(current);
  } catch {
    return { status: "conflict" };
  }
  if (admitted.stnThreadId !== stnThreadId) return { status: "conflict" };
  return { status: "ok", state: admitted };
}

function snapshotMatchesBinding(
  snapshot: GmailMessageLabelSnapshot,
  binding: SettledGmailMessageBinding,
): boolean {
  return snapshot.provider === "gmail"
    && snapshot.accountBinding === binding.accountBinding
    && snapshot.providerThreadId === binding.providerThreadId
    && snapshot.providerMessageId === binding.providerMessageId;
}

function freezeBinding(input: SettledGmailMessageBinding): SettledGmailMessageBinding {
  if (input.source !== "settled_gmail_message_binding" || input.provider !== "gmail") {
    throw new TypeError("Gmail disposition requires a settled Gmail message binding");
  }
  const stensiblyLabelId = exactIdentifier(input.stensiblyLabelId, "Stensibly label ID", 160);
  if (stensiblyLabelId === INBOX_LABEL_ID || stensiblyLabelId === UNREAD_LABEL_ID) {
    throw new TypeError("Stensibly label ID must be an existing non-system label");
  }
  return Object.freeze({
    source: "settled_gmail_message_binding",
    provider: "gmail",
    stnThreadId: exactIdentifier(input.stnThreadId, "STN thread ID", 240),
    accountBinding: exactIdentifier(input.accountBinding, "Gmail account binding", 320),
    providerThreadId: exactIdentifier(input.providerThreadId, "Gmail thread ID", 320),
    providerMessageId: exactIdentifier(input.providerMessageId, "Gmail message ID", 320),
    stensiblyLabelId,
  });
}

function freezeCurrentState(
  input: CurrentDurableStnMailboxState,
): CurrentDurableStnMailboxState {
  if (input.source !== "durable_stn_state") {
    throw new TypeError("operator attention must come from current durable STN state");
  }
  if (input.state !== "active" && input.state !== "waiting" && input.state !== "resolved") {
    throw new TypeError("current STN mailbox state is invalid");
  }
  if (
    input.attentionClass !== "handoff"
    && input.attentionClass !== "review"
    && input.attentionClass !== "decision"
    && input.attentionClass !== "incident"
  ) {
    throw new TypeError("current STN attention class is invalid");
  }
  if (typeof input.operatorAttentionRequired !== "boolean") {
    throw new TypeError("operatorAttentionRequired must be boolean");
  }
  return Object.freeze({
    source: "durable_stn_state",
    stnThreadId: exactIdentifier(input.stnThreadId, "current STN thread ID", 240),
    revision: exactIdentifier(input.revision, "current STN state revision", 320),
    attentionClass: input.attentionClass,
    operatorAttentionRequired: input.operatorAttentionRequired,
    state: input.state,
  });
}

function freezeSnapshot(input: GmailMessageLabelSnapshot): GmailMessageLabelSnapshot {
  if (input.source !== "gmail_message_label_snapshot" || input.provider !== "gmail") {
    throw new TypeError("Gmail label readback identity is invalid");
  }
  if (typeof input.isDraft !== "boolean") {
    throw new TypeError("Gmail draft state must be boolean");
  }
  const labels = input.labelIds.map((id) => exactIdentifier(id, "Gmail label ID", 160));
  return Object.freeze({
    source: "gmail_message_label_snapshot",
    provider: "gmail",
    accountBinding: exactIdentifier(input.accountBinding, "Gmail account binding", 320),
    providerThreadId: exactIdentifier(input.providerThreadId, "Gmail thread ID", 320),
    providerMessageId: exactIdentifier(input.providerMessageId, "Gmail message ID", 320),
    labelIds: Object.freeze([...new Set(labels)]),
    isDraft: input.isDraft,
  });
}

function freezeEffect(input: GmailMailboxDispositionEffect): GmailMailboxDispositionEffect {
  if (input.version !== GMAIL_MAILBOX_DISPOSITION_EFFECT_VERSION || input.authorizesMailSend !== false) {
    throw new TypeError("Gmail mailbox disposition effect version is invalid");
  }
  return Object.freeze({
    version: GMAIL_MAILBOX_DISPOSITION_EFFECT_VERSION,
    effectId: exactIdentifier(input.effectId, "Gmail disposition effect ID", 4096),
    binding: freezeBinding(input.binding),
    stnStateRevision: exactIdentifier(input.stnStateRevision, "STN state revision", 320),
    disposition: Object.freeze({ ...input.disposition }),
    requiredLabelIds: Object.freeze([...input.requiredLabelIds]),
    forbiddenLabelIds: Object.freeze([...input.forbiddenLabelIds]),
    authorizesMailSend: false,
  });
}

function exactIdentifier(value: string, field: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty exact string`);
  }
  if (/\r|\n|\0/.test(value) || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(`${field} is outside the admitted bound`);
  }
  return value;
}

function encodeEffectComponent(value: string): string {
  return encodeURIComponent(value);
}
