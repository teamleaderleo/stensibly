import { describe, expect, test } from "bun:test";
import {
  compileExecutionRecipe,
  exampleExecutionRecipes,
  instantiateExecutionRecipe,
  type ExecutionRecipe,
  type InstantiateExecutionRecipeInput,
} from "../src/execution-recipe.ts";

describe("execution recipe caller-graph inspection", () => {
  test("compiles a valid recipe without caller ownKeys", () => {
    const recipe = structuredClone(exampleExecutionRecipes()[0]!) as ExecutionRecipe;
    let ownKeysCalls = 0;
    const hostile = new Proxy(recipe, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must remain unreachable");
      },
    });

    expect(() => compileExecutionRecipe(hostile)).not.toThrow();
    expect(ownKeysCalls).toBe(0);
  });

  test("instantiates a valid request without caller ownKeys", () => {
    const recipe = structuredClone(exampleExecutionRecipes()[0]!) as ExecutionRecipe;
    const input: InstantiateExecutionRecipeInput = {
      recipe,
      project: "stensibly",
      projectProfile: "repository-maintenance",
      repository: "teamleaderleo/stensibly",
      baseRevision: "a".repeat(40),
      workGeneration: 1,
      policyRevision: "policy:1",
      runnerProfile: "runner:1",
      authorityGeneration: 1,
      parameters: { sourcePacketId: "packet:1" },
    };
    let ownKeysCalls = 0;
    const hostile = new Proxy(input, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must remain unreachable");
      },
    });

    expect(() => instantiateExecutionRecipe(hostile)).not.toThrow();
    expect(ownKeysCalls).toBe(0);
  });
});
