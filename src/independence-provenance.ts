/**
 * Independence Provenance and Correlated Cognition Fencing
 *
 * Implements #1613: records whether multiple agent reviews or decisions
 * are meaningfully independent, or whether they share correlated cognition
 * (same model family, shared instruction lineage, or unsealed prior judgment exposure).
 */

import { createHash } from 'node:crypto';

export type ModelProvider = 'anthropic' | 'google' | 'openai' | 'deepseek' | 'meta' | 'other';
export type PriorJudgmentExposure = 'sealed' | 'none' | 'partial' | 'full';

export interface JudgmentProvenance {
  readonly actorId: string;
  readonly runId?: string;
  readonly modelProvider: ModelProvider;
  readonly modelFamily: string;
  readonly modelIdentity: string;
  readonly harness: string;
  readonly instructionDigest: string;
  readonly contextPacketDigest: string;
  readonly priorJudgmentExposure: PriorJudgmentExposure;
  readonly parentRecommendationId?: string;
  readonly recordedAt: string;
}

export interface IndependenceAssessment {
  readonly isIndependent: boolean;
  readonly separationScore: number; // 0.0 to 1.0
  readonly sharedFactors: readonly string[];
  readonly riskTier: 'low' | 'moderate' | 'high_correlation';
  readonly warning?: string;
}

export function computeDigest(content: string | object): string {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

export function validateJudgmentProvenance(input: unknown): JudgmentProvenance {
  if (!isRecord(input)) {
    throw new TypeError('Judgment provenance must be an object.');
  }

  const actorId = requiredString(input.actorId, 'actorId is required', 120);
  const modelProvider = validateProvider(input.modelProvider);
  const modelFamily = requiredString(input.modelFamily, 'modelFamily is required', 80);
  const modelIdentity = requiredString(input.modelIdentity, 'modelIdentity is required', 120);
  const harness = requiredString(input.harness, 'harness is required', 80);
  const instructionDigest = validateDigest(input.instructionDigest, 'instructionDigest');
  const contextPacketDigest = validateDigest(input.contextPacketDigest, 'contextPacketDigest');
  const priorJudgmentExposure = validateExposure(input.priorJudgmentExposure);
  const recordedAt = typeof input.recordedAt === 'string' && !isNaN(Date.parse(input.recordedAt))
    ? input.recordedAt
    : new Date().toISOString();

  const runId = typeof input.runId === 'string' && input.runId.trim()
    ? input.runId.trim()
    : undefined;
  const parentRecommendationId = typeof input.parentRecommendationId === 'string' && input.parentRecommendationId.trim()
    ? input.parentRecommendationId.trim()
    : undefined;

  return {
    actorId,
    ...(runId ? { runId } : {}),
    modelProvider,
    modelFamily: modelFamily.toLowerCase(),
    modelIdentity,
    harness: harness.toLowerCase(),
    instructionDigest,
    contextPacketDigest,
    priorJudgmentExposure,
    ...(parentRecommendationId ? { parentRecommendationId } : {}),
    recordedAt,
  };
}

export function assessJudgmentIndependence(
  primary: JudgmentProvenance,
  reviewer: JudgmentProvenance,
): IndependenceAssessment {
  const sharedFactors: string[] = [];

  if (primary.modelProvider === reviewer.modelProvider) {
    sharedFactors.push('same_model_provider');
  }

  if (primary.modelFamily.toLowerCase() === reviewer.modelFamily.toLowerCase()) {
    sharedFactors.push('same_model_family');
  }

  if (primary.harness.toLowerCase() === reviewer.harness.toLowerCase()) {
    sharedFactors.push('same_harness');
  }

  if (primary.instructionDigest === reviewer.instructionDigest) {
    sharedFactors.push('identical_instruction_lineage');
  }

  if (reviewer.priorJudgmentExposure === 'full') {
    sharedFactors.push('unsealed_full_prior_exposure');
  } else if (reviewer.priorJudgmentExposure === 'partial') {
    sharedFactors.push('unsealed_partial_prior_exposure');
  }

  let penalty = 0;
  if (sharedFactors.includes('same_model_family')) penalty += 0.45;
  if (sharedFactors.includes('same_model_provider')) penalty += 0.15;
  if (sharedFactors.includes('same_harness')) penalty += 0.1;
  if (sharedFactors.includes('identical_instruction_lineage')) penalty += 0.15;
  if (sharedFactors.includes('unsealed_full_prior_exposure')) penalty += 0.25;
  if (sharedFactors.includes('unsealed_partial_prior_exposure')) penalty += 0.1;

  const separationScore = Math.max(0, Math.min(1, 1.0 - penalty));
  const isIndependent = separationScore >= 0.5 && !sharedFactors.includes('unsealed_full_prior_exposure');

  let riskTier: 'low' | 'moderate' | 'high_correlation' = 'low';
  let warning: string | undefined;

  if (separationScore < 0.35) {
    riskTier = 'high_correlation';
    warning = 'High correlated cognition risk: Reviewer shares model family, prompt lineage, and prior verdict exposure with the author.';
  } else if (separationScore < 0.65) {
    riskTier = 'moderate';
    warning = 'Moderate correlation: Reviewer shares underlying model provider or harness.';
  }

  return {
    isIndependent,
    separationScore: Math.round(separationScore * 100) / 100,
    sharedFactors,
    riskTier,
    ...(warning ? { warning } : {}),
  };
}

function validateProvider(value: unknown): ModelProvider {
  const allowed: ModelProvider[] = ['anthropic', 'google', 'openai', 'deepseek', 'meta', 'other'];
  if (typeof value === 'string' && allowed.includes(value.toLowerCase() as ModelProvider)) {
    return value.toLowerCase() as ModelProvider;
  }
  return 'other';
}

function validateExposure(value: unknown): PriorJudgmentExposure {
  const allowed: PriorJudgmentExposure[] = ['sealed', 'none', 'partial', 'full'];
  if (typeof value === 'string' && allowed.includes(value.toLowerCase() as PriorJudgmentExposure)) {
    return value.toLowerCase() as PriorJudgmentExposure;
  }
  return 'none';
}

function validateDigest(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.trim())) {
    throw new TypeError(`${fieldName} must be a valid sha256:64hex digest.`);
  }
  return value.trim();
}

function requiredString(value: unknown, message: string, maxLength: number): string {
  const str = typeof value === 'string' ? value.trim() : '';
  if (!str) throw new TypeError(message);
  if (str.length > maxLength) throw new TypeError(`${message} (maximum ${maxLength} characters).`);
  return str;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
