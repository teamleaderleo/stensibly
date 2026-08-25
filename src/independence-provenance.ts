/**
 * Judgment provenance and descriptive comparisons.
 *
 * Provenance records retain the facts needed to understand how a judgment was
 * produced. Comparisons report whether those facts match; they do not decide
 * whether a review is acceptable or independent.
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

export type ProvenanceComparison = 'same' | 'different';

export interface JudgmentProvenanceComparison {
  readonly modelProvider: ProvenanceComparison;
  readonly modelFamily: ProvenanceComparison;
  readonly modelIdentity: ProvenanceComparison;
  readonly harness: ProvenanceComparison;
  readonly instructionLineage: ProvenanceComparison;
  readonly contextPacket: ProvenanceComparison;
  readonly priorJudgmentExposure: PriorJudgmentExposure;
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

export function compareJudgmentProvenance(
  primary: JudgmentProvenance,
  reviewer: JudgmentProvenance,
): JudgmentProvenanceComparison {
  return {
    modelProvider: compareFact(primary.modelProvider, reviewer.modelProvider),
    modelFamily: compareNormalizedFact(primary.modelFamily, reviewer.modelFamily),
    modelIdentity: compareFact(primary.modelIdentity, reviewer.modelIdentity),
    harness: compareNormalizedFact(primary.harness, reviewer.harness),
    instructionLineage: compareFact(primary.instructionDigest, reviewer.instructionDigest),
    contextPacket: compareFact(primary.contextPacketDigest, reviewer.contextPacketDigest),
    priorJudgmentExposure: reviewer.priorJudgmentExposure,
  };
}

function compareFact(primary: string, reviewer: string): ProvenanceComparison {
  return primary === reviewer ? 'same' : 'different';
}

function compareNormalizedFact(primary: string, reviewer: string): ProvenanceComparison {
  return primary.toLowerCase() === reviewer.toLowerCase() ? 'same' : 'different';
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
