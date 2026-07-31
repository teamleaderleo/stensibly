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

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const exactTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;

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
  readonly handoffDescriptionDigest: string;
  readonly modelSettingsDigest: string;
  readonly toolUseBehaviorDigest: string;
  readonly resetToolChoice: boolean;
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
 * Only the model-free first-slice Agent, handoff, and function-tool surface is admitted.
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
    assertFirstSliceAgentPolicy(agent, name);

    const tools = agent.tools.map((tool, index) => {
      if (!isRecord(tool) || tool.type !== "function") {
        throw new RangeError(
          `OpenAI Agents runtime agent ${name} tool ${index + 1} is unsupported`,
        );
      }
      const functionTool = tool as FunctionTool<any, any, any>;
      assertFirstSliceFunctionToolPolicy(functionTool, name, index);
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
        strict: functionTool.strict,
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
      handoffDescriptionDigest: digestText(
        agent.handoffDescription,
        `OpenAI Agents runtime agent ${name} handoff description`,
      ),
      modelSettingsDigest: digestCanonical(
        agent.modelSettings,
        `OpenAI Agents runtime agent ${name} model settings`,
      ),
      toolUseBehaviorDigest: digestToolUseBehavior(agent.toolUseBehavior, name),
      resetToolChoice: agent.resetToolChoice,
      tools,
      handoffAgentNames,
    });
  }

  agents.sort((left, right) => compareText(left.name, right.name));
  return admitRuntimeManifest({
    version: 1,
    rootAgentName: boundedIdentifier(
      rootAgent.name,
      "OpenAI Agents runtime root agent name",
    ),
    agents,
    fingerprint: sha256(stableJson({
      version: 1,
      rootAgentName: rootAgent.name,
      agents,
    })),
  });
}

/**
 * Re-admit checkpoint-loaded evidence through an exact inert schema before comparison.
 */
export function requireOpenAIAgentsRuntimeManifestV1(
  expectedValue: unknown,
  currentValue: unknown,
): OpenAIAgentsRuntimeManifestV1 {
  const expected = admitRuntimeManifest(expectedValue);
  const current = admitRuntimeManifest(currentValue);
  if (expected.fingerprint !== current.fingerprint) {
    throw new RangeError("OpenAI Agents runtime graph identity is stale");
  }
  return current;
}

/**
 * Admit one adapter-owned observation timestamp without exposing clock failures.
 */
export function openAIAgentsObservationTimeV1(
  now: () => Date,
  issuedAtValue: string,
  ordinal: number,
): string {
  let currentTime: number;
  try {
    const current = now();
    currentTime = Date.prototype.getTime.call(current);
  } catch {
    throw invalidClock();
  }
  const issuedTime = canonicalTimestampMilliseconds(issuedAtValue);
  if (
    !Number.isFinite(currentTime)
    || !Number.isSafeInteger(ordinal)
    || ordinal < 0
  ) {
    throw invalidClock();
  }
  const observedTime = Math.max(currentTime, issuedTime) + ordinal;
  try {
    const observedAt = new Date(observedTime).toISOString();
    if (!exactTimestampPattern.test(observedAt)) throw invalidClock();
    return observedAt;
  } catch {
    throw invalidClock();
  }
}

function assertFirstSliceAgentPolicy(agent: Agent<any, any>, name: string): void {
  if (!Array.isArray(agent.tools) || agent.tools.length > limits.toolsPerAgent) {
    throw new RangeError(
      `OpenAI Agents runtime agent ${name} has an invalid tool inventory`,
    );
  }
  if (!Array.isArray(agent.handoffs) || agent.handoffs.length > limits.handoffsPerAgent) {
    throw new RangeError(
      `OpenAI Agents runtime agent ${name} has an invalid handoff inventory`,
    );
  }
  if (
    agent.prompt !== undefined
    || agent.mcpServers.length !== 0
    || Object.keys(agent.mcpConfig).length !== 0
    || agent.inputGuardrails.length !== 0
    || agent.outputGuardrails.length !== 0
    || agent.outputType !== "text"
    || typeof agent.resetToolChoice !== "boolean"
  ) {
    throw new RangeError(
      `OpenAI Agents runtime agent ${name} uses unsupported first-slice policy`,
    );
  }
}

function assertFirstSliceFunctionToolPolicy(
  tool: FunctionTool<any, any, any>,
  agentName: string,
  index: number,
): void {
  const label = `OpenAI Agents runtime agent ${agentName} tool ${index + 1}`;
  const allowedKeys = new Set([
    "type",
    "name",
    "description",
    "parameters",
    "strict",
    "deferLoading",
    "providerData",
    "invoke",
    "needsApproval",
    "timeoutMs",
    "timeoutBehavior",
    "timeoutErrorFunction",
    "isEnabled",
    "inputGuardrails",
    "outputGuardrails",
    "customDataExtractor",
  ]);
  if (
    Object.getOwnPropertySymbols(tool).length !== 0
    || Object.keys(tool).some((key) => !allowedKeys.has(key))
    || tool.providerData !== undefined
    || "allowedCallers" in tool
    || "outputSchema" in tool
    || "errorFunction" in tool
    || tool.timeoutMs !== undefined
    || tool.timeoutBehavior !== "error_as_result"
    || tool.timeoutErrorFunction !== undefined
    || tool.customDataExtractor !== undefined
    || !Array.isArray(tool.inputGuardrails)
    || tool.inputGuardrails.length !== 0
    || !Array.isArray(tool.outputGuardrails)
    || tool.outputGuardrails.length !== 0
    || typeof tool.strict !== "boolean"
    || typeof tool.deferLoading !== "boolean"
  ) {
    throw new RangeError(`${label} uses unsupported first-slice policy`);
  }
}

function admitRuntimeManifest(value: unknown): OpenAIAgentsRuntimeManifestV1 {
  const input = strictRecord(
    value,
    "OpenAI Agents runtime manifest",
    ["version", "rootAgentName", "agents", "fingerprint"],
  );
  if (input.version !== 1) {
    throw new RangeError("OpenAI Agents runtime manifest version is invalid");
  }
  const rootAgentName = boundedIdentifier(
    input.rootAgentName,
    "OpenAI Agents runtime root agent name",
  );
  const agentValues = strictArray(
    input.agents,
    "OpenAI Agents runtime agents",
    limits.agents,
  );
  const seenNames = new Set<string>();
  const seenExecutableIds = new Set<string>();
  const agents = agentValues.map((entry, index) => {
    const agent = strictRecord(
      entry,
      `OpenAI Agents runtime agent ${index + 1}`,
      [
        "name",
        "instructionsDigest",
        "handoffDescriptionDigest",
        "modelSettingsDigest",
        "toolUseBehaviorDigest",
        "resetToolChoice",
        "tools",
        "handoffAgentNames",
      ],
    );
    const name = boundedIdentifier(
      agent.name,
      `OpenAI Agents runtime agent ${index + 1} name`,
    );
    if (seenNames.has(name)) {
      throw new RangeError(
        `OpenAI Agents runtime graph duplicates agent identity ${name}`,
      );
    }
    seenNames.add(name);
    const toolValues = strictArray(
      agent.tools,
      `OpenAI Agents runtime agent ${name} tools`,
      limits.toolsPerAgent,
    );
    const seenQualifiedNames = new Set<string>();
    const tools = toolValues.map((toolValue, toolIndex) => {
      const tool = strictRecord(
        toolValue,
        `OpenAI Agents runtime agent ${name} tool ${toolIndex + 1}`,
        [
          "qualifiedName",
          "executableId",
          "descriptionDigest",
          "parametersDigest",
          "strict",
          "deferLoading",
          "invokeDigest",
          "approvalDigest",
          "enabledDigest",
        ],
      );
      const qualifiedName = boundedIdentifier(
        tool.qualifiedName,
        `OpenAI Agents runtime agent ${name} qualified tool name`,
      );
      const executableId = boundedIdentifier(
        tool.executableId,
        `OpenAI Agents runtime agent ${name} executable tool ID`,
      );
      if (seenQualifiedNames.has(qualifiedName)) {
        throw new RangeError(
          `OpenAI Agents runtime graph duplicates qualified tool identity ${qualifiedName}`,
        );
      }
      if (seenExecutableIds.has(executableId)) {
        throw new RangeError(
          `OpenAI Agents runtime graph duplicates executable tool identity ${executableId}`,
        );
      }
      seenQualifiedNames.add(qualifiedName);
      seenExecutableIds.add(executableId);
      return {
        qualifiedName,
        executableId,
        descriptionDigest: exactDigest(tool.descriptionDigest, "Description digest"),
        parametersDigest: exactDigest(tool.parametersDigest, "Parameters digest"),
        strict: exactBoolean(tool.strict, "Tool strictness"),
        deferLoading: exactBoolean(tool.deferLoading, "Tool deferred-loading flag"),
        invokeDigest: exactDigest(tool.invokeDigest, "Invocation digest"),
        approvalDigest: exactDigest(tool.approvalDigest, "Approval digest"),
        enabledDigest: exactDigest(tool.enabledDigest, "Enablement digest"),
      };
    });
    const handoffValues = strictArray(
      agent.handoffAgentNames,
      `OpenAI Agents runtime agent ${name} handoffs`,
      limits.handoffsPerAgent,
    );
    const handoffNames = new Set<string>();
    const handoffAgentNames = handoffValues.map((handoff, handoffIndex) => {
      const handoffName = boundedIdentifier(
        handoff,
        `OpenAI Agents runtime agent ${name} handoff ${handoffIndex + 1}`,
      );
      if (handoffNames.has(handoffName)) {
        throw new RangeError(
          `OpenAI Agents runtime agent ${name} duplicates handoff identity ${handoffName}`,
        );
      }
      handoffNames.add(handoffName);
      return handoffName;
    });
    return {
      name,
      instructionsDigest: exactDigest(agent.instructionsDigest, "Instructions digest"),
      handoffDescriptionDigest: exactDigest(
        agent.handoffDescriptionDigest,
        "Handoff-description digest",
      ),
      modelSettingsDigest: exactDigest(agent.modelSettingsDigest, "Model-settings digest"),
      toolUseBehaviorDigest: exactDigest(
        agent.toolUseBehaviorDigest,
        "Tool-use-behavior digest",
      ),
      resetToolChoice: exactBoolean(agent.resetToolChoice, "Reset-tool-choice flag"),
      tools,
      handoffAgentNames,
    };
  });
  const fingerprint = exactDigest(input.fingerprint, "Manifest fingerprint");
  const body = { version: 1 as const, rootAgentName, agents };
  if (fingerprint !== sha256(stableJson(body))) {
    throw new RangeError("OpenAI Agents runtime manifest fingerprint is invalid");
  }
  return deepFreeze({ ...body, fingerprint });
}

function strictRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new RangeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort(compareText);
  const canonicalExpected = [...expectedKeys].sort(compareText);
  if (stableJson(actualKeys) !== stableJson(canonicalExpected)) {
    throw new RangeError(`${label} fields are invalid`);
  }
  const output: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new RangeError(`${label} field ${key} must be an enumerable data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function strictArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RangeError(`${label} must be a bounded array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError(`${label} must use the default array prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["length", ...value.map((_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    throw new RangeError(`${label} contains an unknown field`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new RangeError(`${label} must contain dense enumerable data entries`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function canonicalTimestampMilliseconds(value: unknown): number {
  if (typeof value !== "string" || !exactTimestampPattern.test(value)) {
    throw invalidClock();
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw invalidClock();
  try {
    if (new Date(milliseconds).toISOString() !== value) throw invalidClock();
  } catch {
    throw invalidClock();
  }
  return milliseconds;
}

function invalidClock(): RangeError {
  return new RangeError("OpenAI Agents adapter clock is invalid");
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

function exactDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RangeError(`${label} is invalid`);
  return value;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > limits.identifier
    || value.trim() !== value
    || unsafeTextPattern.test(value)
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
