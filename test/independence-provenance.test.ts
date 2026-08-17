import { describe, expect, test } from 'bun:test';
import {
  assessJudgmentIndependence,
  computeDigest,
  validateJudgmentProvenance,
} from '../src/independence-provenance.js';

describe('Independence Provenance & Correlated Cognition', () => {
  const authorDigest = computeDigest('system prompt v1 for implementer');
  const reviewDigest = computeDigest('system prompt v2 for independent reviewer');
  const contextDigest = computeDigest('diff and test suite output');

  const geminiAuthor = validateJudgmentProvenance({
    actorId: 'gemini-worker-1',
    runId: 'run_101',
    modelProvider: 'google',
    modelFamily: 'gemini-2.5-pro',
    modelIdentity: 'gemini-2.5-pro-002',
    harness: 'antigravity',
    instructionDigest: authorDigest,
    contextPacketDigest: contextDigest,
    priorJudgmentExposure: 'none',
  });

  test('validates valid judgment provenance contract', () => {
    expect(geminiAuthor.modelProvider).toBe('google');
    expect(geminiAuthor.modelFamily).toBe('gemini-2.5-pro');
    expect(geminiAuthor.priorJudgmentExposure).toBe('none');
    expect(geminiAuthor.instructionDigest).toBe(authorDigest);
  });

  test('detects high independence between distinct model families (Google Gemini + Anthropic Claude)', () => {
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

    const assessment = assessJudgmentIndependence(geminiAuthor, claudeReviewer);
    expect(assessment.isIndependent).toBe(true);
    expect(assessment.separationScore).toBeGreaterThanOrEqual(0.85);
    expect(assessment.riskTier).toBe('low');
    expect(assessment.sharedFactors).toEqual([]);
  });

  test('flags correlated cognition risk when same model family reviews with unsealed prior verdict exposure', () => {
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

    const assessment = assessJudgmentIndependence(geminiAuthor, geminiClone);
    expect(assessment.isIndependent).toBe(false);
    expect(assessment.separationScore).toBeLessThan(0.35);
    expect(assessment.riskTier).toBe('high_correlation');
    expect(assessment.sharedFactors).toContain('same_model_family');
    expect(assessment.sharedFactors).toContain('same_model_provider');
    expect(assessment.sharedFactors).toContain('same_harness');
    expect(assessment.sharedFactors).toContain('identical_instruction_lineage');
    expect(assessment.sharedFactors).toContain('unsealed_full_prior_exposure');
    expect(assessment.warning).toContain('High correlated cognition risk');
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
