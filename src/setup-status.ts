export const setupSteps = [
  "deployment",
  "backend",
  "account",
  "workspace",
  "project",
  "oauth_discovery",
  "mcp_connection",
  "first_read",
  "repository",
  "proofwake",
] as const;

export type SetupStep = typeof setupSteps[number];
export type SetupStepState = "missing" | "ready" | "degraded" | "deferred";
export type SetupDeploymentMode = "local" | "hosted_preview" | "production";
export type SetupOverallState =
  | "not_configured"
  | "partially_configured"
  | "ready"
  | "degraded";

export type SetupStepStates = Record<SetupStep, SetupStepState>;

export interface SetupStatusInput {
  mode: SetupDeploymentMode;
  observedAt: string;
  serviceOrigin: string;
  mcpEndpoint: string;
  steps: SetupStepStates;
  lastVerifiedStep?: SetupStep | null;
}

export interface SetupStepProjection {
  step: SetupStep;
  state: SetupStepState;
  required: boolean;
}

export interface SetupStatusProjection {
  version: 1;
  mode: SetupDeploymentMode;
  state: SetupOverallState;
  observedAt: string;
  serviceOrigin: string;
  mcpEndpoint: string;
  lastVerifiedStep: SetupStep | null;
  nextStep: SetupStep | null;
  requiredReady: number;
  requiredTotal: number;
  degradedSteps: SetupStep[];
  optionalAttentionSteps: SetupStep[];
  steps: SetupStepProjection[];
  containsSecrets: false;
}

const requiredByMode: Readonly<Record<SetupDeploymentMode, readonly SetupStep[]>> = {
  local: [
    "deployment",
    "backend",
    "workspace",
    "project",
    "mcp_connection",
    "first_read",
  ],
  hosted_preview: [
    "deployment",
    "backend",
    "account",
    "workspace",
    "project",
    "oauth_discovery",
    "mcp_connection",
    "first_read",
  ],
  production: [
    "deployment",
    "backend",
    "account",
    "workspace",
    "project",
    "oauth_discovery",
    "mcp_connection",
    "first_read",
  ],
};

const validStates = new Set<SetupStepState>([
  "missing",
  "ready",
  "degraded",
  "deferred",
]);
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Projects content-minimised onboarding readiness from already observed setup facts.
 *
 * This function accepts no credentials, tokens, provider payloads, arbitrary error
 * text, or browser/session state. Callers retain authority over all mutations.
 */
export function projectSetupStatus(input: SetupStatusInput): SetupStatusProjection {
  const mode = assertMode(input.mode);
  const observedAt = canonicalTimestamp(input.observedAt);
  const serviceOrigin = normalizeServiceOrigin(input.serviceOrigin, mode);
  const mcpEndpoint = normalizeMcpEndpoint(input.mcpEndpoint, serviceOrigin);
  const stepStates = validateStepStates(input.steps);
  const required = new Set(requiredByMode[mode]);

  for (const step of required) {
    if (stepStates[step] === "deferred") {
      throw new RangeError(`Required setup step ${step} cannot be deferred`);
    }
  }

  const lastVerifiedStep = input.lastVerifiedStep ?? null;
  if (lastVerifiedStep !== null) {
    assertStep(lastVerifiedStep);
    if (stepStates[lastVerifiedStep] !== "ready") {
      throw new RangeError("Last verified setup step must currently be ready");
    }
  }

  const steps = setupSteps.map((step): SetupStepProjection => ({
    step,
    state: stepStates[step],
    required: required.has(step),
  }));
  const requiredSteps = steps.filter((entry) => entry.required);
  const requiredReady = requiredSteps.filter((entry) => entry.state === "ready").length;
  const degradedSteps = steps
    .filter((entry) => entry.state === "degraded")
    .map((entry) => entry.step);
  const requiredDegraded = requiredSteps.some((entry) => entry.state === "degraded");
  const state: SetupOverallState = requiredDegraded
    ? "degraded"
    : requiredReady === requiredSteps.length
      ? "ready"
      : requiredReady === 0
        ? "not_configured"
        : "partially_configured";
  const nextStep = requiredSteps.find((entry) => entry.state !== "ready")?.step ?? null;
  const optionalAttentionSteps = steps
    .filter((entry) => !entry.required && entry.state === "degraded")
    .map((entry) => entry.step);

  return {
    version: 1,
    mode,
    state,
    observedAt,
    serviceOrigin,
    mcpEndpoint,
    lastVerifiedStep,
    nextStep,
    requiredReady,
    requiredTotal: requiredSteps.length,
    degradedSteps,
    optionalAttentionSteps,
    steps,
    containsSecrets: false,
  };
}

function validateStepStates(value: SetupStepStates): SetupStepStates {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Setup step states must be an object");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== setupSteps.length
    || keys.some((key) => !setupSteps.includes(key as SetupStep))
  ) {
    throw new RangeError("Setup step states must contain exactly the supported steps");
  }
  const result = {} as SetupStepStates;
  for (const step of setupSteps) {
    const state = value[step];
    if (!validStates.has(state)) {
      throw new RangeError(`Setup step ${step} has an invalid state`);
    }
    result[step] = state;
  }
  return result;
}

function assertMode(value: string): SetupDeploymentMode {
  if (value === "local" || value === "hosted_preview" || value === "production") {
    return value;
  }
  throw new RangeError("Setup deployment mode is invalid");
}

function assertStep(value: string): asserts value is SetupStep {
  if (!setupSteps.includes(value as SetupStep)) {
    throw new RangeError("Setup step is invalid");
  }
}

function canonicalTimestamp(value: string): string {
  if (typeof value !== "string" || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RangeError("Setup observation time is invalid");
  }
  const normalized = value.trim();
  if (!timestampPattern.test(normalized)) {
    throw new RangeError("Setup observation time must be an ISO-8601 UTC timestamp");
  }
  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis)) {
    throw new RangeError("Setup observation time must be an ISO-8601 UTC timestamp");
  }
  const canonical = new Date(millis).toISOString();
  const comparableInput = normalized.includes(".")
    ? normalized
    : normalized.replace(/Z$/, ".000Z");
  if (canonical !== comparableInput) {
    throw new RangeError("Setup observation time must be a valid calendar timestamp");
  }
  return canonical;
}

function normalizeServiceOrigin(value: string, mode: SetupDeploymentMode): string {
  const parsed = parseUrl(value, "Setup service origin");
  if (
    parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw new RangeError("Setup service origin must be an origin without credentials or extra URL data");
  }
  if (mode !== "local" && parsed.protocol !== "https:") {
    throw new RangeError("Hosted setup service origin must use HTTPS");
  }
  if (mode === "local" && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError("Local setup service origin must use HTTP or HTTPS");
  }
  return parsed.origin;
}

function normalizeMcpEndpoint(value: string, serviceOrigin: string): string {
  const parsed = parseUrl(value, "Setup MCP endpoint");
  if (
    parsed.origin !== serviceOrigin
    || parsed.pathname !== "/mcp"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw new RangeError("Setup MCP endpoint must be the service origin plus /mcp");
  }
  return parsed.toString();
}

function parseUrl(value: string, label: string): URL {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  try {
    return new URL(value.trim());
  } catch {
    throw new RangeError(`${label} is invalid`);
  }
}
