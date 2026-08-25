import { describe, expect, test } from 'bun:test';
import {
  compareJudgmentProvenance,
  computeDigest,
  validateJudgmentProvenance,
} from '../src/independence-provenance.js';

describe('Judgment provenance comparison', () => {
  const authorDigest = computeDigest('system prompt v1 for implementer');
  const reviewDigest = computeDigest('system prompt v2 for independent reviewer');
  const contextDigest = computeDigest('diff and test suite output');

  const geminiAuthorInput = {
    actorId: 'gemini-worker-1',
    runId: 'run_101',
    modelProvider: 'google',
    modelFamily: 'gemini-2.5-pro',
    modelIdentity: 'gemini-2.5-pro-002',
    harness: 'antigravity',
    instructionDigest: authorDigest,
    contextPacketDigest: contextDigest,
    priorJudgmentExposure: 'none',
    parentRecommendationId: 'recommendation_101',
    recordedAt: '2026-08-25T00:00:00.000Z',
  } as const;

  const geminiAuthor = validateJudgmentProvenance(geminiAuthorInput);

  test('round-trips raw provenance without adding an authority decision', () => {
    expect(geminiAuthor).toEqual(geminiAuthorInput);
  });

  test('reports provider equality and difference as descriptive facts', () => {
    const claudeReviewer = validateJudgmentProvenance({
      actorId: 'claude-reviewer-1',
      runId: 'run_102',
      modelProvider: 'anthropic',
      modelFamily: 'claude-3-7-sonnet',
      modelIdentity: 'claude-3-7-sonnet-20250219',
      harness: 'claude-code',
      instructionDigest: reviewDigest,
      contextPacketDigest: contextDigest,
      priorJudgmentExposure: 'sealed',
    });

    const differentProvider = compareJudgmentProvenance(geminiAuthor, claudeReviewer);
    expect(differentProvider).toEqual({
      modelProvider: 'different',
      modelFamily: 'different',
      modelIdentity: 'different',
      harness: 'different',
      instructionLineage: 'different',
      contextPacket: 'same',
      priorJudgmentExposure: 'sealed',
    });

    const sameProviderReviewer = validateJudgmentProvenance({
      actorId: 'google-reviewer-1',
      modelProvider: 'google',
      modelFamily: 'gemini-2.0-flash',
      modelIdentity: 'gemini-2.0-flash-001',
      harness: 'review-harness',
      instructionDigest: reviewDigest,
      contextPacketDigest: contextDigest,
      priorJudgmentExposure: 'none',
    });

    expect(compareJudgmentProvenance(geminiAuthor, sameProviderReviewer).modelProvider).toBe('same');
  });

  test('reports shared provenance and prior-judgment exposure without a verdict', () => {
    const geminiClone = validateJudgmentProvenance({
      actorId: 'gemini-worker-2',
      runId: 'run_103',
      modelProvider: 'google',
      modelFamily: 'gemini-2.5-pro',
      modelIdentity: 'gemini-2.5-pro-002',
      harness: 'antigravity',
      instructionDigest: authorDigest,
      contextPacketDigest: contextDigest,
      priorJudgmentExposure: 'full',
    });

    expect(compareJudgmentProvenance(geminiAuthor, geminiClone)).toEqual({
      modelProvider: 'same',
      modelFamily: 'same',
      modelIdentity: 'same',
      harness: 'same',
      instructionLineage: 'same',
      contextPacket: 'same',
      priorJudgmentExposure: 'full',
    });
  });

  test('rejects malformed digests and invalid inputs', () => {
    expect(() => validateJudgmentProvenance({})).toThrow('actorId is required');
    expect(() => validateJudgmentProvenance({
      actorId: 'worker',
      modelFamily: 'gemini',
      modelIdentity: 'gemini-pro',
      harness: 'cli',
      instructionDigest: 'invalid-digest',
      contextPacketDigest: contextDigest,
    })).toThrow('instructionDigest must be a valid sha256:64hex digest');
  });
});
