import { expect, test } from "bun:test";
import {
  compileExecutionRecipe,
  instantiateExecutionRecipe,
  type ExecutionRecipe,
  type InstantiateExecutionRecipeInput,
} from "../src/execution-recipe.ts";

test("recipe compilation normalizes hostile caller inspection traps", () => {
  const hostile = new Proxy(Object.create(Object.prototype), {
    ownKeys() {
      throw new Error("private caller prose");
    },
  });

  expect(() => compileExecutionRecipe(
    hostile as unknown as ExecutionRecipe,
  )).toThrow("Execution recipe input inspection failed");
});

test("recipe compilation rejects nested accessors without invoking them", () => {
  let getterCalls = 0;
  const input = recipe() as unknown as Record<string, unknown>;
  Object.defineProperty(input, "description", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "hidden";
    },
  });

  expect(() => compileExecutionRecipe(
    input as unknown as ExecutionRecipe,
  )).toThrow("Execution recipe input inspection failed");
  expect(getterCalls).toBe(0);
});

test("instantiation is detached from later caller mutation", () => {
  const input = instantiation();
  const plan = instantiateExecutionRecipe(input);

  input.parameters.sourcePacketId = "packet:changed";
  input.recipe.orderedPhases[0]!.title = "Changed after admission";
  input.recipe.requiredCapabilities.push("repository.default_branch_write");

  expect(plan.parameters.sourcePacketId).toBe("packet:42");
  expect(plan.orderedPhases[0]?.title).toBe("Inspect exact packet");
  expect(plan.requiredCapabilities).toEqual([
    "branch.candidate_write",
    "repository.read",
  ]);
});

test("string parameters reject negative or oversized text bounds", () => {
  const negative = recipe();
  negative.parameterSchema[0]!.minimum = -1;
  expect(() => compileExecutionRecipe(negative)).toThrow(
    "string bounds are invalid",
  );

  const oversized = recipe();
  oversized.parameterSchema[0]!.maximum = 501;
  expect(() => compileExecutionRecipe(oversized)).toThrow(
    "string bounds are invalid",
  );
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
    ],
    acceptedProjectProfiles: ["repository-maintenance"],
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
    ],
    checks: [],
    checkpointPolicy: "phase",
    stopConditions: ["base_changed"],
    approvalPredicates: ["integration_requires_review"],
    budgetEnvelope: {
      maxWallMinutes: 90,
      maxSteps: 24,
      maxCostMicros: 0,
    },
    allowedArtifacts: ["branch"],
    continuationPolicy: "compatible_runner",
    recoveryPolicy: "resume_checkpoint",
  };
}

function instantiation(): InstantiateExecutionRecipeInput {
  return {
    recipe: recipe(),
    project: "alpha",
    projectProfile: "repository-maintenance",
    repository: "teamleaderleo/stensibly",
    baseRevision: "a".repeat(40),
    workGeneration: 7,
    policyRevision: "policy:7",
    runnerProfile: "runner:codex",
    authorityGeneration: 11,
    parameters: {
      sourcePacketId: "packet:42",
    },
  };
}
