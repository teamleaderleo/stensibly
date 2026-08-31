import { describe, expect, test } from "bun:test";
import {
  compareExecutionRecipeRevisions,
  compileExecutionRecipe,
  exampleExecutionRecipes,
  instantiateExecutionRecipe,
  type ExecutionRecipe,
} from "../src/execution-recipe.ts";

const repository = "teamleaderleo/stensibly";
const baseRevision = "a".repeat(40);

describe("reusable execution recipes", () => {
  test("compiles a deterministic deeply frozen recipe", () => {
    const input = recipe();
    const originalCapabilities = [...input.requiredCapabilities];
    const compiled = compileExecutionRecipe(input);
    const reordered = compileExecutionRecipe({
      ...recipe(),
      acceptedProjectProfiles: ["sandbox", "repository-maintenance"],
      requiredCapabilities: ["repository.read", "branch.candidate_write"],
      checks: ["typecheck", "focused-tests"],
      stopConditions: ["verification_failed", "base_changed"],
      approvalPredicates: ["integration_requires_review"],
      allowedArtifacts: ["verification_receipt", "branch"],
    });

    expect(compiled.requiredCapabilities).toEqual([
      "branch.candidate_write",
      "repository.read",
    ]);
    expect(input.requiredCapabilities).toEqual(originalCapabilities);
    expect(compiled).toEqual(reordered);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.orderedPhases)).toBe(true);
    expect(Object.isFrozen(compiled.orderedPhases[0])).toBe(true);
    expect(Object.isFrozen(compiled.budgetEnvelope)).toBe(true);
  });

  test("instantiates an exact non-authorizing plan", () => {
    const plan = instantiateExecutionRecipe({
      recipe: recipe(),
      project: "alpha",
      projectProfile: "repository-maintenance",
      repository,
      baseRevision,
      workGeneration: 7,
      policyRevision: "policy:7",
      runnerProfile: "runner:codex",
      authorityGeneration: 11,
      parameters: {
        retryFailedChecks: true,
        sourcePacketId: "packet:42",
      },
    });

    expect(plan).toMatchObject({
      recipeId: "current-main-source-replay",
      recipeVersion: "1.0.0",
      project: "alpha",
      projectProfile: "repository-maintenance",
      repository,
      baseRevision,
      workGeneration: 7,
      authorityGeneration: 11,
      parameters: {
        retryFailedChecks: true,
        sourcePacketId: "packet:42",
      },
      executesWork: false,
      authorizesMutation: false,
      authorizesAuthority: false,
    });
    expect(plan.recipeFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.planFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.parameters)).toBe(true);
  });

  test("material input changes produce a different plan fingerprint", () => {
    const input = instantiation();
    const first = instantiateExecutionRecipe(input);
    const changedBase = instantiateExecutionRecipe({
      ...instantiation(),
      baseRevision: "b".repeat(40),
    });
    const changedPolicy = instantiateExecutionRecipe({
      ...instantiation(),
      policyRevision: "policy:8",
    });
    const changedParameter = instantiateExecutionRecipe({
      ...instantiation(),
      parameters: {
        retryFailedChecks: false,
        sourcePacketId: "packet:42",
      },
    });

    expect(new Set([
      first.planFingerprint,
      changedBase.planFingerprint,
      changedPolicy.planFingerprint,
      changedParameter.planFingerprint,
    ]).size).toBe(4);
  });

  test("accepts explicit null for an optional parameter and omits it from the plan", () => {
    const plan = instantiateExecutionRecipe({
      ...instantiation(),
      parameters: {
        retryFailedChecks: null,
        sourcePacketId: "packet:42",
      },
    } as unknown as ReturnType<typeof instantiation>);

    expect(plan.parameters).toEqual({ sourcePacketId: "packet:42" });
  });

  test("rejects profile mismatch and malformed parameter sets", () => {
    expect(() => instantiateExecutionRecipe({
      ...instantiation(),
      projectProfile: "foreign-profile",
    })).toThrow("does not accept the project profile");

    expect(() => instantiateExecutionRecipe({
      ...instantiation(),
      parameters: { sourcePacketId: "packet:42" },
    } as unknown as ReturnType<typeof instantiation>)).toThrow(
      "Execution recipe parameters has an invalid field set",
    );

    expect(() => instantiateExecutionRecipe({
      ...instantiation(),
      parameters: {
        extra: true,
        retryFailedChecks: true,
        sourcePacketId: "packet:42",
      },
    } as unknown as ReturnType<typeof instantiation>)).toThrow(
      "Execution recipe parameters has an invalid field set",
    );
  });

  test("classifies a description-only revision as compatible", () => {
    const comparison = compareExecutionRecipeRevisions(
      recipe(),
      {
        ...recipe(),
        version: "1.0.1",
        description: "Clarify the same admitted replay procedure.",
      },
    );

    expect(comparison.classification).toBe("compatible");
    expect(comparison.widened).toEqual([]);
    expect(comparison.narrowed).toEqual([]);
    expect(comparison.incompatible).toEqual([]);
    expect(comparison.authorizesActivation).toBe(false);
  });

  test("classifies capability, artifact, budget, and approval widening", () => {
    const candidate = recipe();
    candidate.version = "1.1.0";
    candidate.requiredCapabilities.push("repository.default_branch_write");
    candidate.allowedArtifacts.push("release_candidate");
    candidate.approvalPredicates = [];
    candidate.budgetEnvelope.maxSteps += 10;

    const comparison = compareExecutionRecipeRevisions(recipe(), candidate);

    expect(comparison.classification).toBe("widened");
    expect(comparison.widened).toContain(
      "capability_added:repository.default_branch_write",
    );
    expect(comparison.widened).toContain("artifact_added:release_candidate");
    expect(comparison.widened).toContain(
      "approval_predicate_removed:integration_requires_review",
    );
    expect(comparison.widened).toContain("budget_increased:steps");
  });

  test("classifies added checks, approvals, stop conditions, and tighter budgets as narrowing", () => {
    const candidate = recipe();
    candidate.version = "1.1.0";
    candidate.checks.push("runtime-parity");
    candidate.approvalPredicates.push("publication_requires_review");
    candidate.stopConditions.push("source_drift");
    candidate.budgetEnvelope.maxWallMinutes -= 10;

    const comparison = compareExecutionRecipeRevisions(recipe(), candidate);

    expect(comparison.classification).toBe("narrowed");
    expect(comparison.narrowed).toContain("check_added:runtime-parity");
    expect(comparison.narrowed).toContain(
      "approval_predicate_added:publication_requires_review",
    );
    expect(comparison.narrowed).toContain("stop_condition_added:source_drift");
    expect(comparison.narrowed).toContain("budget_decreased:wall_minutes");
  });

  test("classifies simultaneous widening and narrowing as mixed", () => {
    const candidate = recipe();
    candidate.version = "1.1.0";
    candidate.requiredCapabilities.push("repository.default_branch_write");
    candidate.stopConditions.push("source_drift");

    const comparison = compareExecutionRecipeRevisions(recipe(), candidate);

    expect(comparison.classification).toBe("mixed");
    expect(comparison.widened.length).toBeGreaterThan(0);
    expect(comparison.narrowed.length).toBeGreaterThan(0);
  });

  test("classifies parameter, phase-order, recovery, and stale-version changes as incompatible", () => {
    const candidate = recipe();
    candidate.parameterSchema[0]!.maximum = 120;
    candidate.orderedPhases.reverse();
    candidate.recoveryPolicy = "abort";

    const comparison = compareExecutionRecipeRevisions(recipe(), candidate);

    expect(comparison.classification).toBe("incompatible");
    expect(comparison.incompatible).toContain("candidate_version_must_advance");
    expect(comparison.incompatible).toContain("parameter_schema_changed");
    expect(comparison.incompatible).toContain("phase_sequence_changed");
    expect(comparison.incompatible).toContain("recovery_policy_changed");
  });

  test("returns three distinct fictional network-free examples", () => {
    const examples = exampleExecutionRecipes();

    expect(examples.map((entry) => entry.recipeId)).toEqual([
      "current-main-source-replay",
      "bounded-adapter-conformance",
      "operational-document-refresh",
    ]);
    expect(new Set(examples.map((entry) => entry.outcomeClass)).size).toBe(3);
    for (const entry of examples) {
      expect(entry.budgetEnvelope.maxCostMicros).toBe(0);
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  test("rejects credential retention, undeclared phase references, and unbounded versions", () => {
    expect(() => compileExecutionRecipe({
      ...recipe(),
      description: "authorization: Bearer hidden",
    })).toThrow("contains credential-shaped text");

    const undeclared = recipe();
    undeclared.orderedPhases[0]!.requiredChecks = ["missing-check"];
    expect(() => compileExecutionRecipe(undeclared)).toThrow(
      "references an undeclared check",
    );

    expect(() => compileExecutionRecipe({
      ...recipe(),
      version: "999999999999999999999.0.0",
    })).toThrow("version segments are out of range");
  });
});

function recipe(): ExecutionRecipe {
  return {
    recipeId: "current-main-source-replay",
    version: "1.0.0",
    outcomeClass: "source_replay",
    description: "Replay one reviewed source packet onto an exact current base.",
    parameterSchema: [
      {
        name: "sourcePacketId",
        kind: "string",
        required: true,
        minimum: 1,
        maximum: 240,
        allowedValues: [],
      },
      {
        name: "retryFailedChecks",
        kind: "boolean",
        required: false,
        minimum: null,
        maximum: null,
        allowedValues: [],
      },
    ],
    acceptedProjectProfiles: ["sandbox", "repository-maintenance"],
    requiredCapabilities: ["repository.read", "branch.candidate_write"],
    requiredInputs: ["sourcePacketId"],
    orderedPhases: [
      {
        id: "inspect",
        title: "Inspect exact packet",
        kind: "inspect",
        requiredCapabilities: ["repository.read"],
        requiredChecks: [],
        checkpoint: true,
      },
      {
        id: "replay",
        title: "Replay onto exact base",
        kind: "implement",
        requiredCapabilities: ["branch.candidate_write"],
        requiredChecks: [],
        checkpoint: true,
      },
      {
        id: "verify",
        title: "Verify the replay",
        kind: "verify",
        requiredCapabilities: [],
        requiredChecks: ["focused-tests", "typecheck"],
        checkpoint: true,
      },
    ],
    checks: ["focused-tests", "typecheck"],
    checkpointPolicy: "phase",
    stopConditions: ["base_changed", "verification_failed"],
    approvalPredicates: ["integration_requires_review"],
    budgetEnvelope: {
      maxWallMinutes: 90,
      maxSteps: 24,
      maxCostMicros: 0,
    },
    allowedArtifacts: ["branch", "verification_receipt"],
    continuationPolicy: "compatible_runner",
    recoveryPolicy: "resume_checkpoint",
  };
}

function instantiation() {
  return {
    recipe: recipe(),
    project: "alpha",
    projectProfile: "repository-maintenance",
    repository,
    baseRevision,
    workGeneration: 7,
    policyRevision: "policy:7",
    runnerProfile: "runner:codex",
    authorityGeneration: 11,
    parameters: {
      retryFailedChecks: true,
      sourcePacketId: "packet:42",
    },
  };
}
