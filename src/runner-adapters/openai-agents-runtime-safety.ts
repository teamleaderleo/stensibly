import {
  Agent,
  type FunctionTool,
} from "@openai/agents-core";
import { sha256, stableJson } from "../canonical-json.js";

const executableToolIds = new WeakMap<object, string>();

const limits = {
  agents: 32,
  toolsPerAgent: 128,
  handoffsPerAgent: 32,
  identifier: 160,
  functionSource: 100_000,
} as const;

export interface OpenAIAgentsRuntimeToolManifestV1 {
  readonly qualifiedName: string;
  readonly executableId: string;
  readonly descriptionDigest: string;
  readonly parametersDigest: string;
  readonly strict: boolean;
  readonly deferLoading: boolean;
  readonly invokeDigest: string;
  readonly approvalDigest: string;
  readonly enabledDigest: string;
}

export interface OpenAIAgentsRuntimeAgentManifestV1 {
  readonly name: string;
  readonly instructionsDigest: string;
  readonly toolUseBehaviorDigest: string;
  readonly tools: readonly OpenAIAgentsRuntimeToolManifestV1[];
  readonly handoffAgentNames: readonly string[];
}

export interface OpenAIAgentsRuntimeManifestV1 {
  readonly version: 1;
  readonly rootAgentName: string;
  readonly agents: readonly OpenAIAgentsRuntimeAgentManifestV1[];
  readonly fingerprint: string;
}

/**
 * Bind one stable private executable identity to an actual SDK function-tool object.
 * Exact replay is allowed; changing the identity on the same object fails closed.
 */
export function bindOpenAIAgentsExecutableToolV1<
  T extends FunctionTool<any, any, any>,
>(tool: T, executableIdValue: string): T {
  if (!isRecord(tool) || tool.type !== "function") {
    throw new RangeError(
      "OpenAI Agents executable identity requires a function tool",
    );
  }
  const executableId = boundedIdentifier(
    executableIdValue,
    "OpenAI Agents executable tool ID",
  );
  const existing = executableToolIds.get(tool);
  if (existing !== undefined && existing !== executableId) {
    throw new RangeError(
      "OpenAI Agents function tool is already bound to a different executable ID",
    );
  }
  executableToolIds.set(tool, executableId);
  return tool;
}

/**
 * Build a bounded content-minimised identity from the actual SDK Agent graph.
 * Only the first-slice direct Agent handoff form and function tools are accepted.
 */
export function buildOpenAIAgentsRuntimeManifestV1(
  rootAgent: Agent<any, any>,
): OpenAIAgentsRuntimeManifestV1 {
  if (!(rootAgent instanceof Agent)) {
    throw new RangeError("OpenAI Agents runtime root must be an SDK Agent");
  }

  const queue: Agent<any, any>[] = [rootAgent];
  const seenObjects = new WeakSet<object>();
  const seenNames = new Set<string>();
  const qualifiedToolKeys = new Set<string>();
  const seenExecutableIds = new Set<string>();
  const agents: OpenAIAgentsRuntimeAgentManifestV1[] = [];

  while (queue.length > 0) {
    if (agents.length >= limits.agents) {
      throw new RangeError(
        `OpenAI Agents runtime graph exceeds ${limits.agents} agents`,
      );
    }
    const agent = queue.shift()!;
    if (seenObjects.has(agent)) continue;
    seenObjects.add(agent);

    const name = boundedIdentifier(agent.name, "OpenAI Agents runtime agent name");
    if (seenNames.has(name)) {
      throw new RangeError(
        `OpenAI Agents runtime graph duplicates agent identity ${name}`,
      );
    }
    seenNames.add(name);

    if (!Array.isArray(agent.tools) || agent.tools.length > limits.toolsPerAgent) {
      throw new RangeError(
        `OpenAI Agents runtime agent ${name} has an invalid tool inventory`,
      );
    }
    const tools = agent.tools.map((tool, index) => {
      if (!isRecord(tool) || tool.type !== "function") {
        throw new RangeError(
          `OpenAI Agents runtime agent ${name} tool ${index + 1} is unsupported`,
        );
      }
      const functionTool = tool as FunctionTool<any, any, any>;
      const toolName = boundedIdentifier(
        functionTool.name,
        `OpenAI Agents runtime agent ${name} tool name`,
      );
      const qualifiedName = `${name}::${toolName}`;
      const qualifiedKey = stableJson([name, toolName]);
      if (qualifiedToolKeys.has(qualifiedKey)) {
        throw new RangeError(
          `OpenAI Agents runtime graph duplicates qualified tool identity ${qualifiedName}`,
        );
      }
      qualifiedToolKeys.add(qualifiedKey);

      const executableId = executableToolIds.get(functionTool);
      if (executableId === undefined) {
        throw new RangeError(
          `OpenAI Agents runtime tool ${qualifiedName} lacks an executable identity`,
        );
      }
      if (seenExecutableIds.has(executableId)) {
        throw new RangeError(
          `OpenAI Agents runtime graph duplicates executable tool identity ${executableId}`,
        );
      }
      seenExecutableIds.add(executableId);

      return {
        qualifiedName,
        executableId,
        descriptionDigest: digestText(
          functionTool.description,
          `OpenAI Agents runtime tool ${qualifiedName} description`,
        ),
        parametersDigest: digestCanonical(
          functionTool.parameters,
          `OpenAI Agents runtime tool ${qualifiedName} parameters`,
        ),
        strict: functionTool.strict === true,
        deferLoading: functionTool.deferLoading === true,
        invokeDigest: digestFunction(
          functionTool.invoke,
          `OpenAI Agents runtime tool ${qualifiedName} invocation`,
        ),
        approvalDigest: digestFunction(
          functionTool.needsApproval,
          `OpenAI Agents runtime tool ${qualifiedName} approval`,
        ),
        enabledDigest: digestFunction(
          functionTool.isEnabled,
          `OpenAI Agents runtime tool ${qualifiedName} enablement`,
        ),
      } satisfies OpenAIAgentsRuntimeToolManifestV1;
    }).sort((left, right) => compareText(left.qualifiedName, right.qualifiedName));

    if (
      !Array.isArray(agent.handoffs)
      || agent.handoffs.length > limits.handoffsPerAgent
    ) {
      throw new RangeError(
        `OpenAI Agents runtime agent ${name} has an invalid handoff inventory`,
      );
    }
    const handoffNames = new Set<string>();
    const handoffAgentNames = agent.handoffs.map((handoff, index) => {
      if (!(handoff instanceof Agent)) {
        throw new RangeError(
          `OpenAI Agents runtime agent ${name} handoff ${index + 1} is unsupported`,
        );
      }
      const handoffName = boundedIdentifier(
        handoff.name,
        `OpenAI Agents runtime agent ${name} handoff name`,
      );
      if (handoffNames.has(handoffName)) {
        throw new RangeError(
          `OpenAI Agents runtime agent ${name} duplicates handoff identity ${handoffName}`,
        );
      }
      handoffNames.add(handoffName);
      queue.push(handoff);
      return handoffName;
    }).sort(compareText);

    agents.push({
      name,
      instructionsDigest: digestInstruction(agent.instructions, name),
      toolUseBehaviorDigest: digestToolUseBehavior(agent.toolUseBehavior, name),
      tools,
      handoffAgentNames,
    });
  }

  agents.sort((left, right) => compareText(left.name, right.name));
  const body = {
    version: 1 as const,
    rootAgentName: boundedIdentifier(
      rootAgent.name,
      "OpenAI Agents runtime root agent name",
    ),
    agents,
  };
  return deepFreeze({
    ...body,
    fingerprint: sha256(stableJson(body)),
  });
}

export function requireOpenAIAgentsRuntimeManifestV1(
  expected: OpenAIAgentsRuntimeManifestV1,
  current: OpenAIAgentsRuntimeManifestV1,
): OpenAIAgentsRuntimeManifestV1 {
  if (
    expected.version !== 1
    || current.version !== 1
    || expected.fingerprint !== sha256(stableJson({
      version: expected.version,
      rootAgentName: expected.rootAgentName,
      agents: expected.agents,
    }))
    || current.fingerprint !== sha256(stableJson({
      version: current.version,
      rootAgentName: current.rootAgentName,
      agents: current.agents,
    }))
    || expected.fingerprint !== current.fingerprint
  ) {
    throw new RangeError("OpenAI Agents runtime graph identity is stale");
  }
  return current;
}

/**
 * Admit one adapter-owned observation timestamp without exposing clock failures.
 */
export function openAIAgentsObservationTimeV1(
  now: () => Date,
  issuedAt: string,
  ordinal: number,
): string {
  let current: Date;
  try {
    current = now();
  } catch {
    throw new RangeError("OpenAI Agents adapter clock is invalid");
  }
  const currentTime = current instanceof Date ? current.getTime() : Number.NaN;
  const issuedTime = Date.parse(issuedAt);
  if (
    !Number.isFinite(currentTime)
    || !Number.isFinite(issuedTime)
    || !Number.isSafeInteger(ordinal)
    || ordinal < 0
  ) {
    throw new RangeError("OpenAI Agents adapter clock is invalid");
  }
  const observedTime = Math.max(currentTime, issuedTime) + ordinal;
  if (!Number.isFinite(observedTime)) {
    throw new RangeError("OpenAI Agents adapter clock is invalid");
  }
  try {
    return new Date(observedTime).toISOString();
  } catch {
    throw new RangeError("OpenAI Agents adapter clock is invalid");
  }
}

function digestInstruction(
  value: Agent<any, any>["instructions"],
  agentName: string,
): string {
  if (typeof value !== "string") {
    throw new RangeError(
      `OpenAI Agents runtime agent ${agentName} uses unsupported dynamic instructions`,
    );
  }
  return digestText(
    value,
    `OpenAI Agents runtime agent ${agentName} instructions`,
  );
}

function digestToolUseBehavior(value: unknown, agentName: string): string {
  if (typeof value === "function") {
    throw new RangeError(
      `OpenAI Agents runtime agent ${agentName} uses unsupported dynamic tool-use behavior`,
    );
  }
  return digestCanonical(
    value,
    `OpenAI Agents runtime agent ${agentName} tool-use behavior`,
  );
}

function digestText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > limits.functionSource) {
    throw new RangeError(`${label} is invalid`);
  }
  return sha256(value);
}

function digestFunction(value: unknown, label: string): string {
  if (typeof value !== "function") {
    throw new RangeError(`${label} is invalid`);
  }
  let source: string;
  try {
    source = Function.prototype.toString.call(value);
  } catch {
    throw new RangeError(`${label} is invalid`);
  }
  if (source.length === 0 || source.length > limits.functionSource) {
    throw new RangeError(`${label} is invalid`);
  }
  return sha256(source);
}

function digestCanonical(value: unknown, label: string): string {
  try {
    return sha256(stableJson(value));
  } catch {
    throw new RangeError(`${label} is invalid`);
  }
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > limits.identifier
    || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
