import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import type { PrepareLazyWorkstationCommandInputV1 } from "./lazy-workstation-adapter.js";
import { sha256Hex } from "./sha256.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,239}$/u;

export interface LazyCampaignAcceptanceProposalV2 {
  transitionId: string;
  ownerRef: string;
  evaluatedOwnerGeneration: number;
  evaluatedOwnerFingerprint: string;
  evaluatedCursorVectorFingerprint: string;
  requestedCodexReservationTokens: number;
  authorizesWork: false;
  authorizesEffects: false;
  authorizesDispatch: false;
}

export type PrepareLazyCampaignCommandBaseV1 = Omit<
  PrepareLazyWorkstationCommandInputV1,
  "commandId" | "idempotencyKey"
>;

export interface LazyCampaignProposalBindingReceiptV1 {
  version: 1;
  kind: "lazy_campaign_proposal_binding";
  transitionId: string;
  proposalFingerprint: string;
  commandId: string;
  idempotencyKey: string;
  ownerRef: string;
  ownerGeneration: number;
  ownerFingerprint: string;
  cursorVectorFingerprint: string;
  requestedCodexReservationTokens: number;
  executesWork: false;
  authorizesWork: false;
  authorizesEffects: false;
  authorizesDispatch: false;
}

export function bindLazyCampaignProposal(
  rawBase: PrepareLazyCampaignCommandBaseV1,
  rawProposal: LazyCampaignAcceptanceProposalV2,
): Readonly<{
  prepared: PrepareLazyWorkstationCommandInputV1;
  receipt: LazyCampaignProposalBindingReceiptV1;
}> {
  const proposal = normalizeProposal(rawProposal);
  const proposalFingerprint = `sha256:${sha256Hex(canonicalJsonString(proposal))}`;
  const commandId = [
    "lazy-campaign",
    proposal.transitionId.slice(0, 32),
    proposalFingerprint.slice(7),
  ].join("-");
  const idempotencyKey = `lazy-campaign:${proposal.transitionId}`;
  const parameters = Object.freeze({
    ...rawBase.profile.parameters,
    "command-id": commandId,
  });
  const prepared: PrepareLazyWorkstationCommandInputV1 = deepFreeze({
    ...rawBase,
    authority: { ...rawBase.authority },
    commandId,
    idempotencyKey,
    profile: { ...rawBase.profile, parameters },
  });
  const receipt: LazyCampaignProposalBindingReceiptV1 = deepFreeze({
    version: 1,
    kind: "lazy_campaign_proposal_binding",
    transitionId: proposal.transitionId,
    proposalFingerprint,
    commandId,
    idempotencyKey,
    ownerRef: proposal.ownerRef,
    ownerGeneration: proposal.evaluatedOwnerGeneration,
    ownerFingerprint: proposal.evaluatedOwnerFingerprint,
    cursorVectorFingerprint: proposal.evaluatedCursorVectorFingerprint,
    requestedCodexReservationTokens: proposal.requestedCodexReservationTokens,
    executesWork: false,
    authorizesWork: false,
    authorizesEffects: false,
    authorizesDispatch: false,
  });
  return Object.freeze({ prepared, receipt });
}

function normalizeProposal(
  input: LazyCampaignAcceptanceProposalV2,
): LazyCampaignAcceptanceProposalV2 {
  exactKeys(input, [
    "transitionId",
    "ownerRef",
    "evaluatedOwnerGeneration",
    "evaluatedOwnerFingerprint",
    "evaluatedCursorVectorFingerprint",
    "requestedCodexReservationTokens",
    "authorizesWork",
    "authorizesEffects",
    "authorizesDispatch",
  ]);
  if (
    input.authorizesWork !== false ||
    input.authorizesEffects !== false ||
    input.authorizesDispatch !== false
  ) {
    throw new RangeError("Lazy campaign proposal must grant no authority");
  }
  return Object.freeze({
    transitionId: sha256(input.transitionId, "transition ID"),
    ownerRef: opaque(input.ownerRef, "owner reference"),
    evaluatedOwnerGeneration: positiveInteger(
      input.evaluatedOwnerGeneration,
      "owner generation",
    ),
    evaluatedOwnerFingerprint: sha256(
      input.evaluatedOwnerFingerprint,
      "owner fingerprint",
    ),
    evaluatedCursorVectorFingerprint: sha256(
      input.evaluatedCursorVectorFingerprint,
      "cursor-vector fingerprint",
    ),
    requestedCodexReservationTokens: nonNegativeInteger(
      input.requestedCodexReservationTokens,
      "Codex reservation",
    ),
    authorizesWork: false,
    authorizesEffects: false,
    authorizesDispatch: false,
  });
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new RangeError("Lazy campaign proposal has unexpected fields");
  }
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new RangeError(`Lazy campaign ${label} is invalid`);
  }
  return value;
}

function opaque(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_PATTERN.test(value)) {
    throw new RangeError(`Lazy campaign ${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(`Lazy campaign ${label} is invalid`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RangeError(`Lazy campaign ${label} is invalid`);
  }
  return Number(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
