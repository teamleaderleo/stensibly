import { sha256, stableJson } from "./canonical-json.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import {
  assertCanonicalJsonByteBudget,
  boundedIdentity,
  boundedInteger,
  boundedText,
  compareCodeUnits,
  denseDataArray,
  enumValue,
  lowercaseSlug,
  requirePlainObject,
  requireUnique,
} from "./work-stack-projection-validation.js";

export const executionRecipeParameterKinds = Object.freeze([
  "string",
  "integer",
  "boolean",
] as const);
export const executionRecipePhaseKinds = Object.freeze([
  "inspect",
  "implement",
  "verify",
  "review",
  "publish",
] as const);
export const executionRecipeCheckpointPolicies = Object.freeze([
  "none",
  "manual",
  "phase",
] as const);
export const executionRecipeContinuationPolicies = Object.freeze([
  "same_recipe_revision",
  "compatible_runner",
] as const);
export const executionRecipeRecoveryPolicies = Object.freeze([
  "resume_checkpoint",
  "restart_phase",
  "abort",
] as const);
export const executionRecipeComparisonClasses = Object.freeze([
  "identical",
  "compatible",
  "widened",
  "narrowed",
  "mixed",
  "incompatible",
] as const);

export type ExecutionRecipeParameterKind =
  typeof executionRecipeParameterKinds[number];
export type ExecutionRecipePhaseKind = typeof executionRecipePhaseKinds[number];
export type ExecutionRecipeCheckpointPolicy =
  typeof executionRecipeCheckpointPolicies[number];
export type ExecutionRecipeContinuationPolicy =
  typeof executionRecipeContinuationPolicies[number];
export type ExecutionRecipeRecoveryPolicy =
  typeof executionRecipeRecoveryPolicies[number];
export type ExecutionRecipeComparisonClass =
  typeof executionRecipeComparisonClasses[number];

export interface ExecutionRecipeParameter {
  name: string;
  kind: ExecutionRecipeParameterKind;
  required: boolean;
  minimum: number | null;
  maximum: number | null;
  allowedValues: string[];
}

export interface ExecutionRecipePhase {
  id: string;
  title: string;
  kind: ExecutionRecipePhaseKind;
  requiredCapabilities: string[];
  requiredChecks: string[];
  checkpoint: boolean;
}

export interface ExecutionRecipeBudgetEnvelope {
  maxWallMinutes: number;
  maxSteps: number;
  maxCostMicros: number;
}

export interface ExecutionRecipe {
  recipeId: string;
  version: string;
  outcomeClass: string;
  description: string;
  parameterSchema: ExecutionRecipeParameter[];
  acceptedProjectProfiles: string[];
  requiredCapabilities: string[];
  requiredInputs: string[];
  orderedPhases: ExecutionRecipePhase[];
  checks: string[];
  checkpointPolicy: ExecutionRecipeCheckpointPolicy;
  stopConditions: string[];
  approvalPredicates: string[];
  budgetEnvelope: ExecutionRecipeBudgetEnvelope;
  allowedArtifacts: string[];
  continuationPolicy: ExecutionRecipeContinuationPolicy;
  recoveryPolicy: ExecutionRecipeRecoveryPolicy;
}

export interface InstantiateExecutionRecipeInput {
  recipe: ExecutionRecipe;
  project: string;
  projectProfile: string;
  repository: string;
  baseRevision: string;
  workGeneration: number;
  policyRevision: string;
  runnerProfile: string;
  authorityGeneration: number;
  parameters: Record<string, unknown>;
}

export interface InstantiatedExecutionRecipePlan {
  recipeId: string;
  recipeVersion: string;
  recipeFingerprint: string;
  project: string;
  projectProfile: string;
  repository: string;
  baseRevision: string;
  workGeneration: number;
  policyRevision: string;
  runnerProfile: string;
  authorityGeneration: number;
  parameters: Readonly<Record<string, string | number | boolean>>;
  requiredCapabilities: readonly string[];
  orderedPhases: readonly Readonly<ExecutionRecipePhase>[];
  checks: readonly string[];
  checkpointPolicy: ExecutionRecipeCheckpointPolicy;
  stopConditions: readonly string[];
  approvalPredicates: readonly string[];
  budgetEnvelope: Readonly<ExecutionRecipeBudgetEnvelope>;
  allowedArtifacts: readonly string[];
  continuationPolicy: ExecutionRecipeContinuationPolicy;
  recoveryPolicy: ExecutionRecipeRecoveryPolicy;
  executesWork: false;
  authorizesMutation: false;
  authorizesAuthority: false;
  planFingerprint: string;
}

export interface ExecutionRecipeRevisionComparison {
  recipeId: string;
  currentVersion: string;
  candidateVersion: string;
  currentFingerprint: string;
  candidateFingerprint: string;
  classification: ExecutionRecipeComparisonClass;
  widened: readonly string[];
  narrowed: readonly string[];
  incompatible: readonly string[];
  authorizesActivation: false;
  comparisonFingerprint: string;
}

const parameterKindSet = new Set<ExecutionRecipeParameterKind>(
  executionRecipeParameterKinds,
);
const phaseKindSet = new Set<ExecutionRecipePhaseKind>(
  executionRecipePhaseKinds,
);
const checkpointPolicySet = new Set<ExecutionRecipeCheckpointPolicy>(
  executionRecipeCheckpointPolicies,
);
const continuationPolicySet = new Set<ExecutionRecipeContinuationPolicy>(
  executionRecipeContinuationPolicies,
);
const recoveryPolicySet = new Set<ExecutionRecipeRecoveryPolicy>(
  executionRecipeRecoveryPolicies,
);
const maximumInputObjects = 20_000;
const maximumArrayLength = 256;
const maximumRecipeBytes = 256 * 1024;
const maximumPlanBytes = 256 * 1024;
const maximumComparisonBytes = 128 * 1024;
const maximumVersionSegment = 1_000_000;
const versionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const parameterNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function compileExecutionRecipe(value: ExecutionRecipe): Readonly<ExecutionRecipe> {
  const detached = detachInputGraph(value);
  const recipe = admitRecipe(detached);
  assertCanonicalJsonByteBudget(recipe, maximumRecipeBytes, "Execution recipe");
  assertRetainedCredentialFree(recipe, "Execution recipe");
  return freezeDeep(recipe);
}

export function instantiateExecutionRecipe(
  value: InstantiateExecutionRecipeInput,
): InstantiatedExecutionRecipePlan {
  const detached = detachInputGraph(value);
  requirePlainObject(
    detached,
    [
      "recipe",
      "project",
      "projectProfile",
      "repository",
      "baseRevision",
      "workGeneration",
      "policyRevision",
      "runnerProfile",
      "authorityGeneration",
      "parameters",
    ],
    "Execution recipe instantiation",
  );
  const recipe = admitRecipe(dataValue(detached, "recipe"));
  const project = lowercaseSlug(
    dataValue(detached, "project"),
    "Execution recipe project",
  );
  const projectProfile = boundedIdentity(
    dataValue(detached, "projectProfile"),
    "Execution recipe project profile",
  );
  if (!recipe.acceptedProjectProfiles.includes(projectProfile)) {
    throw new RangeError("Execution recipe does not accept the project profile");
  }
  const repository = normalizeGitHubRepository(
    boundedIdentity(
      dataValue(detached, "repository"),
      "Execution recipe repository",
    ),
  );
  const baseRevision = exactRevision(
    dataValue(detached, "baseRevision"),
    "Execution recipe base revision",
  );
  const parameters = admitParameters(
    dataValue(detached, "parameters"),
    recipe.parameterSchema,
  );
  const recipeFingerprint = sha256(stableJson(recipe));
  const unsigned = {
    recipeId: recipe.recipeId,
    recipeVersion: recipe.version,
    recipeFingerprint,
    project,
    projectProfile,
    repository,
    baseRevision,
    workGeneration: boundedInteger(
      dataValue(detached, "workGeneration"),
      1,
      Number.MAX_SAFE_INTEGER,
      "Execution recipe work generation",
    ),
    policyRevision: boundedIdentity(
      dataValue(detached, "policyRevision"),
      "Execution recipe policy revision",
    ),
    runnerProfile: boundedIdentity(
      dataValue(detached, "runnerProfile"),
      "Execution recipe runner profile",
    ),
    authorityGeneration: boundedInteger(
      dataValue(detached, "authorityGeneration"),
      1,
      Number.MAX_SAFE_INTEGER,
      "Execution recipe authority generation",
    ),
    parameters,
    requiredCapabilities: recipe.requiredCapabilities,
    orderedPhases: recipe.orderedPhases,
    checks: recipe.checks,
    checkpointPolicy: recipe.checkpointPolicy,
    stopConditions: recipe.stopConditions,
    approvalPredicates: recipe.approvalPredicates,
    budgetEnvelope: recipe.budgetEnvelope,
    allowedArtifacts: recipe.allowedArtifacts,
    continuationPolicy: recipe.continuationPolicy,
    recoveryPolicy: recipe.recoveryPolicy,
    executesWork: false as const,
    authorizesMutation: false as const,
    authorizesAuthority: false as const,
  };
  assertCanonicalJsonByteBudget(
    unsigned,
    maximumPlanBytes,
    "Execution recipe plan",
  );
  assertRetainedCredentialFree(unsigned, "Execution recipe plan");
  return freezeDeep({
    ...unsigned,
    planFingerprint: sha256(stableJson(unsigned)),
  }) as InstantiatedExecutionRecipePlan;
}

export function compareExecutionRecipeRevisions(
  currentValue: ExecutionRecipe,
  candidateValue: ExecutionRecipe,
): ExecutionRecipeRevisionComparison {
  const current = compileExecutionRecipe(currentValue);
  const candidate = compileExecutionRecipe(candidateValue);
  const currentFingerprint = sha256(stableJson(current));
  const candidateFingerprint = sha256(stableJson(candidate));
  if (current.recipeId !== candidate.recipeId) {
    throw new RangeError("Execution recipe comparison requires one recipe identity");
  }

  const widened: string[] = [];
  const narrowed: string[] = [];
  const incompatible: string[] = [];
  if (currentFingerprint !== candidateFingerprint) {
    if (compareVersions(candidate.version, current.version) <= 0) {
      incompatible.push("candidate_version_must_advance");
    }
    if (current.outcomeClass !== candidate.outcomeClass) {
      incompatible.push("outcome_class_changed");
    }
    if (stableJson(current.parameterSchema) !== stableJson(candidate.parameterSchema)) {
      incompatible.push("parameter_schema_changed");
    }
    if (stableJson(current.requiredInputs) !== stableJson(candidate.requiredInputs)) {
      incompatible.push("required_inputs_changed");
    }
    comparePhases(current, candidate, widened, narrowed, incompatible);
    compareSet(
      "project_profile",
      current.acceptedProjectProfiles,
      candidate.acceptedProjectProfiles,
      widened,
      narrowed,
    );
    compareSet(
      "capability",
      current.requiredCapabilities,
      candidate.requiredCapabilities,
      widened,
      narrowed,
    );
    compareSet("check", current.checks, candidate.checks, narrowed, widened);
    compareSet(
      "stop_condition",
      current.stopConditions,
      candidate.stopConditions,
      narrowed,
      widened,
    );
    compareSet(
      "approval_predicate",
      current.approvalPredicates,
      candidate.approvalPredicates,
      narrowed,
      widened,
    );
    compareSet(
      "artifact",
      current.allowedArtifacts,
      candidate.allowedArtifacts,
      widened,
      narrowed,
    );
    compareBudget(current.budgetEnvelope, candidate.budgetEnvelope, widened, narrowed);
    compareCheckpointPolicy(
      current.checkpointPolicy,
      candidate.checkpointPolicy,
      widened,
      narrowed,
    );
    if (current.continuationPolicy !== candidate.continuationPolicy) {
      incompatible.push("continuation_policy_changed");
    }
    if (current.recoveryPolicy !== candidate.recoveryPolicy) {
      incompatible.push("recovery_policy_changed");
    }
  }

  widened.sort(compareCodeUnits);
  narrowed.sort(compareCodeUnits);
  incompatible.sort(compareCodeUnits);
  const classification = classifyComparison(
    currentFingerprint,
    candidateFingerprint,
    widened,
    narrowed,
    incompatible,
  );
  const unsigned = {
    recipeId: current.recipeId,
    currentVersion: current.version,
    candidateVersion: candidate.version,
    currentFingerprint,
    candidateFingerprint,
    classification,
    widened,
    narrowed,
    incompatible,
    authorizesActivation: false as const,
  };
  assertCanonicalJsonByteBudget(
    unsigned,
    maximumComparisonBytes,
    "Execution recipe comparison",
  );
  return freezeDeep({
    ...unsigned,
    comparisonFingerprint: sha256(stableJson(unsigned)),
  }) as ExecutionRecipeRevisionComparison;
}

export function exampleExecutionRecipes(): readonly Readonly<ExecutionRecipe>[] {
  return freezeDeep([
    compileExecutionRecipe({
      recipeId: "current-main-source-replay",
      version: "1.0.0",
      outcomeClass: "source_replay",
      description: "Replay one reviewed source packet onto an exact current base and renew its evidence.",
      parameterSchema: [stringParameter("sourcePacketId")],
      acceptedProjectProfiles: ["repository-maintenance"],
      requiredCapabilities: ["repository.read", "branch.candidate_write"],
      requiredInputs: ["sourcePacketId"],
      orderedPhases: [
        phase("inspect", "Inspect exact source packet", "inspect", ["repository.read"], [], true),
        phase("replay", "Replay onto exact base", "implement", ["branch.candidate_write"], [], true),
        phase("verify", "Run declared checks", "verify", [], ["typecheck", "focused-tests", "canonical-ci"], true),
        phase("review", "Publish exact candidate for review", "review", [], ["canonical-ci"], false),
      ],
      checks: ["canonical-ci", "focused-tests", "typecheck"],
      checkpointPolicy: "phase",
      stopConditions: ["base_changed", "packet_mismatch", "verification_failed"],
      approvalPredicates: ["integration_requires_exact_head_review"],
      budgetEnvelope: { maxWallMinutes: 90, maxSteps: 24, maxCostMicros: 0 },
      allowedArtifacts: ["branch", "draft_pull_request", "verification_receipt"],
      continuationPolicy: "compatible_runner",
      recoveryPolicy: "resume_checkpoint",
    }),
    compileExecutionRecipe({
      recipeId: "bounded-adapter-conformance",
      version: "1.0.0",
      outcomeClass: "adapter_conformance",
      description: "Build a fixture-first adapter conformance packet with no live provider call.",
      parameterSchema: [
        stringParameter("adapterId"),
        stringParameter("scenarioId"),
      ],
      acceptedProjectProfiles: ["provider-lab"],
      requiredCapabilities: ["repository.read", "branch.candidate_write"],
      requiredInputs: ["adapterId", "scenarioId"],
      orderedPhases: [
        phase("contract", "Admit the adapter contract", "inspect", ["repository.read"], [], true),
        phase("fixture", "Add recorded fictional fixtures", "implement", ["branch.candidate_write"], [], true),
        phase("faults", "Exercise bounded fault cases", "verify", [], ["typecheck", "focused-tests"], true),
        phase("review", "Review conformance evidence", "review", [], ["focused-tests"], false),
      ],
      checks: ["focused-tests", "typecheck"],
      checkpointPolicy: "phase",
      stopConditions: ["credential_required", "network_required", "contract_ambiguity"],
      approvalPredicates: ["live_provider_use_requires_separate_authority"],
      budgetEnvelope: { maxWallMinutes: 120, maxSteps: 32, maxCostMicros: 0 },
      allowedArtifacts: ["branch", "draft_pull_request", "fixture", "verification_receipt"],
      continuationPolicy: "compatible_runner",
      recoveryPolicy: "resume_checkpoint",
    }),
    compileExecutionRecipe({
      recipeId: "operational-document-refresh",
      version: "1.0.0",
      outcomeClass: "documentation_refresh",
      description: "Refresh one operational document from exact accepted repository facts.",
      parameterSchema: [
        stringParameter("documentPath"),
        stringParameter("factCheckpoint"),
      ],
      acceptedProjectProfiles: ["documentation"],
      requiredCapabilities: ["repository.read", "branch.candidate_write"],
      requiredInputs: ["documentPath", "factCheckpoint"],
      orderedPhases: [
        phase("inventory", "Inventory accepted facts", "inspect", ["repository.read"], [], true),
        phase("refresh", "Refresh the bounded document", "implement", ["branch.candidate_write"], [], true),
        phase("verify", "Check factual and repository consistency", "verify", [], ["documentation-tests"], true),
        phase("review", "Publish factual review candidate", "review", [], ["documentation-tests"], false),
      ],
      checks: ["documentation-tests"],
      checkpointPolicy: "phase",
      stopConditions: ["source_fact_unavailable", "current_main_changed"],
      approvalPredicates: ["publication_requires_factual_review"],
      budgetEnvelope: { maxWallMinutes: 60, maxSteps: 16, maxCostMicros: 0 },
      allowedArtifacts: ["branch", "draft_pull_request", "documentation"],
      continuationPolicy: "same_recipe_revision",
      recoveryPolicy: "restart_phase",
    }),
  ]);
}

function admitRecipe(value: unknown): ExecutionRecipe {
  requirePlainObject(
    value,
    [
      "recipeId",
      "version",
      "outcomeClass",
      "description",
      "parameterSchema",
      "acceptedProjectProfiles",
      "requiredCapabilities",
      "requiredInputs",
      "orderedPhases",
      "checks",
      "checkpointPolicy",
      "stopConditions",
      "approvalPredicates",
      "budgetEnvelope",
      "allowedArtifacts",
      "continuationPolicy",
      "recoveryPolicy",
    ],
    "Execution recipe",
  );
  const parameters = admitParameterSchema(dataValue(value, "parameterSchema"));
  const requiredInputs = identityArray(
    dataValue(value, "requiredInputs"),
    32,
    "Execution recipe required inputs",
    false,
  );
  const requiredParameterNames = parameters
    .filter((parameter) => parameter.required)
    .map((parameter) => parameter.name)
    .sort(compareCodeUnits);
  if (stableJson(requiredInputs) !== stableJson(requiredParameterNames)) {
    throw new RangeError(
      "Execution recipe required inputs must equal required parameters",
    );
  }
  const capabilities = identityArray(
    dataValue(value, "requiredCapabilities"),
    64,
    "Execution recipe capabilities",
    false,
  );
  const checks = identityArray(
    dataValue(value, "checks"),
    64,
    "Execution recipe checks",
    false,
  );
  return {
    recipeId: lowercaseSlug(dataValue(value, "recipeId"), "Execution recipe ID"),
    version: exactVersion(dataValue(value, "version")),
    outcomeClass: lowercaseSlug(
      dataValue(value, "outcomeClass"),
      "Execution recipe outcome class",
    ),
    description: boundedText(
      dataValue(value, "description"),
      1,
      500,
      "Execution recipe description",
    ),
    parameterSchema: parameters,
    acceptedProjectProfiles: identityArray(
      dataValue(value, "acceptedProjectProfiles"),
      32,
      "Execution recipe project profiles",
      true,
    ),
    requiredCapabilities: capabilities,
    requiredInputs,
    orderedPhases: admitPhases(
      dataValue(value, "orderedPhases"),
      capabilities,
      checks,
    ),
    checks,
    checkpointPolicy: enumValue(
      dataValue(value, "checkpointPolicy"),
      checkpointPolicySet,
      "Execution recipe checkpoint policy",
    ),
    stopConditions: identityArray(
      dataValue(value, "stopConditions"),
      64,
      "Execution recipe stop conditions",
      true,
    ),
    approvalPredicates: identityArray(
      dataValue(value, "approvalPredicates"),
      64,
      "Execution recipe approval predicates",
      false,
    ),
    budgetEnvelope: admitBudget(dataValue(value, "budgetEnvelope")),
    allowedArtifacts: identityArray(
      dataValue(value, "allowedArtifacts"),
      64,
      "Execution recipe allowed artifacts",
      false,
    ),
    continuationPolicy: enumValue(
      dataValue(value, "continuationPolicy"),
      continuationPolicySet,
      "Execution recipe continuation policy",
    ),
    recoveryPolicy: enumValue(
      dataValue(value, "recoveryPolicy"),
      recoveryPolicySet,
      "Execution recipe recovery policy",
    ),
  };
}

function admitParameterSchema(value: unknown): ExecutionRecipeParameter[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Execution recipe parameter schema must be an array");
  }
  const entries = denseDataArray(
    value,
    32,
    "Execution recipe parameter schema",
  ).map((entry, index) => admitParameter(entry, index));
  entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  requireUnique(
    entries.map((entry) => entry.name),
    "Execution recipe parameter names",
  );
  return entries;
}

function admitParameter(value: unknown, index: number): ExecutionRecipeParameter {
  const label = `Execution recipe parameter ${index + 1}`;
  requirePlainObject(
    value,
    ["name", "kind", "required", "minimum", "maximum", "allowedValues"],
    label,
  );
  const kind = enumValue(
    dataValue(value, "kind"),
    parameterKindSet,
    `${label} kind`,
  );
  const minimum = nullableInteger(dataValue(value, "minimum"), `${label} minimum`);
  const maximum = nullableInteger(dataValue(value, "maximum"), `${label} maximum`);
  if (minimum !== null && maximum !== null && minimum > maximum) {
    throw new RangeError(`${label} bounds are invalid`);
  }
  const allowedValues = textArray(
    dataValue(value, "allowedValues"),
    32,
    120,
    `${label} allowed values`,
  );
  if (kind === "string") {
    if (
      (minimum !== null && (minimum < 0 || minimum > 500))
      || (maximum !== null && (maximum < 0 || maximum > 500))
    ) {
      throw new RangeError(`${label} string bounds are invalid`);
    }
  } else if (allowedValues.length > 0) {
    throw new RangeError(`${label} allowed values require string kind`);
  }
  if (kind === "boolean" && (minimum !== null || maximum !== null)) {
    throw new RangeError(`${label} boolean kind cannot have numeric bounds`);
  }
  const required = dataValue(value, "required");
  if (typeof required !== "boolean") {
    throw new TypeError(`${label} required flag must be boolean`);
  }
  return {
    name: parameterName(dataValue(value, "name"), `${label} name`),
    kind,
    required,
    minimum,
    maximum,
    allowedValues,
  };
}

function admitPhases(
  value: unknown,
  capabilities: readonly string[],
  checks: readonly string[],
): ExecutionRecipePhase[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Execution recipe phases must be an array");
  }
  const phases = denseDataArray(value, 32, "Execution recipe phases")
    .map((entry, index) => admitPhase(entry, index, capabilities, checks));
  if (phases.length === 0) {
    throw new RangeError("Execution recipe requires at least one phase");
  }
  requireUnique(phases.map((phase) => phase.id), "Execution recipe phase IDs");
  return phases;
}

function admitPhase(
  value: unknown,
  index: number,
  capabilities: readonly string[],
  checks: readonly string[],
): ExecutionRecipePhase {
  const label = `Execution recipe phase ${index + 1}`;
  requirePlainObject(
    value,
    ["id", "title", "kind", "requiredCapabilities", "requiredChecks", "checkpoint"],
    label,
  );
  const requiredCapabilities = identityArray(
    dataValue(value, "requiredCapabilities"),
    32,
    `${label} capabilities`,
    false,
  );
  const requiredChecks = identityArray(
    dataValue(value, "requiredChecks"),
    32,
    `${label} checks`,
    false,
  );
  for (const capability of requiredCapabilities) {
    if (!capabilities.includes(capability)) {
      throw new RangeError(`${label} references an undeclared capability`);
    }
  }
  for (const check of requiredChecks) {
    if (!checks.includes(check)) {
      throw new RangeError(`${label} references an undeclared check`);
    }
  }
  const checkpoint = dataValue(value, "checkpoint");
  if (typeof checkpoint !== "boolean") {
    throw new TypeError(`${label} checkpoint flag must be boolean`);
  }
  return {
    id: lowercaseSlug(dataValue(value, "id"), `${label} ID`),
    title: boundedText(dataValue(value, "title"), 1, 160, `${label} title`),
    kind: enumValue(dataValue(value, "kind"), phaseKindSet, `${label} kind`),
    requiredCapabilities,
    requiredChecks,
    checkpoint,
  };
}

function admitBudget(value: unknown): ExecutionRecipeBudgetEnvelope {
  requirePlainObject(
    value,
    ["maxWallMinutes", "maxSteps", "maxCostMicros"],
    "Execution recipe budget",
  );
  return {
    maxWallMinutes: boundedInteger(
      dataValue(value, "maxWallMinutes"),
      1,
      10_080,
      "Execution recipe wall-minute budget",
    ),
    maxSteps: boundedInteger(
      dataValue(value, "maxSteps"),
      1,
      100_000,
      "Execution recipe step budget",
    ),
    maxCostMicros: boundedInteger(
      dataValue(value, "maxCostMicros"),
      0,
      1_000_000_000,
      "Execution recipe cost budget",
    ),
  };
}

function admitParameters(
  value: unknown,
  schema: readonly ExecutionRecipeParameter[],
): Record<string, string | number | boolean> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Execution recipe parameters must be a plain object");
  }
  const expected = schema.map((parameter) => parameter.name);
  requirePlainObject(value, expected, "Execution recipe parameters");
  const result: Record<string, string | number | boolean> = {};
  for (const parameter of schema) {
    const raw = dataValue(value, parameter.name);
    if (raw === null && !parameter.required) continue;
    if (parameter.kind === "string") {
      const admitted = boundedText(
        raw,
        parameter.minimum ?? 1,
        parameter.maximum ?? 500,
        `Execution recipe parameter ${parameter.name}`,
      );
      if (
        parameter.allowedValues.length > 0
        && !parameter.allowedValues.includes(admitted)
      ) {
        throw new RangeError(
          `Execution recipe parameter ${parameter.name} is outside its allowed values`,
        );
      }
      result[parameter.name] = admitted;
      continue;
    }
    if (parameter.kind === "integer") {
      result[parameter.name] = boundedInteger(
        raw,
        parameter.minimum ?? Number.MIN_SAFE_INTEGER,
        parameter.maximum ?? Number.MAX_SAFE_INTEGER,
        `Execution recipe parameter ${parameter.name}`,
      );
      continue;
    }
    if (typeof raw !== "boolean") {
      throw new TypeError(`Execution recipe parameter ${parameter.name} must be boolean`);
    }
    result[parameter.name] = raw;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}

function comparePhases(
  current: Readonly<ExecutionRecipe>,
  candidate: Readonly<ExecutionRecipe>,
  widened: string[],
  narrowed: string[],
  incompatible: string[],
): void {
  const currentIds = current.orderedPhases.map((phase) => phase.id);
  const candidateIds = candidate.orderedPhases.map((phase) => phase.id);
  if (stableJson(currentIds) !== stableJson(candidateIds)) {
    incompatible.push("phase_sequence_changed");
    return;
  }
  for (let index = 0; index < current.orderedPhases.length; index += 1) {
    const before = current.orderedPhases[index]!;
    const after = candidate.orderedPhases[index]!;
    if (before.kind !== after.kind) incompatible.push(`phase_kind_changed:${before.id}`);
    compareSet(
      `phase_capability:${before.id}`,
      before.requiredCapabilities,
      after.requiredCapabilities,
      widened,
      narrowed,
    );
    compareSet(
      `phase_check:${before.id}`,
      before.requiredChecks,
      after.requiredChecks,
      narrowed,
      widened,
    );
    if (before.checkpoint && !after.checkpoint) widened.push(`phase_checkpoint_removed:${before.id}`);
    if (!before.checkpoint && after.checkpoint) narrowed.push(`phase_checkpoint_added:${before.id}`);
  }
}

function compareSet(
  label: string,
  current: readonly string[],
  candidate: readonly string[],
  addedTarget: string[],
  removedTarget: string[],
): void {
  const before = new Set(current);
  const after = new Set(candidate);
  for (const value of after) {
    if (!before.has(value)) addedTarget.push(`${label}_added:${value}`);
  }
  for (const value of before) {
    if (!after.has(value)) removedTarget.push(`${label}_removed:${value}`);
  }
}

function compareBudget(
  current: Readonly<ExecutionRecipeBudgetEnvelope>,
  candidate: Readonly<ExecutionRecipeBudgetEnvelope>,
  widened: string[],
  narrowed: string[],
): void {
  compareNumber("wall_minutes", current.maxWallMinutes, candidate.maxWallMinutes, widened, narrowed);
  compareNumber("steps", current.maxSteps, candidate.maxSteps, widened, narrowed);
  compareNumber("cost_micros", current.maxCostMicros, candidate.maxCostMicros, widened, narrowed);
}

function compareNumber(
  label: string,
  current: number,
  candidate: number,
  widened: string[],
  narrowed: string[],
): void {
  if (candidate > current) widened.push(`budget_increased:${label}`);
  if (candidate < current) narrowed.push(`budget_decreased:${label}`);
}

function compareCheckpointPolicy(
  current: ExecutionRecipeCheckpointPolicy,
  candidate: ExecutionRecipeCheckpointPolicy,
  widened: string[],
  narrowed: string[],
): void {
  const rank: Record<ExecutionRecipeCheckpointPolicy, number> = {
    none: 0,
    manual: 1,
    phase: 2,
  };
  if (rank[candidate] < rank[current]) widened.push("checkpoint_policy_reduced");
  if (rank[candidate] > rank[current]) narrowed.push("checkpoint_policy_increased");
}

function classifyComparison(
  currentFingerprint: string,
  candidateFingerprint: string,
  widened: readonly string[],
  narrowed: readonly string[],
  incompatible: readonly string[],
): ExecutionRecipeComparisonClass {
  if (currentFingerprint === candidateFingerprint) return "identical";
  if (incompatible.length > 0) return "incompatible";
  if (widened.length > 0 && narrowed.length > 0) return "mixed";
  if (widened.length > 0) return "widened";
  if (narrowed.length > 0) return "narrowed";
  return "compatible";
}

function identityArray(
  value: unknown,
  maximum: number,
  label: string,
  requireNonempty: boolean,
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const entries = denseDataArray(value, maximum, label).map((entry, index) =>
    boundedIdentity(entry, `${label} entry ${index + 1}`));
  entries.sort(compareCodeUnits);
  requireUnique(entries, label);
  if (requireNonempty && entries.length === 0) {
    throw new RangeError(`${label} must not be empty`);
  }
  return entries;
}

function textArray(
  value: unknown,
  maximum: number,
  maximumTextLength: number,
  label: string,
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const entries = denseDataArray(value, maximum, label).map((entry, index) =>
    boundedText(entry, 1, maximumTextLength, `${label} entry ${index + 1}`));
  entries.sort(compareCodeUnits);
  requireUnique(entries, label);
  return entries;
}

function stringParameter(name: string): ExecutionRecipeParameter {
  return {
    name,
    kind: "string",
    required: true,
    minimum: 1,
    maximum: 240,
    allowedValues: [],
  };
}

function phase(
  id: string,
  title: string,
  kind: ExecutionRecipePhaseKind,
  requiredCapabilities: string[],
  requiredChecks: string[],
  checkpoint: boolean,
): ExecutionRecipePhase {
  return { id, title, kind, requiredCapabilities, requiredChecks, checkpoint };
}

function parameterName(value: unknown, label: string): string {
  if (typeof value !== "string" || !parameterNamePattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function exactVersion(value: unknown): string {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new TypeError("Execution recipe version must be exact semantic version text");
  }
  const segments = value.split(".").map(Number);
  if (
    segments.some((segment) =>
      !Number.isSafeInteger(segment)
      || segment < 0
      || segment > maximumVersionSegment)
  ) {
    throw new RangeError("Execution recipe version segments are out of range");
  }
  return value;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function exactRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || !revisionPattern.test(value)) {
    throw new TypeError(`${label} must be a lowercase Git object ID`);
  }
  return value;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  return boundedInteger(
    value,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    label,
  );
}

function dataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError("Execution recipe inspection failed");
  }
  return descriptor.value;
}

function detachInputGraph(value: unknown): unknown {
  const seen = new Map<object, unknown>();
  let inspected = 0;
  const detach = (current: unknown): unknown => {
    if (current === null || typeof current !== "object") return current;
    const prior = seen.get(current);
    if (prior !== undefined) return prior;
    inspected += 1;
    if (inspected > maximumInputObjects) {
      throw new TypeError("Execution recipe input inspection exceeded its limit");
    }
    const { prototype, keys } = inspectObject(current);
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) throw inspectionError();
      const length = arrayLength(current);
      if (length > maximumArrayLength) {
        throw new TypeError("Execution recipe input inspection exceeded its limit");
      }
      const allowed = new Set<PropertyKey>(["length"]);
      for (let index = 0; index < length; index += 1) allowed.add(String(index));
      if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
        throw inspectionError();
      }
      const result = new Array<unknown>(length);
      seen.set(current, result);
      for (let index = 0; index < length; index += 1) {
        result[index] = detach(descriptorValue(current, String(index)));
      }
      return result;
    }
    if (prototype !== Object.prototype) throw inspectionError();
    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const key of keys) {
      if (typeof key !== "string") throw inspectionError();
      Object.defineProperty(result, key, {
        value: detach(descriptorValue(current, key)),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };
  return detach(value);
}

function inspectObject(value: object): {
  prototype: object | null;
  keys: readonly PropertyKey[];
} {
  try {
    return {
      prototype: Object.getPrototypeOf(value) as object | null,
      keys: Reflect.ownKeys(value),
    };
  } catch {
    throw inspectionError();
  }
}

function arrayLength(value: unknown[]): number {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable
      || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0
    ) throw inspectionError();
    return descriptor.value as number;
  } catch (error) {
    if (isInspectionError(error)) throw error;
    throw inspectionError();
  }
}

function descriptorValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw inspectionError();
    }
    return descriptor.value;
  } catch (error) {
    if (isInspectionError(error)) throw error;
    throw inspectionError();
  }
}

function inspectionError(): TypeError {
  return new TypeError("Execution recipe input inspection failed");
}

function isInspectionError(error: unknown): error is TypeError {
  return error instanceof TypeError
    && error.message === "Execution recipe input inspection failed";
}

function assertRetainedCredentialFree(value: unknown, label: string): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let inspected = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (containsRealisticRetainedCredential(current)) {
        throw new TypeError(`${label} contains credential-shaped text`);
      }
      continue;
    }
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    inspected += 1;
    if (inspected > maximumInputObjects) {
      throw new TypeError(`${label} inspection exceeded its limit`);
    }
    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry);
      continue;
    }
    for (const entry of Object.values(current as Record<string, unknown>)) {
      pending.push(entry);
    }
  }
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeDeep(nested);
    }
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
